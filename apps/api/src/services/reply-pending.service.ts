import { PrismaClient } from '@prisma/client';

type Db = PrismaClient;
type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
type Sender = (p: { accountId: string; leadId: string; content: string; io?: Io }) => Promise<{ success: boolean; error?: string }>;

/**
 * Mensagens GUARDADAS pra sair quando o cliente responder (Fabio 22/10: "assim que ele responder, solicita a certidão de estado civil, diga que o banco está solicitando").
 * Serve pra quando a janela de 24 h do WhatsApp está fechada: só um template pode abrir a conversa; o que a gente QUER dizer fica aqui (customFields._replyPending) e sai na 1ª resposta.
 * Cada item tem um rótulo (evita duplicar) e o texto. Sai uma vez só; se o envio falhar, volta pra fila e tenta na próxima resposta.
 */
export type ReplyPending = { label: string; text: string; at: string };

const note = (db: Db, leadId: string, content: string) => db.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});

export async function queueOnReply(db: Db, p: { leadId: string; label: string; text: string; noteText?: string }): Promise<boolean> {
  const l = await db.lead.findUnique({ where: { id: p.leadId }, select: { customFields: true } });
  if (!l) throw new Error('Card não encontrado');
  const cf = (l.customFields || {}) as Record<string, any>;
  const fila: ReplyPending[] = Array.isArray(cf._replyPending) ? cf._replyPending : [];
  if (fila.some((x) => x.label === p.label)) return false; // já está na fila
  fila.push({ label: p.label, text: p.text, at: new Date().toISOString() });
  await db.lead.update({ where: { id: p.leadId }, data: { customFields: { ...cf, _replyPending: fila } } });
  await note(db, p.leadId, p.noteText || `⏳ Mensagem guardada pra enviar assim que o cliente responder (${p.label}).`);
  return true;
}

/** O cliente respondeu: envia o que estava guardado (na ordem). Devolve quantas mensagens saíram. */
export async function releaseOnReply(db: Db, p: { accountId: string; leadId: string; io?: Io; sender?: Sender }): Promise<number> {
  const l = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { customFields: true } });
  const cf = (l?.customFields || {}) as Record<string, any>;
  const fila: ReplyPending[] = Array.isArray(cf._replyPending) ? cf._replyPending : [];
  if (!fila.length) return 0;
  const { _replyPending, ...rest } = cf; // tira a fila ANTES de mandar: duas respostas seguidas não duplicam
  await db.lead.update({ where: { id: p.leadId }, data: { customFields: rest as any } });
  const sender: Sender = p.sender || (async (x) => (require('./message.service') as typeof import('./message.service')).sendOutboundWhatsApp({ accountId: x.accountId, leadId: x.leadId, content: x.content, io: x.io as any }) as any);
  let enviadas = 0; const falhas: ReplyPending[] = [];
  for (const item of fila) {
    const r = await sender({ accountId: p.accountId, leadId: p.leadId, content: item.text, io: p.io });
    if (r.success) { enviadas++; await note(db, p.leadId, `📨 O cliente respondeu: enviei a mensagem guardada (${item.label}).`); }
    else { falhas.push(item); await note(db, p.leadId, `⚠️ O cliente respondeu, mas não consegui enviar a mensagem guardada (${item.label}): ${r.error || 'erro'}. Tento de novo na próxima resposta.`); }
    if (fila.length > 1) await new Promise((res) => setTimeout(res, 1500));
  }
  if (falhas.length) {
    const fresh = await db.lead.findUnique({ where: { id: p.leadId }, select: { customFields: true } });
    await db.lead.update({ where: { id: p.leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _replyPending: falhas } } });
  }
  return enviadas;
}
