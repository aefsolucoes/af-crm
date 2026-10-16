import { PrismaClient, EmailMessage, EmailAccount } from '@prisma/client';
import { Readable } from 'stream';
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { CARLITO_REGULAR_BASE64 } from './creditas-scr-font';
import { callableFirstName } from '../lib/text';
import { logActivity } from './activity.service';

/**
 * AUTORIZAÇÃO SCR BACEN DA CREDITAS (Fabio 15/10).
 * Quando a Creditas não aprova o crédito de uma vez, o comercial deles manda um e-mail ("Autorização SCR Não Validada") pedindo a Autorização SCR Bacen assinada pelos
 * participantes + as identidades. O formulário é o MESMO pra todos os clientes. Fluxo:
 *   1) e-mail da Creditas chega → o CRM acha o card pelo CPF que vem no texto, liga o e-mail ao card e avisa a equipe;
 *   2) manda ao cliente (WhatsApp) o formulário e pede pra assinar PELO GOV.BR e devolver o PDF assinado + documento de identidade;
 *   3) o que o cliente devolve é lido pela IA (assinado? de quem? RG/CNH?); com tudo de todos os participantes, responde o MESMO e-mail da Creditas com os anexos.
 * Estado no card: customFields._scrCreditas = { status: PENDING | ASKED | SENT, emailId, emailAccountId, creditasId, at, askedAt?, sentAt?, … }.
 */

const prisma = new PrismaClient();
type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

const CREDITAS_SENDER = /@([a-z0-9-]+\.)*creditas\.(com|com\.br|io)$/i;
const WINDOW_MS = 23 * 3_600_000; // janela de 24 h do WhatsApp, com folga
const QUIET_AFTER_DOC_MS = 10 * 60_000; // Fabio 15/10: espera 10 min o cliente mandar tudo antes de cobrar o que falta/corrigir (tudo completo = envia na hora)

export interface ScrState {
  /** NOTED = e-mail ligado ao card, mas o CRM NÃO pede sozinho ao cliente (card fora da Pré-Análise); a equipe cuida. */
  status: 'PENDING' | 'ASKED' | 'SENDING' | 'SENT' | 'NOTED';
  emailId: string; emailAccountId: string; creditasId?: string; at: string;
  /** Titular da proposta na Creditas (nome e CPF que vêm no e-mail) — a partir dele se descobre quem mais entrou na proposta. */
  holderName?: string; holderCpf?: string;
  askedAt?: string; sentAt?: string; chasedAt?: string; holdSig?: string; windowNoteAt?: string; problemSig?: string; faltaSig?: string;
  /** Última mensagem do cliente (ISO) da janela de 24 h em que o lembrete "antes de fechar" já foi mandado — 1 por janela. */
  windowRemindFor?: string;
}

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
const digits = (s: string) => String(s || '').replace(/\D/g, '');
const stateOf = (cf: unknown): ScrState | null => ((cf as Record<string, any> | null)?._scrCreditas as ScrState) || null;

async function saveState(leadId: string, patch: Partial<ScrState>): Promise<void> {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  cf._scrCreditas = { ...(cf._scrCreditas || {}), ...patch };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}
const addNote = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});

// ─── Ler o e-mail ──────────────────────────────────────────────────────────────

const JONATAS = /^jonatas\.carmona@creditas\.com$/i; // Fabio 16/10: "a gente NUNCA encaminha formulário pro cliente sem o Jonatas pedir antes"

/** Só o texto NOVO do e-mail: corta a citação da mensagem anterior (a nossa própria pergunta ao Jonatas, que cita SCR/Bacen, não pode valer como pedido dele). */
export function textoNovo(text: string): string {
  const linhas = String(text || '').split('\n');
  const corte = linhas.findIndex((l) => /^\s*>/.test(l) || /^\s*(Em .{5,120}escreveu:|On .{5,120}wrote:)\s*$/i.test(l) || /^\s*-{2,}\s*(Mensagem original|Original Message|Forwarded)/i.test(l) || /^\s*(De|From):\s+\S+.*@/i.test(l));
  return (corte >= 0 ? linhas.slice(0, corte) : linhas).join('\n');
}

/** E-mail do JONATAS (Creditas) pedindo a Autorização SCR Bacen? (assunto "Autorização SCR Não Validada" ou o texto novo do corpo fala de SCR + Bacen) */
export function isScrRequest(from: string | null | undefined, subject: string | null | undefined, text: string): boolean {
  if (!from || !JONATAS.test(String(from).trim())) return false;
  const novo = textoNovo(text);
  return /\bSCR\b/i.test(subject || '') || (/\bSCR\b/i.test(novo) && /bacen|banco central/i.test(novo));
}

/** "Nome Completo ID: EGVK889 CPF: 603.920.513-03" — vale também nas citações (> ...) das cobranças "tivemos alguma devolutiva?". Um CPF só uma vez. */
export function parseScrCases(text: string): { name: string; creditasId: string; cpf: string }[] {
  const flat = text.split('\n').map((l) => l.replace(/^[>\s]+/, '')).join('\n');
  const out: { name: string; creditasId: string; cpf: string }[] = [];
  const rx = /([^\n]{3,120}?)\s+ID:\s*([A-Z0-9]{5,10})\s+CPF:\s*(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/gi;
  for (const m of flat.matchAll(rx)) {
    const cpf = digits(m[3]);
    if (cpf.length !== 11 || out.some((o) => o.cpf === cpf)) continue;
    out.push({ name: m[1].replace(/^.*(proposta abaixo|devolutiva)[^\n]*$/i, '').trim() || m[1].trim(), creditasId: m[2].toUpperCase(), cpf });
  }
  return out;
}

async function findLeadByCpf(accountId: string, cpf: string): Promise<{ id: string; name: string; customFields: any } | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false
      AND (regexp_replace(coalesce(l."customFields"->>'cpf_1', ''), '[^0-9]', '', 'g') = ${cpf}
        OR regexp_replace(coalesce(l."customFields"->>'cpf_2', ''), '[^0-9]', '', 'g') = ${cpf})
    ORDER BY l."updatedAt" DESC LIMIT 1`;
  if (!rows[0]) return null;
  return prisma.lead.findUnique({ where: { id: rows[0].id }, select: { id: true, name: true, customFields: true } });
}

/** Clientes que o e-mail da Creditas cita: pelo CPF do texto (pedido de SCR e cobranças, inclusive nas citações) ou, sem CPF, pelo "… - Nome Completo ID: XXXX" do assunto (pré-aprovação). */
function citedClients(subject: string | null, text: string): { name: string; creditasId?: string; cpf?: string }[] {
  const out: { name: string; creditasId?: string; cpf?: string }[] = parseScrCases(text).map((c) => ({ name: c.name, creditasId: c.creditasId, cpf: c.cpf }));
  const m = /[-–]\s*([A-Za-zÀ-ÿ' ]{6,90}?)\s+ID:\s*([A-Z0-9]{5,10})/.exec(subject || '');
  if (m && !out.some((c) => norm(c.name) === norm(m[1]))) out.push({ name: m[1].trim(), creditasId: m[2].toUpperCase() });
  if (!out.length) {
    // Resposta ao NOSSO e-mail ("Re: CPF 000.000.000-00 - NOME - …"): sem o formato da Creditas, vale o CPF que a gente mesmo escreveu no assunto ou na citação.
    for (const fonte of [subject || '', text]) {
      for (const mm of fonte.matchAll(/\b(\d{3}\.\d{3}\.\d{3}-\d{2})\b/g)) {
        const cpf = digits(mm[1]);
        if (cpf.length === 11 && !out.some((c) => c.cpf === cpf)) out.push({ name: '', cpf });
      }
      if (out.length) break;
    }
  }
  return out;
}

/** Card aberto cujo nome (participante 1/2 ou nome do card) é IGUAL ao citado — só vale se for um único. */
async function findLeadByName(accountId: string, name: string): Promise<{ id: string; name: string; customFields: any } | null> {
  const alvo = norm(name);
  if (alvo.split(' ').length < 2) return null;
  const cands = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, isGroup: false, name: { contains: name.trim().split(' ')[0], mode: 'insensitive' } },
    select: { id: true, name: true, customFields: true }, take: 80,
  });
  const iguais = cands.filter((l) => {
    const cf = (l.customFields || {}) as Record<string, any>;
    return [l.name, cf.participante_1, cf.participante_2].some((n) => n && norm(String(n)) === alvo);
  });
  return iguais.length === 1 ? iguais[0] : null;
}

/** 1º pedido de SCR desse cliente: marca como pendente (ou só anota, fora da Pré-Análise) e avisa a equipe. */
async function openScr(acc: EmailAccount, lead: { id: string; name: string; customFields: any }, row: EmailMessage, c: { name: string; creditasId?: string; cpf?: string }): Promise<void> {
  // 1º pedido de SCR desse cliente: marca como pendente e avisa a equipe.
  // Só pede sozinho ao cliente quem está na PRÉ-ANÁLISE (é onde o Creditas pede o SCR); em outra etapa (vistoria, documentação…) a equipe já está tratando — só liga o e-mail e avisa.
  const etapa = await prisma.lead.findUnique({ where: { id: lead.id }, select: { stage: { select: { name: true } } } });
  const naPre = /^pr[eé]-?an/i.test((etapa?.stage?.name || '').normalize('NFD').replace(/[̀-ͯ]/g, ''));
  await saveState(lead.id, { status: naPre ? 'PENDING' : 'NOTED', emailId: row.id, emailAccountId: acc.id, creditasId: c.creditasId, at: row.date.toISOString(), holderName: c.name, holderCpf: c.cpf });
  await addNote(lead.id, `📧 A Creditas pediu a AUTORIZAÇÃO SCR BACEN assinada pelos participantes + as identidades${c.creditasId ? ` (ID ${c.creditasId})` : ''} — e-mail de ${row.date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}. ${naPre ? 'O CRM manda o formulário pro cliente assinar pelo gov.br, confere o que ele devolver e responde a Creditas; enquanto isso a consulta do Creditas fica TRAVADA.' : `O card está em "${etapa?.stage?.name || '?'}" (fora da Pré-Análise): o CRM NÃO pediu ao cliente sozinho — a equipe cuida.`}`);
  pushTeam(acc.accountId, lead.id, lead.name, naPre ? 'A Creditas pediu a Autorização SCR Bacen assinada — o CRM vai pedir ao cliente' : 'A Creditas pediu a Autorização SCR Bacen — cuide à mão (card fora da Pré-Análise)');
  logActivity({ accountId: acc.accountId, userId: null, userName: 'Análise automática', action: 'lead_edited', leadId: lead.id, leadName: lead.name, summary: 'a Creditas pediu a Autorização SCR Bacen assinada' } as any);
}

/** Chamado a cada e-mail novo (e na varredura). Todo e-mail da Creditas que cita um cliente (hoje e os próximos) é LIGADO ao card dele — vai pra conversa; se for pedido de SCR
 *  (ou cobrança dele), dispara também o fluxo do SCR. true = achou card (o e-mail foi tratado). */
export async function handleCreditasScrEmail(acc: EmailAccount, row: EmailMessage, io: Io): Promise<boolean> {
  if (!row.fromAddress || !CREDITAS_SENDER.test(row.fromAddress)) return false;
  const { htmlToText, linkEmailToLead } = require('./email-inbox.service') as typeof import('./email-inbox.service');
  const text = row.textBody || (row.htmlBody ? htmlToText(row.htmlBody) : '');
  const scr = isScrRequest(row.fromAddress, row.subject, text);
  const fresh = Date.now() - row.date.getTime() < 3 * 3_600_000;
  let ligado = false;
  let tratados = 0;
  for (const c of citedClients(row.subject, text)) {
    const lead = c.cpf ? await findLeadByCpf(acc.accountId, c.cpf) : await findLeadByName(acc.accountId, c.name);
    if (!lead) { console.log(`[Creditas e-mail] ${c.cpf ? `CPF ${c.cpf}` : c.name} sem card aberto no CRM — e-mail ${row.id} só fica na caixa`); continue; }
    tratados++;
    if (!ligado) { // um e-mail só tem um card: vale o primeiro cliente achado
      ligado = true;
      try { await linkEmailToLead(acc, row.id, lead.id, io); } catch (e: any) { console.warn('[Creditas e-mail] não liguei o e-mail ao card:', e?.message); }
      if (!scr && fresh) { try { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(acc.accountId, { title: `📧 Creditas — ${lead.name}`, body: row.subject || 'Novo e-mail da Creditas', leadId: lead.id }).catch(() => {}); } catch { /* push é extra */ } }
    }
    if (!scr && JONATAS.test(String(row.fromAddress).trim())) { if (await handleSuporteReply(acc, lead, row, text, io).catch((e: any) => { console.warn('[Creditas e-mail] resposta do Jonatas:', e?.message); return false; })) continue; }
    if (!scr) continue;
    const st = stateOf(lead.customFields);
    if (!st) {
      await openScr(acc, lead, row, c);
    } else {
      // Cobrança ("tivemos alguma devolutiva?") ou novo e-mail do mesmo pedido: guarda o e-mail mais novo (a resposta sai no fio dele) e, se já foi enviado, só registra.
      if (new Date(st.chasedAt || st.at).getTime() < row.date.getTime()) await saveState(lead.id, { emailId: row.id, emailAccountId: acc.id, chasedAt: row.date.toISOString() });
      if (st.status === 'SENT' && (!st.chasedAt || new Date(st.chasedAt).getTime() < row.date.getTime())) await addNote(lead.id, `📧 A Creditas escreveu de novo sobre o SCR (cobrando devolutiva), mas a Autorização já foi enviada em ${st.sentAt ? new Date(st.sentAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '—'}.`);
    }
  }
  return tratados > 0;
}

/** O Jonatas respondeu à NOSSA cobrança de posição (e-mail de 24 h sem retorno) e a resposta NÃO tem o pedido do SCR em formato Creditas (Fabio 16/10): a IA lê o texto novo e decide —
 *  pedido do SCR Bacen → abre o fluxo do SCR (formulário ao cliente); qualquer outra coisa → leva pra equipe no balão "Dúvidas da IA" ("o que devo fazer?") e aprende com a resposta.
 *  true = tratado. 1 vez por e-mail (`_creditasEmailsHandled`). */
export async function classifyJonatasReply(subject: string | null, novo: string): Promise<{ tipo: 'BACEN' | 'OUTRO'; resumo: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fallback = { tipo: 'OUTRO' as const, resumo: novo.replace(/\s+/g, ' ').trim().slice(0, 240) || '(e-mail sem texto)' };
  if (!apiKey) return fallback;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 2500,
        system: `Você lê a resposta do Jonatas (suporte da Creditas) à pergunta da A&F Soluções Financeiras sobre a posição da proposta de um cliente de crédito com garantia de imóvel. Responda SÓ JSON: {"tipo":"BACEN|OUTRO","resumo":"até 200 caracteres: o que ele respondeu"}. BACEN = ele está pedindo a Autorização SCR Bacen (consulta ao Banco Central) preenchida e assinada pelo(s) cliente(s) e/ou as identidades. OUTRO = qualquer outra coisa (proposta em análise, negada, falta documento, política, aprovada, pedido de retorno…).`,
        messages: [{ role: 'user', content: `Assunto: ${subject || ''}\n\nTexto novo do e-mail (sem a citação):\n${novo.slice(0, 3000)}` }],
      }),
    });
    if (!res.ok) return fallback;
    const d: any = await res.json();
    const m = String(d?.content?.find((b: any) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    const j = JSON.parse(m[0]);
    return { tipo: j.tipo === 'BACEN' ? 'BACEN' : 'OUTRO', resumo: String(j.resumo || fallback.resumo).slice(0, 240) };
  } catch { return fallback; }
}

async function handleSuporteReply(acc: EmailAccount, lead: { id: string; name: string; customFields: any }, row: EmailMessage, text: string, io: Io): Promise<boolean> {
  const cf = (lead.customFields || {}) as Record<string, any>;
  const askedAt = cf._creditasSuporteAt ? new Date(cf._creditasSuporteAt).getTime() : 0;
  if (!askedAt || row.date.getTime() <= askedAt) return false; // só resposta DEPOIS do nosso e-mail
  const handled: string[] = Array.isArray(cf._creditasEmailsHandled) ? cf._creditasEmailsHandled : [];
  if (handled.includes(row.id)) return false;
  const fresh = await prisma.lead.findUnique({ where: { id: lead.id }, select: { customFields: true } });
  const c2 = { ...((fresh?.customFields || {}) as Record<string, any>) };
  c2._creditasEmailsHandled = [...handled, row.id].slice(-20); // marca antes: não repete se a IA demorar
  await prisma.lead.update({ where: { id: lead.id }, data: { customFields: c2 as any } });
  const novo = textoNovo(text);
  const v = await classifyJonatasReply(row.subject, novo);
  if (v.tipo === 'BACEN') {
    if (stateOf(c2)) { await addNote(lead.id, `📧 O Jonatas respondeu pedindo o SCR Bacen, mas esse pedido já está em andamento neste card (${stateOf(c2)!.status}).`); return true; }
    await openScr(acc, lead, row, { name: String(c2.participante_1 || lead.name), cpf: digits(String(c2.cpf_1 || '')) || undefined });
    return true;
  }
  const { createEmailQuestion } = require('./ai-team-question.service') as typeof import('./ai-team-question.service');
  await createEmailQuestion({ accountId: acc.accountId, leadId: lead.id, resumo: v.resumo, excerpt: novo.replace(/\n{3,}/g, '\n\n').trim(), io: io as any });
  return true;
}

/** A EQUIPE (balão "Dúvidas da IA") mandou pedir o SCR ao cliente: abre o fluxo com o e-mail mais novo do Jonatas ligado ao card. */
export async function startScrFromTeam(accountId: string, leadId: string): Promise<{ ok: boolean; why?: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true } });
  if (!lead) return { ok: false, why: 'card não encontrado' };
  if (stateOf(lead.customFields)) return { ok: false, why: 'o pedido do SCR já está em andamento neste card' };
  const row = await prisma.emailMessage.findFirst({ where: { leadId, fromAddress: { contains: 'jonatas.carmona@creditas', mode: 'insensitive' } }, orderBy: { date: 'desc' }, include: { emailAccount: true } });
  if (!row) return { ok: false, why: 'não achei e-mail do Jonatas ligado a este card' };
  const { emailAccount, ...rest } = row as any;
  const cf = (lead.customFields || {}) as Record<string, any>;
  await openScr(emailAccount as EmailAccount, lead, rest as EmailMessage, { name: String(cf.participante_1 || lead.name), cpf: digits(String(cf.cpf_1 || '')) || undefined });
  return { ok: true };
}

function pushTeam(accountId: string, leadId: string, leadName: string, body: string) {
  try {
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `Creditas pediu SCR — ${leadName}`, body, leadId }).catch(() => {});
  } catch { /* push é extra */ }
}

const semMatch = new Set<string>(); // e-mails que a varredura já viu e não citam nenhum card aberto (só nesta execução do servidor)
/** E-mails da Creditas dos últimos 14 dias que ainda não estão em nenhum card (chegaram antes desta rotina, ou a ingestão falhou). */
export async function sweepCreditasScrEmails(accountId: string, io: Io): Promise<number> {
  const rows = await prisma.emailMessage.findMany({
    where: { emailAccount: { accountId }, folder: 'INBOX', leadId: null, date: { gte: new Date(Date.now() - 14 * 86_400_000) }, fromAddress: { contains: 'creditas', mode: 'insensitive' } },
    orderBy: { date: 'asc' }, include: { emailAccount: true }, take: 150,
  });
  let n = 0;
  for (const r of rows) {
    if (semMatch.has(r.id)) continue;
    const { emailAccount, ...row } = r as any;
    if (await handleCreditasScrEmail(emailAccount as EmailAccount, row as EmailMessage, io).catch(() => false)) n++;
    else semMatch.add(r.id);
  }
  return n;
}

// ─── Formulário padrão (é o mesmo pra todos os clientes) ───────────────────────

let formCache: { emailId: string; buffer: Buffer } | null = null;

function collect(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** PDF do formulário "Bacen SCR" — pega o anexo do e-mail mais recente da Creditas que tem um (todos são iguais). */
export async function scrFormPdf(accountId: string): Promise<Buffer | null> {
  const rows = await prisma.emailMessage.findMany({
    where: { emailAccount: { accountId }, folder: 'INBOX', fromAddress: { contains: 'creditas', mode: 'insensitive' } },
    orderBy: { date: 'desc' }, take: 80, include: { emailAccount: true },
  });
  for (const r of rows) {
    const att = ((r.attachments as any[] | null) || []).find((a) => /bacen|scr/i.test(a.filename || '') && /pdf/i.test(a.contentType || a.filename || ''));
    if (!att || !r.uid) continue;
    if (formCache?.emailId === r.id) return formCache.buffer;
    try {
      const { streamAttachment } = require('./email-inbox.service') as typeof import('./email-inbox.service');
      let buf: Buffer | null = null;
      await streamAttachment(r.emailAccount, r as any, String(att.part), async (_meta, content) => { buf = await collect(content as Readable); });
      if (buf && (buf as Buffer).length > 1000) { formCache = { emailId: r.id, buffer: buf }; return buf; }
    } catch (e: any) { console.warn('[Creditas SCR] não baixei o formulário do e-mail', r.id, e?.message); }
  }
  return null;
}

// ─── Participantes e leitura dos documentos devolvidos ─────────────────────────

function participantsOf(lead: { name: string; customFields: any }): string[] {
  const cf = (lead.customFields || {}) as Record<string, any>;
  const p1 = String(cf.participante_1 || lead.name || '').trim();
  const p2 = String(cf.participante_2 || '').trim();
  return [p1, ...(p2 && digits(cf.cpf_2).length >= 11 ? [p2] : [])].filter(Boolean);
}

/** Quem precisa assinar (Fabio 15/10): o TITULAR da proposta na Creditas e, SÓ SE a proposta foi enviada à Creditas com 2º participante, o 2º também. Descobre pela rodada do Creditas
 *  desse cliente: o texto da rodada traz "Titular na análise: X (2º participante: Y)" quando o 2º entrou na proposta. Sem rodada achada, só o titular do e-mail. */
async function scrSigners(lead: { id: string; name: string; customFields: any }, st: ScrState): Promise<string[]> {
  const titular = (st.holderName || participantsOf(lead)[0] || lead.name).trim();
  const runs = await prisma.creditAnalysis.findMany({
    where: { leadId: lead.id, bank: 'CREDITAS', kind: 'RUN', dryRun: false, status: { notIn: ['FAILED', 'REQUESTED', 'RUNNING'] } },
    orderBy: { createdAt: 'desc' }, take: 6, select: { holderName: true, holderCpf: true, detail: true },
  });
  const daProposta = runs.find((r) => (st.holderCpf && digits(r.holderCpf || '') === st.holderCpf) || (r.holderName && sameName(r.holderName, titular))) || null;
  const m = /\(2[ºo°]\s*participante:\s*([^)]+)\)/i.exec(daProposta?.detail || '');
  const segundo = m ? m[1].trim() : '';
  return [titular, ...(segundo && !sameName(segundo, titular) ? [segundo] : [])];
}

/** Nome do documento bate com o participante? (primeiro nome ou último sobrenome coincidem — mesma régua do organizador de pastas) */
function sameName(holder: string, participant: string): boolean {
  const h = norm(holder).split(' ').filter((w) => w.length > 1);
  const p = norm(participant).split(' ').filter((w) => w.length > 1);
  if (!h.length || !p.length) return false;
  // Casal com o mesmo sobrenome (Fernando/Rosana Bastos Cruz): só o sobrenome NÃO basta — precisa do primeiro nome ou de mais de uma palavra em comum.
  const comuns = h.filter((w) => p.includes(w)).length;
  return h[0] === p[0] || (h[h.length - 1].length > 2 && h[h.length - 1] === p[p.length - 1] && comuns >= 2);
}

// ─── Preencher o formulário (Fabio 15/10: "precisa datar, colocar o local e preencher com o nome do cliente — o CRM precisa fazer isso") ───
// O PDF da Creditas é UMA página-imagem (A4, sem campos): escreve por cima, em posições fixas (linha da data, "Nome:"/"CPF:" do 1º e do 2º Proponente).

const fmtCpf = (s: string) => { const d = digits(s); return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : String(s || ''); };

/** "Cidade/UF" do local da data no formulário (Fabio 15/10: "tem que ser a cidade/UF e a data"): a cidade/UF de RESIDÊNCIA da proposta do card; sem ela, a do imóvel em garantia ("Imóvel em garantia: Eusébio/CE"). */
async function formCity(leadId: string): Promise<string> {
  const msgs = await prisma.message.findMany({ where: { leadId, OR: [{ content: { contains: 'Cidade/UF' } }, { content: { contains: 'Imóvel em garantia' } }] }, orderBy: { createdAt: 'desc' }, take: 4, select: { content: true } });
  const limpa = (v: string) => v.replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/').trim();
  for (const rx of [/Cidade\/UF resid[êe]ncia:\s*([^\n]+)/i, /Im[óo]vel em garantia:\s*([^\n]+)/i]) {
    for (const m of msgs) {
      const r = rx.exec(m.content || '');
      const v = r ? limpa(r[1]) : '';
      if (v && v.length < 60 && /[A-Za-zÀ-ú]/.test(v)) return v;
    }
  }
  return '';
}

export async function fillScrForm(base: Buffer, people: { name: string; cpf: string }[], city: string): Promise<Buffer> {
  const doc = await PDFDocument.load(base);
  const page = doc.getPage(0);
  const { width, height } = page.getSize();
  if (doc.getPageCount() !== 1 || Math.abs(width - 595) > 3 || Math.abs(height - 842) > 3) return base; // layout diferente do conhecido: não arrisca escrever no lugar errado
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(Buffer.from(CARLITO_REGULAR_BASE64, 'base64'), { subset: true }); // mesma letra do formulário (Calibri)
  const ink = rgb(0.1, 0.1, 0.1); // mesmo tom do texto do formulário
  const fit = (text: string, size: number, maxW: number) => { let sz = size; while (sz > 8 && font.widthOfTextAtSize(text, sz) > maxW) sz -= 0.25; return sz; };
  // Linha "__________, ___ de __________ de 202_": cobre e reescreve inteira ("Cidade, 15 de outubro de 2026").
  const data = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: 'numeric', month: 'long', year: 'numeric' });
  const linha = `${city ? `${city}, ` : ''}${data}`;
  page.drawRectangle({ x: 226.36, y: 437.14, width: 213.42, height: 16.82, color: rgb(1, 1, 1) });
  const sz = fit(linha, 11, 205);
  page.drawText(linha, { x: 226.36 + (213.42 - font.widthOfTextAtSize(linha, sz)) / 2, y: 442 + 4.2, size: sz, font, color: ink });
  // 1º Proponente (coluna da esquerda) e 2º Proponente (coluna da direita).
  const cols = [{ nameX: 149, cpfX: 139, maxW: 173 }, { nameX: 369, cpfX: 357.5, maxW: 168 }];
  people.slice(0, 2).forEach((pe, i) => {
    const c = cols[i];
    page.drawText(pe.name, { x: c.nameX, y: 350.4, size: fit(pe.name, 11, c.maxW), font, color: ink });
    if (pe.cpf) page.drawText(fmtCpf(pe.cpf), { x: c.cpfX, y: 333.2, size: 11, font, color: ink });
  });
  return Buffer.from(await doc.save());
}

/** Formulário da Creditas já datado, com o local e o nome/CPF de quem assina (1º e 2º participante). Sem o PDF-base → null. Falha ao preencher → manda em branco (a equipe é avisada na nota). */
async function scrFormFilled(accountId: string, lead: { id: string; name: string; customFields: any }, st: ScrState, nomes: string[]): Promise<{ pdf: Buffer | null; preenchido: boolean; cidade: string }> {
  const base = await scrFormPdf(accountId);
  if (!base) return { pdf: null, preenchido: false, cidade: '' };
  const cf = (lead.customFields || {}) as Record<string, any>;
  const fontes = [{ nome: st.holderName || '', cpf: st.holderCpf || '' }, { nome: String(cf.participante_1 || lead.name), cpf: String(cf.cpf_1 || '') }, { nome: String(cf.participante_2 || ''), cpf: String(cf.cpf_2 || '') }].filter((f) => f.nome && digits(f.cpf).length === 11);
  const cpfDe = (nome: string) => (fontes.find((f) => norm(f.nome) === norm(nome)) || fontes.find((f) => sameName(f.nome, nome)))?.cpf || '';
  const cidade = await formCity(lead.id).catch(() => '');
  try {
    const pdf = await fillScrForm(base, nomes.map((n) => ({ name: n, cpf: cpfDe(n) })), cidade);
    return { pdf, preenchido: pdf !== base, cidade };
  } catch (e: any) {
    console.warn('[Creditas SCR] não consegui preencher o formulário:', e?.message);
    return { pdf: base, preenchido: false, cidade };
  }
}

const whatsappWindowOpen = async (leadId: string) => {
  const last = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return !!last && Date.now() - last.createdAt.getTime() < WINDOW_MS;
};

async function attachmentBytes(accountId: string, att: { id: string; data: Uint8Array | null; driveFileId: string | null; mimeType: string }): Promise<Buffer | null> {
  try {
    if (att.data && att.data.length) return Buffer.from(att.data);
    if (att.driveFileId) {
      const { downloadDriveFile } = require('./google.service') as typeof import('./google.service');
      return await downloadDriveFile(accountId, att.driveFileId, att.mimeType);
    }
  } catch (e: any) { console.warn('[Creditas SCR] não baixei o anexo', att.id, e?.message); }
  return null;
}

// ─── Fluxo: pedir ao cliente → conferir → encaminhar à Creditas ─────────────────

const GOVBR_STEPS_FALLBACK = `✍️ *Como assinar pelo gov.br (2 minutos)*
1️⃣ Acesse *assinador.iti.br* e entre com seu CPF e senha do gov.br (conta nível *prata* ou *ouro*).
2️⃣ Envie o PDF e arraste o quadrinho da assinatura pra cima da linha do seu nome.
3️⃣ Clique em *Assinar* e confirme com o código que o gov.br mandar (SMS ou app).
4️⃣ *Baixe* o PDF assinado e me envie por aqui. (Não use "imprimir como PDF": isso apaga a assinatura.)`;

/** Passo a passo do gov.br: vem da Base de Conhecimento (entrada "Como assinar … gov.br") — o Fabio edita lá, com o link do vídeo, e a próxima mensagem já sai atualizada. */
async function govbrSteps(accountId: string): Promise<string> {
  const e = await prisma.knowledgeEntry.findFirst({ where: { accountId, title: { contains: 'gov.br', mode: 'insensitive' }, AND: [{ title: { contains: 'assinar', mode: 'insensitive' } }] }, orderBy: { updatedAt: 'desc' }, select: { content: true } }).catch(() => null);
  return (e?.content || '').trim() || GOVBR_STEPS_FALLBACK;
}


// ─── Tag "Aguardando Bacen" (Fabio 16/10): liga a automação "Follow Up Documentação" (template follow_up_doc, 3 em 3 dias, 07h–21h) pro cliente que não devolveu o SCR ──
const BACEN_TAG = 'Aguardando Bacen';
async function setBacenTag(leadId: string, on: boolean): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { tags: true } });
  if (!l) return;
  const has = l.tags.includes(BACEN_TAG);
  if (on === has) return;
  await prisma.lead.update({ where: { id: leadId }, data: { tags: on ? [...l.tags, BACEN_TAG] : l.tags.filter((t) => t !== BACEN_TAG) } });
}

// ─── Creditas só vai até o fim se Inter e Santander NÃO aprovaram no valor total (Fabio 16/10) ───────────────────────────────────────────────────────────────
// Aprovou a menor (ou reprovou / desqualificou) = o Creditas ainda vale e o SCR é pedido ao cliente. Aprovação cheia em qualquer um dos dois = segura o pedido (o cliente não precisa
// assinar nada à toa). Banco ainda sem resposta NÃO segura: quem pediu o SCR foi o Jonatas, então o pedido ao cliente segue.
const BANCOS_ALTERNATIVOS = ['INTER', 'CREDIMORAR'];
async function creditasVale(leadId: string, st: ScrState): Promise<{ ok: boolean; sig: string; motivo: string; ofertas: string[] }> {
  const { whichParticipant } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const card = { name1: String(cf.participante_1 || lead?.name || ''), name2: String(cf.participante_2 || ''), cpf1: cf.cpf_1, cpf2: cf.cpf_2 };
  const rows = await prisma.creditAnalysis.findMany({ where: { leadId, dryRun: false, bank: { in: BANCOS_ALTERNATIVOS }, createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) } }, orderBy: { createdAt: 'desc' } });
  const nome = (b: string) => (b === 'INTER' ? 'Inter' : 'Santander');
  const cheios: string[] = [], pendentes: string[] = [];
  for (const bank of BANCOS_ALTERNATIVOS) {
    const doBanco = rows.filter((r) => r.bank === bank);
    const decisivas = doBanco.filter((r) => ['APPROVED', 'CONDITIONAL', 'REJECTED'].includes(r.status));
    const ultimaPorPessoa = new Map<number, (typeof rows)[number]>();
    for (const r of decisivas) { const w = whichParticipant(card, r.holderName, r.holderCpf); if (!ultimaPorPessoa.has(w)) ultimaPorPessoa.set(w, r); } // do mais novo pro mais antigo
    const cheio = [...ultimaPorPessoa.values()].some((r) => r.status === 'CONDITIONAL' || (r.status === 'APPROVED' && !/aprovad[oa] a menor/i.test(r.detail || '')));
    if (cheio) cheios.push(nome(bank));
    else if (!decisivas.length && doBanco.some((r) => ['SENT', 'CHECK', 'INCOMPLETE', 'REQUESTED', 'RUNNING'].includes(r.status))) pendentes.push(nome(bank));
  }
  if (cheios.length) return { ok: false, sig: `FULL:${cheios.join('+')}`, motivo: `${cheios.join(' e ')} já aprovou no valor total — a Creditas só vale se Inter e Santander não aprovarem ou aprovarem a menor`, ofertas: [] };
  // O que Inter/Santander já aprovaram (a menor) vai pro cliente junto com o pedido do SCR.
  let ofertas: string[] = [];
  try {
    const { buildApprovalText } = require('./approval-notice.service') as typeof import('./approval-notice.service');
    const ab = await buildApprovalText(leadId);
    ofertas = (ab?.options || []).filter((o: any) => !/creditas/i.test(o.instituicao)).map((o: any) => `${o.instituicao}: ${o.valor}${o.prazo ? ` em ${o.prazo}` : ''}${o.primeiraParcela ? `, 1ª parcela ${o.primeiraParcela}` : ''}${o.pedido ? ` (menor que o pedido de ${o.pedido})` : ''}`);
  } catch { /* sem recap: o pedido do SCR segue sozinho */ }
  return { ok: true, sig: 'GO', motivo: '', ofertas };
}

async function askClient(accountId: string, lead: { id: string; name: string; customFields: any }, st: ScrState, io: Io, ofertas: string[] = []): Promise<void> {
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (!(await whatsappWindowOpen(lead.id))) {
    // Sem a janela de 24 h não há mensagem livre: avisa a equipe (uma vez) e tenta de novo quando o cliente falar.
    if (!st.windowNoteAt) {
      await saveState(lead.id, { windowNoteAt: new Date().toISOString() });
      await addNote(lead.id, '⏳ A Creditas pediu o SCR Bacen, mas a janela de 24 h do WhatsApp deste cliente está fechada. Assim que ele responder qualquer coisa, o CRM manda o formulário; ou chame o cliente você mesmo.');
      pushTeam(accountId, lead.id, lead.name, 'SCR da Creditas: janela do WhatsApp fechada — chame o cliente');
    }
    return;
  }
  const nomes = await scrSigners(lead, st);
  const { pdf, preenchido, cidade } = await scrFormFilled(accountId, lead, st, nomes); // o CRM data e preenche local/nome/CPF; o cliente só assina
  const nome = callableFirstName(nomes[0], cf.participante_1, lead.name) || '';
  const outros = nomes.slice(1);
  const { conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const saudacao = (await conversationActive(lead.id)) ? '' : `Oi${nome ? `, ${nome}` : ''}! `;
  const abertura = ofertas.length
    ? `${saudacao}Já temos condição aprovada pra você:\n${ofertas.map((o) => `• ${o}`).join('\n')}\n\nEstamos tentando *também pela Creditas*, que pode ter uma condição ainda melhor. Pra seguir com ela, a Creditas pediu mais um passo: a *Autorização de consulta ao SCR do Banco Central* assinada`
    : `${saudacao}A Creditas pediu mais um passo pra seguir com a pré-aprovação do seu crédito: a *Autorização de consulta ao SCR do Banco Central* assinada`;
  const texto = `${abertura}${outros.length ? ` por cada participante (você e ${outros.join(', ')})` : ''}.\n\n📎 Estou te mandando o formulário em PDF, que já está preenchido. É só *assinar pelo gov.br* (assinatura eletrônica) e me devolver aqui${outros.length ? ' — cada um assina o seu' : ''}.\n\n✍️ Se preferir assinar à mão: imprima e assine *igual à assinatura do seu documento de identidade*, e me mande o formulário assinado.\n\nJunto, preciso também de uma foto do seu *documento de identidade com foto* (RG ou CNH, frente e verso)${outros.length ? ' — e o mesmo do(a) ' + outros.join(', ') : ''}: ele serve pra validar a assinatura.\n\nAssim que chegar, eu envio pra Creditas e te aviso.`;
  const { sendOutboundWhatsApp, sendOutboundMedia } = require('./message.service') as typeof import('./message.service');
  const r1 = await sendOutboundWhatsApp({ accountId, leadId: lead.id, content: texto, io: io as any });
  if (!r1.success) { console.warn(`[Creditas SCR] ${lead.name}: mensagem ao cliente não saiu — ${(r1 as any).error}`); return; }
  if (pdf) await sendOutboundMedia({ accountId, leadId: lead.id, buffer: pdf, fileName: 'Autorizacao SCR Bacen.pdf', mimeType: 'application/pdf', io: io as any }).catch(() => {});
  await sendOutboundWhatsApp({ accountId, leadId: lead.id, content: await govbrSteps(accountId), io: io as any }).catch(() => {});
  await saveState(lead.id, { status: 'ASKED', askedAt: new Date().toISOString() });
  await setBacenTag(lead.id, true); // liga o lembrete por template (Follow Up Documentação) se a janela fechar
  await addNote(lead.id, pdf ? `📨 Mandei ao cliente o formulário SCR Bacen ${preenchido ? `já preenchido (data de hoje${cidade ? `, local ${cidade}` : ', SEM local — não achei a cidade do imóvel na proposta'}, nome e CPF)` : 'EM BRANCO (não consegui preencher)'}: assinar pelo gov.br e devolver junto com a foto do documento de identidade (valida a assinatura; à mão, assinar igual ao documento).` : '📨 Pedi ao cliente a assinatura do SCR Bacen pelo gov.br, mas NÃO consegui baixar o formulário do e-mail — mande o PDF "Bacen SCR" a ele.');
}

type Doc = { attId: string; fileName: string; mimeType: string; createdAt: Date; kind: 'SCR' | 'ID' | 'OUTRO'; holder: string; ok: boolean; problema: string; duvida: boolean; assinatura?: 'GOVBR' | 'PUNHO' };

async function collectDocs(accountId: string, lead: { id: string; name: string }, since: Date): Promise<{ docs: Doc[]; lastAt: Date | null }> {
  const { reviewReceivedDocs } = require('./doc-review.service') as typeof import('./doc-review.service');
  await reviewReceivedDocs(accountId, lead.id).catch((e: any) => console.warn('[Creditas SCR] leitura dos documentos falhou:', e?.message));
  const fresh = await prisma.lead.findUnique({ where: { id: lead.id }, select: { customFields: true } });
  const rev = (((fresh?.customFields || {}) as any)._docReview || {}) as Record<string, any>;
  const atts = await prisma.messageAttachment.findMany({
    where: { leadId: lead.id, message: { direction: 'INBOUND' }, createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' }, select: { id: true, fileName: true, mimeType: true, createdAt: true },
  });
  const docs: Doc[] = atts.map((a) => {
    const r = rev[a.id];
    const tipo = String(r?.tipo || '');
    const kind: Doc['kind'] = /SCR|BACEN/i.test(tipo) ? 'SCR' : /^(RG|CNH|CARTEIRA DE IDENTIDADE|IDENTIDADE)\b/i.test(tipo) ? 'ID' : 'OUTRO';
    return { attId: a.id, fileName: a.fileName, mimeType: a.mimeType, createdAt: a.createdAt, kind, holder: String(r?.titular || ''), ok: r?.resultado === 'OK', problema: r?.resultado === 'PROBLEMA' ? String((r.problemas || []).join('; ')) : '', duvida: r?.resultado === 'DUVIDA', assinatura: r?.assinatura };
  });
  return { docs, lastAt: atts.length ? atts[atts.length - 1].createdAt : null };
}

/** Fala com o cliente pelo fluxo do SCR — só com a IA LIGADA na conversa (Fabio 15/10, Mauricio: "por que a IA tá mandando algo sem estar ligada"). IA desligada = a equipe assumiu: não manda,
 *  deixa nota + aviso com o que ia dizer. (O 1º pedido do formulário e o envio à Creditas não passam por aqui.) */
async function tellClient(accountId: string, leadId: string, text: string, io: Io) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, aiAutoReplyActive: true } });
  if (!lead?.aiAutoReplyActive) {
    await addNote(leadId, `🔕 SCR Creditas — a IA está desligada neste card, então NÃO mandei ao cliente. Ia dizer: "${text.replace(/\s+/g, ' ').slice(0, 400)}"`);
    pushTeam(accountId, leadId, lead?.name || 'Cliente', 'SCR da Creditas: o cliente devolveu algo — confira (IA desligada, nada foi enviado)');
    return { success: false, skipped: 'ia-desligada' } as any;
  }
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  return sendOutboundWhatsApp({ accountId, leadId, content: text, io: io as any });
}

async function checkAndForward(accountId: string, lead: { id: string; name: string; customFields: any }, st: ScrState, io: Io): Promise<void> {
  const since = new Date(st.askedAt || st.at);
  const { docs, lastAt } = await collectDocs(accountId, lead, since);
  const relevantes = docs.filter((d) => d.kind !== 'OUTRO');
  if (!relevantes.length || !lastAt) return; // cliente ainda não devolveu nada
  const aindaMandando = Date.now() - lastAt.getTime() < QUIET_AFTER_DOC_MS; // só segura o AVISO (problema/falta); estando tudo certo e completo, envia à Creditas na hora
  if (docs.some((d) => d.duvida)) return; // dúvida de documento com a equipe (balão) — espera a resposta
  const nomes = await scrSigners(lead, st);
  const cf = (lead.customFields || {}) as Record<string, any>;
  const aberto = !!(await whatsappWindowOpen(lead.id));

  // SCR sem assinatura / ilegível etc.: pede de novo (uma vez por conjunto de problemas).
  const ruins = docs.filter((d) => d.kind !== 'OUTRO' && d.problema);
  if (ruins.length) {
    if (aindaMandando) return;
    const sig = ruins.map((d) => `${d.attId}:${d.problema}`).join('|');
    if (sig !== st.problemSig && aberto) {
      await saveState(lead.id, { problemSig: sig });
      const linhas = ruins.map((d) => `⚠️ *${d.kind === 'SCR' ? 'Autorização SCR' : 'Documento de identidade'}${d.holder ? ` (${d.holder.split(' ').slice(0, 2).join(' ')})` : ''}* — ${d.problema}`);
      const rr = await tellClient(accountId, lead.id, `Conferi o que você mandou e preciso de um ajuste:\n\n${linhas.join('\n')}\n\nAssim que reenviar, eu confiro de novo!`, io);
      await addNote(lead.id, `🤖 SCR Creditas: problema nos documentos devolvidos — ${ruins.map((d) => d.problema).join(' | ')}. ${rr?.success ? 'Cliente avisado.' : 'Cliente NÃO avisado (IA desligada).'}`);
    }
    return;
  }

  // O que falta, participante por participante.
  const faltas: string[] = [];
  const escolhidos: Doc[] = [];
  for (const p of nomes) {
    const scr = docs.filter((d) => d.kind === 'SCR' && d.ok && sameName(d.holder, p)).pop();
    const ident = docs.filter((d) => d.kind === 'ID' && d.ok && sameName(d.holder, p));
    if (!scr) faltas.push(`a Autorização SCR assinada de ${p.split(' ').slice(0, 2).join(' ')}`);
    // Fabio 15/10: a identidade (com foto) vem SEMPRE junto — é ela que valida a assinatura (à mão: tem que ser igual à do documento).
    if (!ident.length) faltas.push(`uma foto do documento de identidade com foto (RG ou CNH) de ${p.split(' ').slice(0, 2).join(' ')}, pra validar a assinatura`);
    if (scr) escolhidos.push(scr);
    escolhidos.push(...ident);
  }
  if (faltas.length) {
    if (aindaMandando) return;
    const sig = faltas.join('|');
    if (sig !== st.faltaSig && aberto) {
      await saveState(lead.id, { faltaSig: sig });
      await tellClient(accountId, lead.id, `Recebi! Pra eu enviar pra Creditas ainda falta:\n${faltas.map((f) => `• ${f}`).join('\n')}\n\nPode mandar por aqui mesmo.`, io);
    }
    return;
  }

  // Tudo certo de todos os participantes: responde o e-mail da Creditas com os anexos.
  await saveState(lead.id, { status: 'SENDING' });
  try {
    const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
    const acc = await prisma.emailAccount.findUnique({ where: { id: st.emailAccountId } });
    const row = await prisma.emailMessage.findUnique({ where: { id: st.emailId } });
    if (!acc || !row || !row.fromAddress || !CREDITAS_SENDER.test(row.fromAddress)) throw new Error('e-mail da Creditas (ou a caixa) não encontrado');
    const own = new Set([acc.address.toLowerCase()]);
    const cc = [...((row.toList as any[]) || []), ...((row.ccList as any[]) || [])].map((a) => String(a?.address || '').toLowerCase()).filter((a) => a && !own.has(a) && a !== row.fromAddress!.toLowerCase() && CREDITAS_SENDER.test(a));
    const arquivos: { filename: string; contentType: string; content: Buffer }[] = [];
    const unicos = Array.from(new Map(escolhidos.map((d) => [d.attId, d])).values());
    for (const d of unicos) {
      const att = await prisma.messageAttachment.findUnique({ where: { id: d.attId }, select: { id: true, data: true, driveFileId: true, mimeType: true, fileName: true } });
      const buf = att ? await attachmentBytes(accountId, att) : null;
      if (!att || !buf) throw new Error(`não consegui abrir o arquivo ${d.fileName}`);
      const ext = (att.fileName.match(/\.[a-z0-9]{2,5}$/i)?.[0] || (att.mimeType === 'application/pdf' ? '.pdf' : '.jpg')).toLowerCase();
      const quem = (d.holder || 'cliente').split(' ').slice(0, 3).join(' ').toUpperCase();
      arquivos.push({ filename: `${d.kind === 'SCR' ? 'AUTORIZACAO SCR BACEN' : 'IDENTIDADE'} - ${quem}${arquivos.some((a) => a.filename.startsWith(`${d.kind === 'SCR' ? 'AUTORIZACAO' : 'IDENTIDADE'}`) && a.filename.includes(quem)) ? ` ${arquivos.length + 1}` : ''}${ext}`, contentType: att.mimeType, content: buf });
    }
    const subject = /^re:/i.test(row.subject || '') ? row.subject! : `Re: ${row.subject || 'Autorização SCR Não Validada'}`;
    const corpo = `Olá!\n\nSeguem a Autorização SCR Bacen assinada e as identidades dos participantes da proposta${st.creditasId ? ` (ID ${st.creditasId})` : ''}:\n${nomes.map((n) => `• ${n}`).join('\n')}\n\nConseguem seguir com a pré-aprovação do crédito? Qualquer coisa, estamos à disposição.`;
    await sendEmailFrom({ acc, userId: null, to: [row.fromAddress], cc, subject, body: corpo, replyToId: row.id, leadId: lead.id, io: io as any, attachments: arquivos });
    await saveState(lead.id, { status: 'SENT', sentAt: new Date().toISOString() });
    await setBacenTag(lead.id, false);
    await addNote(lead.id, `📤 Autorização SCR Bacen assinada + identidades enviadas à Creditas (resposta ao e-mail de ${row.fromAddress}${cc.length ? `, com cópia pra ${cc.join(', ')}` : ''}). Anexos: ${arquivos.map((a) => a.filename).join(', ')}.`);
    logActivity({ accountId, userId: null, userName: 'Análise automática', action: 'lead_edited', leadId: lead.id, leadName: lead.name, summary: 'enviou à Creditas a Autorização SCR Bacen assinada' } as any);
    if (aberto) await tellClient(accountId, lead.id, 'Já enviei sua autorização e seus documentos pra Creditas! Assim que eles retornarem, eu te aviso por aqui. 😊', io);
    pushTeam(accountId, lead.id, lead.name, 'SCR assinado enviado à Creditas');
    // A Creditas vai reanalisar: confere o resultado do portal logo, sem esperar a próxima rodada.
    try { const { expediteCheck } = require('./credit-analysis.service') as typeof import('./credit-analysis.service'); await expediteCheck(prisma as any, { accountId, leadId: lead.id, bank: 'CREDITAS' }); } catch { /* extra */ }
  } catch (e: any) {
    await saveState(lead.id, { status: 'ASKED' }); // volta pra tentar de novo na próxima rodada
    await addNote(lead.id, `⚠️ Não consegui enviar o SCR assinado à Creditas por e-mail: ${e?.message || e}. Envie você mesmo (os arquivos estão na conversa).`);
    pushTeam(accountId, lead.id, lead.name, 'Falha ao enviar o SCR assinado à Creditas — envie à mão');
    console.warn(`[Creditas SCR] ${lead.name}: envio falhou —`, e?.message);
  }
}

// ─── Lembrete ANTES da janela de 24 h fechar (Fabio 15/10): "senão ele fica perdido pra sempre ali — o CRM precisa colocar isso automático" ──────────────────────
// Fora da janela só dá pra falar com template, e o cliente que não devolve o SCR assinado trava a análise da Creditas. 3 h antes de a janela fechar (e só entre 07h e 21h de Brasília:
// se cair de noite, vai às 20h30 da véspera) o CRM cobra o que falta do SCR — uma vez por janela (se o cliente responde, abre outra janela e vale outro lembrete).
const BRT = -3 * 3_600_000;
function reminderTarget(lastInMs: number): number {
  const closeAt = lastInMs + 24 * 3_600_000;
  let t = closeAt - 3 * 3_600_000;
  const d = new Date(t + BRT);
  const h = d.getUTCHours();
  if (h < 7 || h >= 21) t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + (h < 7 ? -1 : 0), 20, 30, 0) - BRT;
  return Math.max(t, lastInMs + 30 * 60_000);
}

async function remindBeforeWindowCloses(accountId: string, lead: { id: string; name: string; customFields: any }, st: ScrState, io: Io): Promise<void> {
  const last = await prisma.message.findFirst({ where: { leadId: lead.id, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (!last) return;
  const lastMs = last.createdAt.getTime();
  const now = Date.now();
  if (now >= lastMs + 24 * 3_600_000 - 15 * 60_000) return; // a janela já fechou (ou está fechando agora)
  if (now < reminderTarget(lastMs)) return;
  const forWindow = last.createdAt.toISOString();
  if (st.windowRemindFor === forWindow) return;

  // O que ainda falta (mesma conta do envio à Creditas): SCR assinado + identidade de cada participante.
  const { docs } = await collectDocs(accountId, lead, new Date(st.askedAt || st.at));
  const nomes = await scrSigners(lead, st);
  const faltas: string[] = [];
  for (const p of nomes) {
    const curto = p.split(' ').slice(0, 2).join(' ');
    if (!docs.some((d) => d.kind === 'SCR' && d.ok && sameName(d.holder, p))) faltas.push(`a Autorização SCR assinada de ${curto}`);
    if (!docs.some((d) => d.kind === 'ID' && d.ok && sameName(d.holder, p))) faltas.push(`uma foto do documento de identidade com foto (RG ou CNH) de ${curto}`);
  }
  if (!faltas.length) return; // está tudo aí: o envio à Creditas segue pelo fluxo normal
  await saveState(lead.id, { windowRemindFor: forWindow }); // marca antes de mandar: não repete se o envio demorar

  const quando = new Date(lastMs + 24 * 3_600_000).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
  const l = await prisma.lead.findUnique({ where: { id: lead.id }, select: { aiAutoReplyActive: true } });
  if (!l?.aiAutoReplyActive) {
    await addNote(lead.id, `⏰ A janela de 24 h do WhatsApp deste cliente fecha ${quando} e o SCR da Creditas ainda não voltou (falta: ${faltas.join('; ')}). A IA está desligada, então NÃO cobrei — chame o cliente antes que feche.`);
    pushTeam(accountId, lead.id, lead.name, 'SCR da Creditas: janela do WhatsApp fecha em breve — cobre o documento');
    return;
  }
  const { conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const nome = callableFirstName(nomes[0], (lead.customFields || {}).participante_1, lead.name) || '';
  const saudacao = (await conversationActive(lead.id)) ? '' : `Oi${nome ? `, ${nome}` : ''}! `;
  const texto = `${saudacao}Passando pra lembrar do SCR Bacen da Creditas — sem ele a análise não segue. Ainda falta:\n${faltas.map((f) => `• ${f}`).join('\n')}\n\nÉ só me mandar por aqui mesmo. Se tiver dificuldade pra assinar pelo gov.br, me avisa que eu te ajudo. 😊`;
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId, leadId: lead.id, content: texto, io: io as any });
  await addNote(lead.id, `⏰ A janela de 24 h do WhatsApp fecha ${quando}: cobrei o SCR da Creditas antes (falta: ${faltas.join('; ')}). ${r.success ? 'Cliente avisado.' : 'O envio falhou — chame o cliente.'}`);
  if (!r.success) pushTeam(accountId, lead.id, lead.name, 'SCR da Creditas: não consegui cobrar antes da janela fechar — chame o cliente');
}


let lastSweep = 0;
/** Poller (1 min): varre e-mails ainda não tratados, pede o SCR aos clientes e encaminha à Creditas o que voltou assinado. */
export async function processScrFlows(accountId: string, io: Io): Promise<void> {
  if (Date.now() - lastSweep > 5 * 60_000) { lastSweep = Date.now(); await sweepCreditasScrEmails(accountId, io).catch((e) => console.warn('[Creditas SCR] varredura:', e?.message)); }
  const ids = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND "customFields"->'_scrCreditas'->>'status' IN ('PENDING', 'ASKED')`;
  for (const { id } of ids) {
    const lead = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, customFields: true } });
    if (!lead) continue;
    const cf = (lead.customFields || {}) as Record<string, any>;
    if (cf._autoPaused) continue; // STOP TOTAL do cliente
    const st = stateOf(cf);
    if (!st) continue;
    try {
      if (st.status === 'PENDING') {
        const vale = await creditasVale(lead.id, st);
        if (!vale.ok) {
          if (st.holdSig !== vale.sig) { await saveState(lead.id, { holdSig: vale.sig }); await addNote(lead.id, `⏸️ A Creditas pediu o SCR Bacen, mas por ora NÃO peço ao cliente: ${vale.motivo}. O CRM volta a pedir sozinho se isso mudar.`); }
          continue;
        }
        await askClient(accountId, lead, st, io, vale.ofertas);
      }
      else if (st.status === 'ASKED') {
        await remindBeforeWindowCloses(accountId, lead, st, io).catch((e: any) => console.warn(`[Creditas SCR] ${lead.name}: lembrete antes da janela falhou —`, e?.message));
        await checkAndForward(accountId, lead, st, io);
      }
    } catch (e: any) { console.warn(`[Creditas SCR] ${lead.name}:`, e?.message); }
  }
}

/** Bloco pro prompt da IA de conversa: o que a Creditas pediu e em que pé está. Vazio se o card não tem pedido de SCR. */
export async function scrCreditasContext(leadId: string): Promise<string> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const st = stateOf(lead?.customFields);
  if (!st) return '';
  const quando = (iso?: string) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '');
  const situ = st.status === 'SENT'
    ? `Já foi ENVIADO à Creditas em ${quando(st.sentAt)} (autorização assinada + identidades). Agora é aguardar o retorno da Creditas; não peça de novo.`
    : st.status === 'ASKED' || st.status === 'SENDING'
      ? `O formulário já foi mandado ao cliente em ${quando(st.askedAt)}; AGUARDANDO o cliente devolver o PDF assinado (gov.br, ou à mão igual à do documento) + a foto do documento de identidade (RG/CNH) de cada participante. O CRM confere os arquivos e envia à Creditas sozinho.`
      : 'A equipe está preparando o envio do formulário ao cliente.';
  return `CREDITAS PEDIU A AUTORIZAÇÃO SCR BACEN (e-mail de ${quando(st.at)}${st.creditasId ? `, ID ${st.creditasId}` : ''}): a Creditas não conseguiu aprovar o crédito de uma vez e precisa do formulário SCR Bacen ASSINADO por cada participante + a identidade com foto (valida a assinatura). Situação: ${situ}\nSe o cliente perguntar: é uma autorização pra consulta ao SCR (Sistema de Informações de Crédito do Banco Central), exigência da Creditas pra seguir com a pré-aprovação; o CRM já manda o formulário preenchido (data, local, nome e CPF); ele só assina PELO GOV.BR (assinatura eletrônica no PDF) — ou à mão, igual à assinatura do documento de identidade — e devolve o PDF assinado aqui, junto com a foto do documento de identidade com foto (RG/CNH), que serve pra validar a assinatura. Ele NÃO precisa preencher nada. O gov.br NÃO tem opção de inserir texto/editar o PDF (não existe ícone "T") — NUNCA diga isso nem invente passos do gov.br; os passos corretos estão na Base de Conhecimento ("Como assinar … pelo gov.br"). Se o cliente disser que não consegue editar/preencher nome e CPF, é isso mesmo: o formulário tem que ir PREENCHIDO pelo CRM — não mande ele preencher; avise que a equipe manda o formulário já preenchido. NÃO diga que o crédito está aprovado nem prometa prazo da Creditas.`;
}
