import { PrismaClient, EmailMessage, EmailAccount } from '@prisma/client';
import { Readable } from 'stream';
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
const QUIET_AFTER_DOC_MS = 3 * 60_000; // espera o cliente terminar de mandar os arquivos antes de conferir

export interface ScrState {
  /** NOTED = e-mail ligado ao card, mas o CRM NÃO pede sozinho ao cliente (card fora da Pré-Análise); a equipe cuida. */
  status: 'PENDING' | 'ASKED' | 'SENDING' | 'SENT' | 'NOTED';
  emailId: string; emailAccountId: string; creditasId?: string; at: string;
  /** Titular da proposta na Creditas (nome e CPF que vêm no e-mail) — a partir dele se descobre quem mais entrou na proposta. */
  holderName?: string; holderCpf?: string;
  askedAt?: string; sentAt?: string; chasedAt?: string; windowNoteAt?: string; problemSig?: string; faltaSig?: string;
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

/** E-mail da Creditas pedindo a Autorização SCR Bacen? (assunto "Autorização SCR Não Validada" ou o corpo fala de SCR + Bacen) */
export function isScrRequest(from: string | null | undefined, subject: string | null | undefined, text: string): boolean {
  if (!from || !CREDITAS_SENDER.test(from)) return false;
  return /\bSCR\b/i.test(subject || '') || (/\bSCR\b/i.test(text) && /bacen|banco central/i.test(text));
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
    if (!scr) continue;
    const st = stateOf(lead.customFields);
    if (!st) {
      // 1º pedido de SCR desse cliente: marca como pendente e avisa a equipe.
      // Só pede sozinho ao cliente quem está na PRÉ-ANÁLISE (é onde o Creditas pede o SCR); em outra etapa (vistoria, documentação…) a equipe já está tratando — só liga o e-mail e avisa.
      const etapa = await prisma.lead.findUnique({ where: { id: lead.id }, select: { stage: { select: { name: true } } } });
      const naPre = /^pr[eé]-?an/i.test((etapa?.stage?.name || '').normalize('NFD').replace(/[̀-ͯ]/g, ''));
      await saveState(lead.id, { status: naPre ? 'PENDING' : 'NOTED', emailId: row.id, emailAccountId: acc.id, creditasId: c.creditasId, at: row.date.toISOString(), holderName: c.name, holderCpf: c.cpf });
      await addNote(lead.id, `📧 A Creditas pediu a AUTORIZAÇÃO SCR BACEN assinada pelos participantes + as identidades${c.creditasId ? ` (ID ${c.creditasId})` : ''} — e-mail de ${row.date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })}. ${naPre ? 'O CRM manda o formulário pro cliente assinar pelo gov.br, confere o que ele devolver e responde a Creditas; enquanto isso a consulta do Creditas fica TRAVADA.' : `O card está em "${etapa?.stage?.name || '?'}" (fora da Pré-Análise): o CRM NÃO pediu ao cliente sozinho — a equipe cuida.`}`);
      pushTeam(acc.accountId, lead.id, lead.name, naPre ? 'A Creditas pediu a Autorização SCR Bacen assinada — o CRM vai pedir ao cliente' : 'A Creditas pediu a Autorização SCR Bacen — cuide à mão (card fora da Pré-Análise)');
      logActivity({ accountId: acc.accountId, userId: null, userName: 'Análise automática', action: 'lead_edited', leadId: lead.id, leadName: lead.name, summary: 'a Creditas pediu a Autorização SCR Bacen assinada' } as any);
    } else {
      // Cobrança ("tivemos alguma devolutiva?") ou novo e-mail do mesmo pedido: guarda o e-mail mais novo (a resposta sai no fio dele) e, se já foi enviado, só registra.
      if (new Date(st.chasedAt || st.at).getTime() < row.date.getTime()) await saveState(lead.id, { emailId: row.id, emailAccountId: acc.id, chasedAt: row.date.toISOString() });
      if (st.status === 'SENT' && (!st.chasedAt || new Date(st.chasedAt).getTime() < row.date.getTime())) await addNote(lead.id, `📧 A Creditas escreveu de novo sobre o SCR (cobrando devolutiva), mas a Autorização já foi enviada em ${st.sentAt ? new Date(st.sentAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' }) : '—'}.`);
    }
  }
  return tratados > 0;
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
  return h[0] === p[0] || (h[h.length - 1].length > 2 && h[h.length - 1] === p[p.length - 1]);
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

async function askClient(accountId: string, lead: { id: string; name: string; customFields: any }, st: ScrState, io: Io): Promise<void> {
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
  const pdf = await scrFormPdf(accountId); // o formulário é o MESMO pra todos: vai do jeito que a Creditas mandou, sem preencher nada
  const nomes = await scrSigners(lead, st);
  const nome = callableFirstName(nomes[0], cf.participante_1, lead.name) || '';
  const outros = nomes.slice(1);
  const texto = `Oi${nome ? `, ${nome}` : ''}! A Creditas pediu mais um passo pra seguir com a pré-aprovação do seu crédito: a *Autorização de consulta ao SCR do Banco Central* assinada${outros.length ? ` por cada participante (você e ${outros.join(', ')})` : ''}.\n\n📎 Estou te mandando o formulário em PDF. É só preencher (nome, CPF e data) e assinar *pelo gov.br* (assinatura eletrônica) — se precisar de ajuda, é só me falar.\n\nDepois me devolva aqui:\n• o PDF *assinado*\n• uma foto do seu *documento de identidade* (RG ou CNH, frente e verso)${outros.length ? ' — e o mesmo do(a) ' + outros.join(', ') : ''}\n\nAssim que chegar, eu envio pra Creditas e te aviso.`;
  const { sendOutboundWhatsApp, sendOutboundMedia } = require('./message.service') as typeof import('./message.service');
  const r1 = await sendOutboundWhatsApp({ accountId, leadId: lead.id, content: texto, io: io as any });
  if (!r1.success) { console.warn(`[Creditas SCR] ${lead.name}: mensagem ao cliente não saiu — ${(r1 as any).error}`); return; }
  if (pdf) await sendOutboundMedia({ accountId, leadId: lead.id, buffer: pdf, fileName: 'Autorizacao SCR Bacen.pdf', mimeType: 'application/pdf', io: io as any }).catch(() => {});
  await saveState(lead.id, { status: 'ASKED', askedAt: new Date().toISOString() });
  await addNote(lead.id, pdf ? '📨 Mandei ao cliente o formulário SCR Bacen e pedi pra assinar pelo gov.br e devolver com o documento de identidade.' : '📨 Pedi ao cliente a assinatura do SCR Bacen pelo gov.br, mas NÃO consegui baixar o formulário do e-mail — mande o PDF "Bacen SCR" a ele.');
}

type Doc = { attId: string; fileName: string; mimeType: string; createdAt: Date; kind: 'SCR' | 'ID' | 'OUTRO'; holder: string; ok: boolean; problema: string; duvida: boolean };

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
    return { attId: a.id, fileName: a.fileName, mimeType: a.mimeType, createdAt: a.createdAt, kind, holder: String(r?.titular || ''), ok: r?.resultado === 'OK', problema: r?.resultado === 'PROBLEMA' ? String((r.problemas || []).join('; ')) : '', duvida: r?.resultado === 'DUVIDA' };
  });
  return { docs, lastAt: atts.length ? atts[atts.length - 1].createdAt : null };
}

async function tellClient(accountId: string, leadId: string, text: string, io: Io) {
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  return sendOutboundWhatsApp({ accountId, leadId, content: text, io: io as any });
}

async function checkAndForward(accountId: string, lead: { id: string; name: string; customFields: any }, st: ScrState, io: Io): Promise<void> {
  const since = new Date(st.askedAt || st.at);
  const { docs, lastAt } = await collectDocs(accountId, lead, since);
  const relevantes = docs.filter((d) => d.kind !== 'OUTRO');
  if (!relevantes.length || !lastAt) return; // cliente ainda não devolveu nada
  if (Date.now() - lastAt.getTime() < QUIET_AFTER_DOC_MS) return; // ainda mandando arquivos
  if (docs.some((d) => d.duvida)) return; // dúvida de documento com a equipe (balão) — espera a resposta
  const nomes = await scrSigners(lead, st);
  const cf = (lead.customFields || {}) as Record<string, any>;
  const aberto = !!(await whatsappWindowOpen(lead.id));

  // SCR sem assinatura / ilegível etc.: pede de novo (uma vez por conjunto de problemas).
  const ruins = docs.filter((d) => d.kind !== 'OUTRO' && d.problema);
  if (ruins.length) {
    const sig = ruins.map((d) => `${d.attId}:${d.problema}`).join('|');
    if (sig !== st.problemSig && aberto) {
      await saveState(lead.id, { problemSig: sig });
      const linhas = ruins.map((d) => `⚠️ *${d.kind === 'SCR' ? 'Autorização SCR' : 'Documento de identidade'}${d.holder ? ` (${d.holder.split(' ').slice(0, 2).join(' ')})` : ''}* — ${d.problema}`);
      await tellClient(accountId, lead.id, `Conferi o que você mandou e preciso de um ajuste:\n\n${linhas.join('\n')}\n\nAssim que reenviar, eu confiro de novo!`, io);
      await addNote(lead.id, `🤖 SCR Creditas: problema nos documentos devolvidos — ${ruins.map((d) => d.problema).join(' | ')}. Cliente avisado.`);
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
    if (!ident.length) faltas.push(`o documento de identidade (RG ou CNH) de ${p.split(' ').slice(0, 2).join(' ')}`);
    if (scr) escolhidos.push(scr);
    escolhidos.push(...ident);
  }
  if (faltas.length) {
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
      if (st.status === 'PENDING') await askClient(accountId, lead, st, io);
      else if (st.status === 'ASKED') await checkAndForward(accountId, lead, st, io);
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
      ? `O formulário já foi mandado ao cliente em ${quando(st.askedAt)}; AGUARDANDO o cliente devolver o PDF assinado pelo gov.br + o documento de identidade (RG/CNH) de cada participante. O CRM confere os arquivos e envia à Creditas sozinho.`
      : 'A equipe está preparando o envio do formulário ao cliente.';
  return `CREDITAS PEDIU A AUTORIZAÇÃO SCR BACEN (e-mail de ${quando(st.at)}${st.creditasId ? `, ID ${st.creditasId}` : ''}): a Creditas não conseguiu aprovar o crédito de uma vez e precisa do formulário SCR Bacen ASSINADO por cada participante + as identidades. Situação: ${situ}\nSe o cliente perguntar: é uma autorização pra consulta ao SCR (Sistema de Informações de Crédito do Banco Central), exigência da Creditas pra seguir com a pré-aprovação; ele assina PELO GOV.BR (assinatura eletrônica no PDF) e devolve o PDF assinado aqui, com a foto do RG/CNH. NÃO diga que o crédito está aprovado nem prometa prazo da Creditas.`;
}
