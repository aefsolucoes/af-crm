import { prisma } from '../lib/prisma';
import { sendPushToAccount } from './push.service';

/* LIGAÇÃO RECEBIDA DE TESTE (Fabio 21/11: "quero que seja um card real, apenas uma simulação, colocando o CRM para tocar" — "só para Fabio";
 * "não precisa falar nada, apenas tocar até atender, quando atender, desliga").
 * O CRM toca como se o cliente do card estivesse ligando — a tela de ligação recebida e o push "Ligação recebida" — só nos aparelhos de quem disparou (administrador).
 * Nada vai pra Meta nem pro cliente: sem registro de ligação (Call) e sem mensagem na conversa — assim a "perdida" nunca manda o "vi sua ligação" pro cliente
 * e o histórico do card não muda. Atender ou recusar encerra; ninguém atendendo em 60 s, encerra sozinha. */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
export type LigacaoSimulada = { callId: string; waCallId: string; leadId: string; leadName: string; contactPhone: string; sdp: string; simulado: true };
type Ativa = { payload: LigacaoSimulada; accountId: string; userId: string; timer: ReturnType<typeof setTimeout> };

const TOCA_MS = 60_000;
/** Uma por usuário (a nova substitui a anterior). */
const ativas = new Map<string, Ativa>();

export async function simularLigacaoRecebida(accountId: string, userId: string, leadId: string, io: Io): Promise<LigacaoSimulada | null> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, contact: { select: { name: true, phone: true } } } });
  if (!lead) return null;
  const anterior = ativas.get(userId);
  if (anterior) await encerrarLigacaoSimulada(userId, anterior.payload.waCallId, 'Ligação de teste substituída', io);
  const waCallId = `simulada_${Date.now().toString(36)}`;
  const leadName = lead.contact?.name || lead.name;
  const payload: LigacaoSimulada = { callId: waCallId, waCallId, leadId, leadName, contactPhone: String(lead.contact?.phone || ''), sdp: '', simulado: true };
  const timer = setTimeout(() => { encerrarLigacaoSimulada(userId, waCallId, 'Ligação de teste não atendida', io).catch(() => {}); }, TOCA_MS);
  ativas.set(userId, { payload, accountId, userId, timer });
  io?.to(`user_${userId}`).emit('incoming_call', payload);
  sendPushToAccount(accountId, { title: 'Ligação recebida', body: leadName, leadId, type: 'call' }, [userId]).catch(() => {});
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
  await sendPushToAccount(a.accountId, { title: a.payload.leadName, body: motivo, leadId: a.payload.leadId, type: 'call_cancel' }, [userId]).catch(() => {});
  console.log(`[Ligação de teste] ${motivo} (usuário ${userId.slice(-6)})`);
  return true;
}
