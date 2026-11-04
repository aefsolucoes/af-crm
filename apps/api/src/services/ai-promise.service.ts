import { prisma } from '../lib/prisma';
import { promisedAt } from './docs-checker.service';
import { sendOutboundWhatsApp } from './message.service';

type Io = any;

/** RETORNO COMBINADO (Fabio 04/11: "sempre que o CRM falar que vai entrar em contato, ele deve entrar em contato" — "qualquer etapa").
 *  Milena: às 07:32 pediu "me manda msg às 16 pra eu me lembrar", a IA respondeu "Te chamo às 16h pra lembrar" e ninguém chamou.
 *  - A IA promete voltar com hora/dia ("te chamo às 16h", "amanhã te aviso") → o CRM agenda (`_aiPromessa`).
 *  - O cliente pede pra ser chamado num horário ("me manda msg às 16", "me chama amanhã") → também agenda.
 *  - Na hora: se ninguém falou com o cliente depois disso, a IA escreve pelo motor da conversa (mesmas regras e contexto) e manda.
 *    IA desligada no card ou janela de 24 h fechada → nota + push pra equipe chamar.
 *  Sem hora/dia ("te aviso assim que o banco responder") não agenda: quem cumpre é o fluxo do próprio evento. Ligação tem o fluxo dela (equipe primeiro).
 *  Em Aguardando Documentação o pedido do cliente já vira a cobrança dos documentos (`_docsLater`): aqui não agenda de novo. */

const BRT = -3 * 3_600_000;
const WINDOW_MS = 23 * 3_600_000;
const N = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PROMESSA_RX = /\b(te (chamo|aviso|lembro|retorno|escrevo|procuro|mando (uma )?(mensagem|msg))|vou te (chamar|avisar|lembrar|retornar|escrever|procurar|mandar (uma )?(mensagem|msg))|(volto|vou voltar) a (te )?(falar|chamar|escrever)|(entro|vou entrar) em contato|falo com voce|retorno (com voce|pra voce|para voce))\b/;
const PEDIDO_RX = /\b(me (chama|chame|lembra|lembre|avisa|avise|procura|procure|escreve|escreva|manda (uma )?(msg|mensagem)|mande (uma )?(msg|mensagem))|pode me (chamar|lembrar|avisar|procurar|mandar (uma )?(msg|mensagem)))\b/;
/** Só hora/dia de verdade — "em até 48 h", "daqui uns dias" e "assim que…" não contam. */
const QUANDO_RX = /(\bas ([01]?\d|2[0-3])(\s*(h|hs|hrs?|horas?)\b|:\d{2}\b|(?=\s*($|[.,!?)]|pra |para |eu |e |que |da (tarde|manha|noite)|hoje|amanh)))|\b([01]?\d|2[0-3])h\b|\b([01]?\d|2[0-3]):[0-5]\d\b|(?<!bo)a tarde|(?<!bo)a noite|amanha|\bdia \d{1,2}\b|\b\d{1,2}\/\d{1,2}\b|\b(segunda|terca|quarta|quinta|sexta|sabado|domingo)\b|semana que vem|mais tarde|logo mais)/;

type Promessa = { at: string; frase: string; quem: 'IA' | 'CLIENTE'; setAt: string };

/** A frase da resposta da IA que promete voltar num horário (ou null). Pura (testável). */
export function promessaDaIa(reply: string): string | null {
  for (const f of String(reply || '').split(/(?<=[.!?\n])\s+/)) {
    const t = N(f);
    if (PROMESSA_RX.test(t) && QUANDO_RX.test(t)) return f.trim(); // "te chamo amanhã, tá bom?" também é promessa; "posso te chamar amanhã?" não casa
  }
  return null;
}

/** O cliente pediu pra ser chamado num horário? Pura (testável). "Me liga" fica com o fluxo de ligação. */
export function pedidoDoCliente(text: string): boolean {
  const t = N(text || '');
  return t.length <= 300 && PEDIDO_RX.test(t) && QUANDO_RX.test(t);
}

async function gravar(leadId: string, p: Promessa | null): Promise<void> {
  if (p) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_aiPromessa}', ${JSON.stringify(p)}::jsonb, true) WHERE id = ${leadId}`;
  else await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) - '_aiPromessa' WHERE id = ${leadId}`;
}

const quandoTxt = (d: Date) => d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

async function agendar(leadId: string, frase: string, quem: Promessa['quem']): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { status: true, customFields: true, stage: { select: { name: true } } } });
  if (!lead || lead.status !== 'OPEN') return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused) return;
  const now = new Date();
  const at = promisedAt(frase, now);
  if (at.getTime() <= now.getTime() + 5 * 60_000) return; // "já já": a conversa está acontecendo agora
  // A cobrança dos documentos já vai nesse horário (o cliente disse quando manda): uma mensagem só.
  const docs = cf._docsLater?.at ? Date.parse(cf._docsLater.at) : NaN;
  if (!Number.isNaN(docs) && Math.abs(docs - at.getTime()) <= 3 * 3_600_000) return;
  await gravar(leadId, { at: at.toISOString(), frase: frase.slice(0, 240), quem, setAt: now.toISOString() });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⏰ ${quem === 'IA' ? `A IA combinou de voltar a falar com o cliente ("${frase.slice(0, 160)}")` : `O cliente pediu pra ser chamado ("${frase.slice(0, 160)}")`}: o CRM chama ${quandoTxt(at)}, se ninguém falar com ele antes.` } }).catch(() => {});
}

/** Depois que a resposta da IA saiu. `pular`: o próprio fluxo já agenda (Venda Futura/Lead Sem Retorno com data, Perdido, ligação). */
export async function registrarPromessaDaIa(leadId: string, reply: string, opts: { pular?: boolean } = {}): Promise<void> {
  if (opts.pular) return;
  const frase = promessaDaIa(reply);
  if (frase) await agendar(leadId, frase, 'IA');
}

/** Texto do cliente (qualquer etapa, menos Aguardando Documentação — lá a cobrança dos documentos já cuida). */
export async function registrarPedidoDoCliente(leadId: string, text: string): Promise<void> {
  if (!pedidoDoCliente(text)) return;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { stage: { select: { name: true } } } });
  if (!lead || N(lead.stage.name).includes('aguardando documentacao')) return;
  await agendar(leadId, text.trim(), 'CLIENTE');
}

/** Poller (1 min): chama o cliente no horário combinado. */
export async function processAiPromises(accountId: string, io?: Io): Promise<void> {
  const due = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND ("customFields"->'_aiPromessa'->>'at') IS NOT NULL AND ("customFields"->'_aiPromessa'->>'at')::timestamptz <= now() LIMIT 10`;
  for (const { id } of due) {
    const lead = await prisma.lead.findUnique({ where: { id }, select: { name: true, aiAutoReplyActive: true, customFields: true } });
    const cf = (lead?.customFields || {}) as Record<string, any>;
    const p = cf._aiPromessa as Promessa | undefined;
    if (!lead || !p) continue;
    if (cf._autoPaused) { await gravar(id, null); continue; }
    const hh = new Date(Date.now() + BRT).getUTCHours();
    if (hh < 7 || hh >= 21) continue; // fora do horário: chama na primeira rodada das 07h
    // Alguém (IA, equipe, lembrete, template) já falou com o cliente depois do combinado: está cumprido.
    const depois = await prisma.message.findFirst({ where: { leadId: id, direction: 'OUTBOUND', deleted: false, createdAt: { gt: new Date(p.setAt) } }, select: { id: true } });
    if (depois) { await gravar(id, null); continue; }
    const quem = p.quem === 'IA' ? `a IA combinou ("${p.frase}")` : `o cliente pediu ("${p.frase}")`;
    const lastIn = await prisma.message.findFirst({ where: { leadId: id, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const aberta = !!lastIn && Date.now() - lastIn.createdAt.getTime() < WINDOW_MS;
    const avisaEquipe = async (motivo: string) => {
      await gravar(id, null);
      await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: `⏰ Hora de chamar o cliente: ${quem} — ${motivo}, então NÃO mandei. Chame o cliente.` } }).catch(() => {});
      try { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(accountId, { title: lead.name, body: 'Hora de chamar o cliente (combinado na conversa)', leadId: id }).catch(() => {}); } catch { /* push opcional */ }
    };
    if (!lead.aiAutoReplyActive) { await avisaEquipe('a IA está desligada neste card'); continue; }
    if (!aberta) { await avisaEquipe('a janela de 24 h do WhatsApp já fechou'); continue; }
    // Mesmo motor da conversa (regras, Base, estado do card, análises, documentos) em modo sugestão: sempre escreve e não aplica ação nenhuma.
    const { generateAiAutoReply } = require('./ai-auto-reply.service') as typeof import('./ai-auto-reply.service');
    const aviso = `[AVISO DO CRM — o cliente NÃO escreveu nada agora] Chegou a hora combinada: ${p.quem === 'IA' ? `você disse ao cliente "${p.frase}"` : `o cliente pediu "${p.frase}"`}. Escreva AGORA a mensagem que cumpre o combinado: curta (1 a 2 frases), retomando o assunto da conversa. Não diga que é mensagem automática nem que "chegou a hora combinada".`;
    const r = await generateAiAutoReply(accountId, id, aviso, [], { sugestao: true }).catch(() => null);
    const texto = (r?.reply || '').trim();
    if (!texto) { await avisaEquipe('a IA não conseguiu escrever a mensagem'); continue; }
    await gravar(id, null);
    const sent = await sendOutboundWhatsApp({ accountId, leadId: id, content: texto, io: io || undefined });
    await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: sent.success ? `⏰ Combinado cumprido: ${quem}. A IA chamou o cliente: "${texto}"` : `⏰ Hora de chamar o cliente: ${quem} — o envio falhou (${(sent as any).error || 'erro'}). Chame o cliente.` } }).catch(() => {});
  }
}
