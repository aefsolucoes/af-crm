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

async function findLeadId(accountId: string, p: { proposta: string | null; nome: string | null; subject: string }): Promise<string | null> {
  if (p.proposta) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false AND regexp_replace(coalesce("customFields"->>'num_proposta', ''), '^0+', '') = ${p.proposta} LIMIT 3`;
    if (rows.length === 1) return rows[0].id;
    if (rows.length > 1) return null; // mais de um card com a mesma proposta: não adivinha
  }
  // pelo nome (assunto): nome completo do card ou do participante 1/2
  const cands = await prisma.$queryRaw<{ id: string; name: string | null; p1: string | null; p2: string | null }[]>`SELECT id, name, "customFields"->>'participante_1' AS p1, "customFields"->>'participante_2' AS p2 FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false AND status = 'OPEN' AND "isGroup" = false`;
  const subj = norm(cleanSubject(p.subject));
  const alvo = p.nome ? norm(p.nome) : '';
  const hits = new Set<string>();
  for (const c of cands) {
    for (const nm of [c.name, c.p1, c.p2]) {
      const n = norm(nm || '');
      if (n.split(' ').length < 2 || n.length < 9) continue; // nome curto demais: não arrisca
      if ((alvo && n === alvo) || (!alvo && subj.includes(n))) hits.add(c.id);
    }
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/** Chamado pelo leitor de e-mail para cada e-mail NOVO do Inter. Devolve true se ligou a um card. */
export async function handleInterEmail(acc: { accountId: string }, row: { id: string; subject: string | null; textBody: string | null; htmlBody?: string | null; fromAddress?: string | null; date?: Date }, io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } }): Promise<boolean> {
  const subject = row.subject || '';
  const text = row.textBody || String(row.htmlBody || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  const fresh = freshPart(text);
  const kind = classifyInterEmail(subject, fresh);
  if (kind === 'OUTRO' && !/\d{5,10}\s*[-–]/.test(cleanSubject(subject))) return false; // alinhamento semanal, newsletter etc.
  const parsed = parseInterSubject(subject);
  if (!parsed.proposta && !parsed.nome && !/[A-Za-zÀ-ÿ]{3,}\s+[A-Za-zÀ-ÿ]{3,}/.test(cleanSubject(subject))) return false;
  const leadId = await findLeadId(acc.accountId, { ...parsed, subject });
  if (!leadId) return false;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true } });
  if (!lead) return false;

  // liga SÓ este e-mail ao card (aparece na conversa dele)
  await prisma.emailMessage.update({ where: { id: row.id }, data: { leadId } }).catch(() => {});
  const resumo = fresh.replace(/\s+/g, ' ').slice(0, 420);
  const quem = row.fromAddress ? ` (${row.fromAddress})` : '';
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📬 E-mail do Inter — ${KIND_LABEL[kind]}${parsed.proposta ? `, proposta ${parsed.proposta}` : ''}${quem}:\n${resumo}${fresh.length > 420 ? '…' : ''}` } }).catch(() => {});
  try {
    (require('./push.service') as typeof import('./push.service')).sendPushToAccount(acc.accountId, { title: `📬 Inter — ${KIND_LABEL[kind]}`, body: `${lead.name}: ${resumo.slice(0, 110)}`, leadId }).catch(() => {});
  } catch { /* push é só aviso */ }
  io?.to(`account_${acc.accountId}`).emit('lead_updated', { leadId });
  return true;
}
