import { prisma } from '../lib/prisma';

/**
 * E-mails do Inter sobre UM cliente (Fabio 19/10: "o próximo passo é receber o e-mail de engajamento do cliente, então tem que ficar de olho no e-mail que o Inter irá
 * encaminhar com o nome do cliente"). Depois que o formulário de cadastro vai e a vistoria é pedida, o Inter manda "[Inter] Engajamento Automático - <proposta> - <NOME>"
 * (consultor designado) e a consultora responde ("solicitei a vistoria… engenheiro em até 2 dias úteis… laudo em até 6"). Esses e-mails vêm de um remetente que escreve sobre
 * VÁRIOS clientes, então o vínculo NUNCA é "todo e-mail desse remetente é desse card" (caso Antônio Claudir): aqui liga SÓ este e-mail, e só quando o número da proposta ou o
 * NOME do cliente bate com um card. Sem card certo (ou mais de um): não liga nada.
 */

export type InterEmailKind = 'ENGAJAMENTO' | 'VISTORIA' | 'PENDENCIA' | 'OUTRO';

const norm = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const stripZeros = (n: string) => String(n || '').replace(/\D/g, '').replace(/^0+/, '');

/** Tira "Re:", "Enc:", "Fwd:" do começo. Pura (testável). */
export const cleanSubject = (s: string | null | undefined) => String(s || '').replace(/^\s*((re|enc|fwd|fw|res)\s*:\s*)+/i, '').trim();

/** Número da proposta e nome do cliente no assunto: "[Inter] Engajamento Automático - 5676256 - SÉRGIO FURONI MARQUES". Pura (testável). */
export function parseInterSubject(subject: string | null | undefined): { proposta: string | null; nome: string | null } {
  const s = cleanSubject(subject);
  const m = /(\d{5,10})\s*[-–]\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .]{4,80}?)\s*$/.exec(s);
  if (m) return { proposta: stripZeros(m[1]), nome: m[2].trim() };
  const n = /\b(\d{6,10})\b/.exec(s);
  return { proposta: n ? stripZeros(n[1]) : null, nome: null };
}

/** Número da proposta e nome do cliente no CORPO (inclusive no texto citado): "…acompanhar a proposta 5674612 do cliente Pedro Francisco Martins Paiva." Pura (testável). */
export function parseInterBody(text: string | null | undefined): { proposta: string | null; nome: string | null } {
  const t = String(text || '').replace(/\r/g, ' ').replace(/\s+/g, ' ');
  const p = /proposta\s+(?:n[º°o.]*\s*)?(\d{5,10})\b/i.exec(t);
  const n = /cliente\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' ]{5,70}?)(?:\s*[.,;:\n]|\s+ANDRE|\s+será|\s+$)/.exec(t);
  return { proposta: p ? stripZeros(p[1]) : null, nome: n ? n[1].trim() : null };
}

/** Link do laudo digital que o Inter/BPO manda no e-mail ("LINK: https://avaliacaoimovel.bancointer.com.br/…") — NUNCA é montado pelo CRM: o link muda de caso pra caso (Fabio 20/10). Só aceita https no domínio bancointer.com.br. Pura (testável). */
export function extractLaudoLink(text: string | null | undefined): string | null {
  const urls = String(text || '').match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  for (const raw of urls) {
    const u = raw.replace(/[.,;:!]+$/, '');
    try {
      const h = new URL(u);
      if (h.protocol === 'https:' && /(^|\.)bancointer\.com\.br$/i.test(h.hostname) && /avaliacao|laudo/i.test(h.hostname + h.pathname)) return u;
    } catch { /* URL inválida */ }
  }
  return null;
}

/** Tipo do e-mail, pelo assunto e pelo começo do texto NOVO (sem a conversa citada). Pura (testável). */
export function classifyInterEmail(subject: string | null | undefined, freshText: string): InterEmailKind {
  const s = cleanSubject(subject);
  if (/resposta autom[aá]tica|out of office|fora do escrit[oó]rio/i.test(s)) return 'OUTRO';
  if (/vistoria|laudo|engenheir|avalia[cç][aã]o do im[oó]vel/i.test(freshText)) return 'VISTORIA';
  if (/engajamento/i.test(s)) return 'ENGAJAMENTO';
  if (/pend[eê]ncia|falta(m)?|document|matr[ií]cula atualizada|regulariz/i.test(freshText)) return 'PENDENCIA';
  return 'OUTRO';
}

/** Só o texto NOVO da mensagem (corta a conversa citada). Pura (testável). */
export function freshPart(text: string | null | undefined): string {
  const t = String(text || '').replace(/\r/g, '');
  const cut = t.search(/\n\s*(Em .{5,80}escreveu:|On .{5,80}wrote:|De:\s|From:\s|-{3,}\s*(Mensagem|Original)|>{1}\s)/i);
  return (cut > 0 ? t.slice(0, cut) : t).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

const KIND_LABEL: Record<InterEmailKind, string> = { ENGAJAMENTO: 'Engajamento (consultor designado)', VISTORIA: 'Vistoria', PENDENCIA: 'Pendência', OUTRO: 'Mensagem' };

export type LeadCandidate = { id: string; name: string | null; p1: string | null; p2: string | null; cpf1: string | null; cpf2: string | null; proposta: string | null; inter: boolean; interRecent: boolean };
export type InterSignals = { proposta: string | null; cpfs: string[]; nomes: string[] };

const NOME_PARADO = /^(HOME EQUITY|ENGAJAMENTO AUTOMATICO|CORRESPONDENTE BANCARIO|FINANCIAMENTO|PROPOSTA|CLIENTE|INTER|URGENTE|VISTORIA|RE|ENC|FWD|DUVIDA|ASSUNTO)$/;
const tokens = (s: string) => norm(s).split(' ').filter((t) => t.length > 1);

/** Pistas pra achar o cliente: nº da proposta, CPF e NOMES (pode vir só o primeiro nome, ou nome e sobrenome, ou o nome completo). Pura (testável). */
export function extractInterSignals(subject: string | null | undefined, text: string | null | undefined): InterSignals {
  const sub = cleanSubject(subject);
  const body = String(text || '').replace(/\r/g, ' ');
  const ps = parseInterSubject(subject), pb = parseInterBody(body);
  const nomes = new Set<string>();
  if (ps.nome) nomes.add(ps.nome);
  if (pb.nome) nomes.add(pb.nome);
  // último pedaço do assunto, se for só letras: "Home Equity - PEDRO", "Vistoria - Pedro Paiva"
  const ult = sub.split(/\s+[-–]\s+/).pop() || '';
  if (/^[A-Za-zÀ-ÿ' ]{3,60}$/.test(ult) && !NOME_PARADO.test(norm(ult))) nomes.add(ult.trim());
  // "seu cliente Sérgio", "do cliente Pedro Paiva" (palavras com inicial maiúscula)
  for (const m of body.matchAll(/cliente\s+([A-ZÀ-Ý][a-zà-ÿ']+(?:\s+(?:d[aeo]s?\s+)?[A-ZÀ-Ý][a-zà-ÿ']+){0,4})/g)) nomes.add(m[1].trim());
  const cpfs = [...new Set((body.match(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g) || []).map((c) => c.replace(/\D/g, '')))];
  return { proposta: ps.proposta || pb.proposta, cpfs, nomes: [...nomes].filter((n) => tokens(n).length >= 1 && !NOME_PARADO.test(norm(n))) };
}

/** Escolhe o card entre os candidatos. Nunca adivinha: se sobrar mais de um, devolve a lista (a equipe liga à mão). Pura (testável). */
export function pickLead(cands: LeadCandidate[], sig: InterSignals): { id: string | null; ambiguous: string[] } {
  const nomeDe = (c: LeadCandidate) => [c.name, c.p1, c.p2].filter(Boolean) as string[];
  const unico = (xs: LeadCandidate[]) => (xs.length === 1 ? { id: xs[0].id, ambiguous: [] as string[] } : null);
  const nomes = (xs: LeadCandidate[]) => xs.map((c) => c.name || c.p1 || c.id).slice(0, 5);
  // 1) nº da proposta (sem zeros à esquerda)
  if (sig.proposta) {
    const hit = cands.filter((c) => c.proposta && stripZeros(c.proposta) === sig.proposta);
    const u = unico(hit); if (u) return u;
    if (hit.length > 1) return { id: null, ambiguous: nomes(hit) };
  }
  // 2) CPF no texto
  if (sig.cpfs.length) {
    const hit = cands.filter((c) => [c.cpf1, c.cpf2].some((x) => x && sig.cpfs.includes(String(x).replace(/\D/g, ''))));
    const u = unico(hit); if (u) return u;
  }
  // 3) nome: o do e-mail precisa começar igual (1º nome) e todas as palavras dele estarem no nome do card — serve pra "PEDRO", "Pedro Paiva" ou o nome inteiro
  let melhor: LeadCandidate[] = [];
  let ambiguo: LeadCandidate[] = [];
  for (const nm of sig.nomes) {
    const st = tokens(nm);
    if (!st.length) continue;
    let hit = cands.filter((c) => nomeDe(c).some((n) => { const ct = tokens(n); return ct.length > 0 && ct[0] === st[0] && st.every((t) => ct.includes(t)); }));
    if (st.length === 1) hit = hit.filter((c) => c.inter); // só o primeiro nome: só entre quem tem a ver com o Inter
    if (hit.length > 1) { const rec = hit.filter((c) => c.interRecent); if (rec.length >= 1) hit = rec; }
    if (hit.length === 1) { if (st.length >= 2 || !melhor.length) melhor = hit; if (st.length >= 2) break; }
    else if (hit.length > 1 && !ambiguo.length) ambiguo = hit;
  }
  if (melhor.length === 1) return { id: melhor[0].id, ambiguous: [] };
  return { id: null, ambiguous: nomes(ambiguo) };
}

async function loadCandidates(accountId: string): Promise<LeadCandidate[]> {
  return prisma.$queryRaw<LeadCandidate[]>`
    SELECT l.id, l.name, l."customFields"->>'participante_1' AS p1, l."customFields"->>'participante_2' AS p2,
           l."customFields"->>'cpf_1' AS cpf1, l."customFields"->>'cpf_2' AS cpf2, l."customFields"->>'num_proposta' AS proposta,
           (coalesce(l."customFields"->>'instituicao', '') ILIKE '%inter%' OR coalesce(l."customFields"->>'num_proposta', '') <> ''
             OR EXISTS (SELECT 1 FROM "CreditAnalysis" ca WHERE ca."leadId" = l.id AND ca.bank = 'INTER')) AS inter,
           EXISTS (SELECT 1 FROM "CreditAnalysis" ca WHERE ca."leadId" = l.id AND ca.bank = 'INTER' AND ca."createdAt" > now() - interval '30 days' AND ca.status IN ('APPROVED', 'CONDITIONAL', 'SENT', 'CHECK')) AS "interRecent"
    FROM "Lead" l WHERE l."accountId" = ${accountId} AND l.archived = false AND l.status = 'OPEN' AND l."isGroup" = false`;
}

/** Chamado pelo leitor de e-mail para cada e-mail NOVO do Inter. Devolve true se ligou a um card. */
export async function handleInterEmail(acc: { accountId: string }, row: { id: string; subject: string | null; textBody: string | null; htmlBody?: string | null; fromAddress?: string | null; date?: Date }, io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } }): Promise<boolean> {
  const subject = row.subject || '';
  const text = row.textBody || String(row.htmlBody || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const fresh = freshPart(text);
  const kind = classifyInterEmail(subject, fresh);
  if (kind === 'OUTRO' && !/\d{5,10}\s*[-–]/.test(cleanSubject(subject)) && !parseInterBody(text).proposta) return false; // alinhamento semanal, newsletter etc.
  const sig = extractInterSignals(subject, text); // o assunto às vezes vem só "Home Equity - PEDRO"; nº da proposta/nome completo/CPF podem estar no texto citado
  if (!sig.proposta && !sig.cpfs.length && !sig.nomes.length) return false;
  const achou = pickLead(await loadCandidates(acc.accountId), sig);
  if (!achou.id) {
    if (achou.ambiguous.length > 1 && kind !== 'OUTRO') { // o Inter escreveu, mas há mais de um card possível: avisa a equipe pra ligar à mão (nunca adivinha)
      try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(acc.accountId, { title: `📬 Inter — ${KIND_LABEL[kind]}: qual cliente?`, body: `"${sig.nomes[0] || subject}" pode ser: ${achou.ambiguous.join(' / ')}` }).catch(() => {}); } catch { /* aviso */ }
    }
    return false;
  }
  const leadId = achou.id;
  const alvo = { proposta: sig.proposta };
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true } });
  if (!lead) return false;

  // liga SÓ este e-mail ao card (aparece na conversa dele)
  await prisma.emailMessage.update({ where: { id: row.id }, data: { leadId } }).catch(() => {});
  const resumo = fresh.replace(/\s+/g, ' ').slice(0, 420);
  const quem = row.fromAddress ? ` (${row.fromAddress})` : '';
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📬 E-mail do Inter — ${KIND_LABEL[kind]}${alvo.proposta ? `, proposta ${alvo.proposta}` : ''}${quem}:\n${resumo}${fresh.length > 420 ? '…' : ''}` } }).catch(() => {});
  try {
    (require('./push.service') as typeof import('./push.service')).sendPushToAccount(acc.accountId, { title: `📬 Inter — ${KIND_LABEL[kind]}`, body: `${lead.name}: ${resumo.slice(0, 110)}`, leadId }).catch(() => {});
  } catch { /* push é só aviso */ }
  // Link do laudo digital (apartamento): guarda no card — a extensão "Vistoria Inter" abre exatamente esse link.
  const link = extractLaudoLink(fresh) || extractLaudoLink(text);
  if (link) {
    const cur = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const cfAtual = (cur?.customFields || {}) as Record<string, any>;
    if (cfAtual.link_laudo_inter !== link) {
      await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cfAtual, link_laudo_inter: link } } });
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔗 Link do laudo digital recebido do Inter e guardado no card (campo "Link do laudo Inter"): ${link}` } }).catch(() => {});
    }
  }
  io?.to(`account_${acc.accountId}`).emit('lead_updated', { leadId });
  return true;
}
