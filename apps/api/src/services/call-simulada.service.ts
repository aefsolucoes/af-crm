import { prisma, LIGACAO_TESTE_PREFIXO } from '../lib/prisma';
import { sendPushToAccount } from './push.service';

/* LIGAÇÃO RECEBIDA DE TESTE (Fabio 21/11: "quero que seja um card real, apenas uma simulação, colocando o CRM para tocar" — "só para Fabio";
 * "não precisa falar nada, apenas tocar até atender, quando atender, desliga").
 * O CRM toca como se o cliente do card estivesse ligando — a tela de ligação recebida só nas telas de quem disparou (administrador). O LEMBRETE (push "Ligação recebida"
 * no celular) vai pra EQUIPE TODA e aparece 2 vezes, com 10 s de intervalo (Fabio 21/11: "pode mostrar o lembrete para todos, mostra ele umas 2x na tela do celular" —
 * "somente o lembrete": a tela de ligação continua só pra ele).
 * Nada vai pra Meta nem pro cliente e não cria registro de ligação (Call) — assim a "perdida" nunca manda o "vi sua ligação" pro cliente.
 * Fica registrada na conversa do card como uma ligação de verdade ("não deixe de registrar a ligação no inbox do cliente", "como se fosse uma ligação real") e numa
 * nota; as regras automáticas e a IA não a enxergam (lib/prisma: SEM_LIGACAO_TESTE). Atender ou recusar encerra; ninguém atendendo em 60 s, encerra sozinha. */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
export type LigacaoSimulada = { callId: string; waCallId: string; leadId: string; leadName: string; contactPhone: string; sdp: string; simulado: true };
type Ativa = { payload: LigacaoSimulada; accountId: string; userId: string; timer: ReturnType<typeof setTimeout>; inicio: number };

const TOCA_MS = 60_000;
const LEMBRETE_DE_NOVO_MS = 10_000;
/** Uma por usuário (a nova substitui a anterior). */
const ativas = new Map<string, Ativa>();

export async function simularLigacaoRecebida(accountId: string, userId: string, leadId: string, io: Io): Promise<LigacaoSimulada | null> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, contact: { select: { name: true, phone: true } } } });
  if (!lead) return null;
  const anterior = ativas.get(userId);
  if (anterior) await encerrarLigacaoSimulada(userId, anterior.payload.waCallId, 'Ligação de teste substituída', io);
  const waCallId = `${LIGACAO_TESTE_PREFIXO}${Date.now().toString(36)}`;
  const leadName = lead.contact?.name || lead.name;
  const payload: LigacaoSimulada = { callId: waCallId, waCallId, leadId, leadName, contactPhone: String(lead.contact?.phone || ''), sdp: '', simulado: true };
  const timer = setTimeout(() => { encerrarLigacaoSimulada(userId, waCallId, 'Ligação de teste não atendida', io).catch(() => {}); }, TOCA_MS);
  ativas.set(userId, { payload, accountId, userId, timer, inicio: Date.now() });
  // Na conversa do card, igual à ligação recebida de verdade ("📞 Ligação de voz" chamando). Já lida: a equipe não ganha "não lida" de um teste.
  const msg = await prisma.message.create({
    data: { content: '📞 Ligação de voz', direction: 'INBOUND', channel: 'WHATSAPP', leadId, callWaCallId: waCallId, callStatus: 'RINGING', status: 'DELIVERED', read: true },
    include: { attachments: true },
  }).catch((e) => { console.error('[Ligação de teste] mensagem na conversa:', e?.message); return null; });
  if (msg) io?.to(`lead:${leadId}`).emit('new_message', msg);
  io?.to(`user_${userId}`).emit('incoming_call', payload);
  const lembrete = { title: 'Ligação recebida', body: leadName, leadId, type: 'call' as const };
  sendPushToAccount(accountId, lembrete).catch(() => {});
  setTimeout(() => { if (ativas.get(userId)?.payload.waCallId === waCallId) sendPushToAccount(accountId, lembrete).catch(() => {}); }, LEMBRETE_DE_NOVO_MS);
  console.log(`[Ligação de teste] tocando pro usuário ${userId.slice(-6)} com o card ${leadId}`);
  return payload;
}

/** A que está tocando pra este usuário (a tela que abre depois — ex.: o celular aberto pelo push — também mostra). */
export function ligacaoSimuladaAtiva(userId: string): LigacaoSimulada | null {
  return ativas.get(userId)?.payload || null;
}

/** Atendeu, recusou ou passou do tempo: para de tocar em todas as telas e troca o push "tocando" por um aviso mudo. */
export async function encerrarLigacaoSimulada(userId: string, waCallId: string, motivo: string, io: Io): Promise<boolean> {
  const a = ativas.get(userId);
  if (!a || a.payload.waCallId !== waCallId) return false;
  clearTimeout(a.timer);
  ativas.delete(userId);
  io?.to(`user_${userId}`).emit('call_ended', { waCallId });
  // Resultado na conversa (igual à de verdade) + nota no card dizendo que foi teste.
  const atendida = /atendida/.test(motivo) && !/n[aã]o atendida/.test(motivo);
  const recusada = /recusada/.test(motivo);
  const callStatus = atendida ? 'ENDED' : recusada ? 'REJECTED' : 'MISSED';
  const content = atendida ? '📞 Ligação de voz encerrada' : recusada ? '📞 Ligação de voz recusada' : '📞 Ligação de voz perdida';
  const n = await prisma.message.updateMany({ where: { callWaCallId: waCallId }, data: { callStatus, callDurationSec: 0, content } }).catch(() => ({ count: 0 }));
  if (n.count) {
    const upd = { waCallId, callStatus, callDurationSec: 0, content };
    io?.to(`lead:${a.payload.leadId}`).emit('call_message_updated', upd);
    io?.to(`account_${a.accountId}`).emit('call_message_updated', upd);
  }
  const quem = (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }).catch(() => null))?.name || 'administrador';
  const resultado = atendida ? `atendida por ${quem} e desligada` : recusada ? `recusada por ${quem}` : 'ninguém atendeu em 60 s';
  await prisma.note.create({ data: { leadId: a.payload.leadId, type: 'CALL', userId, content: `📞 Ligação de TESTE recebida (simulada pelo CRM, ${quem}) — ${resultado}. O cliente não ligou e nada foi pra Meta nem pro cliente.` } }).catch(() => {});
  // O lembrete foi pra equipe toda: o "tocando" sai de todos os celulares.
  await sendPushToAccount(a.accountId, { title: a.payload.leadName, body: motivo, leadId: a.payload.leadId, type: 'call_cancel' }).catch(() => {});
  console.log(`[Ligação de teste] ${motivo} (usuário ${userId.slice(-6)})`);
  return true;
}

/** LEMBRETE DA ÚLTIMA LIGAÇÃO do card, sem tocar (Fabio 21/11: "não precisa tocar, apenas aparece o lembrete da última ligação, 2x" — "pode mostrar o lembrete para
 *  todos"): push comum (aparece na tela, no celular e na sineta) pra equipe toda, 2 vezes com 10 s de intervalo. Texto só "📞 Ligação recebida — NOME · 21/11 às 23:38 · encerrada" (Fabio 21/11: "apenas assim" — sem "(teste)"). */
export async function lembreteUltimaLigacao(accountId: string, leadId: string): Promise<{ title: string; body: string } | null> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, contact: { select: { name: true } } } });
  if (!lead) return null;
  const m = await prisma.message.findFirst({ where: { leadId, callWaCallId: { not: null } }, orderBy: { createdAt: 'desc' }, select: { content: true, createdAt: true, direction: true, callWaCallId: true } });
  if (!m) return null;
  const hora = new Date(m.createdAt.getTime() - 3 * 3_600_000).toISOString().slice(11, 16);
  const dia = new Date(m.createdAt.getTime() - 3 * 3_600_000).toISOString().slice(5, 10).split('-').reverse().join('/');
  const resultado = String(m.content || '').replace(/^📞\s*Ligação de voz\s*/i, '').replace(/^—\s*/, '') || 'chamando';
  const title = `📞 ${m.direction === 'INBOUND' ? 'Ligação recebida' : 'Ligação feita'} — ${lead.contact?.name || lead.name}`.slice(0, 90);
  const body = `${dia} às ${hora} · ${resultado}`.slice(0, 140);
  await sendPushToAccount(accountId, { title, body, leadId });
  setTimeout(() => { sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); }, 10_000);
  return { title, body };
}
