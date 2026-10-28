import { prisma } from '../lib/prisma';
import { buildFillableFieldsText, fillableFieldLabels, applyAiExtractedActions } from './ai-shared.service';
import { voiceNoteForAi } from './speech-to-text.service';

/* Preencher o card com os dados que o cliente manda na conversa MESMO com a IA do card desligada (Fabio 28/10: "sempre que o CRM identificar
 * dados para preenchimento no card, que ela faça — mesmo quando não estiver ligada").
 *  - IA ligada: quem preenche continua sendo a própria resposta da IA ("extractedFields" do generateAiAutoReply) — aqui não roda, pra não ler 2 vezes.
 *  - IA desligada (equipe atendendo) ou STOP TOTAL: esta leitura SÓ DE DADOS roda 20 s depois da última mensagem do cliente. Nunca responde,
 *    nunca move o card: grava os campos (mesmo caminho da IA, applyAiExtractedActions) e deixa uma anotação com o que mudou (e o valor antigo). */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

const WAIT_MS = 20_000; // o cliente costuma mandar em rajada
const timers = new Map<string, NodeJS.Timeout>();
const lastDone = new Map<string, Date>(); // última mensagem do cliente já lida, por card (memória: depois de um deploy relê a rajada uma vez)

const fmt = (v: unknown) => String(v ?? '').trim();

/** Chamado a cada mensagem do cliente: agenda a leitura (a rajada inteira sai numa leitura só). Quem decide se roda é a hora do disparo. */
export function scheduleCardFill(accountId: string, leadId: string, io?: Io): void {
  const prev = timers.get(leadId);
  if (prev) clearTimeout(prev);
  timers.set(leadId, setTimeout(() => {
    timers.delete(leadId);
    fillCardFromConversation(accountId, leadId, io).catch((e) => console.error(`[Card] preenchimento pela conversa (${leadId}):`, e?.message || e));
  }, WAIT_MS));
}

/** `dryRun`: só devolve o que leria, sem gravar nada (diagnóstico). */
export async function fillCardFromConversation(accountId: string, leadId: string, io?: Io, opts: { dryRun?: boolean } = {}): Promise<Record<string, string> | void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId, isGroup: false, archived: false },
    select: { name: true, aiAutoReplyActive: true, customFields: true },
  });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, unknown>;
  if (lead.aiAutoReplyActive && !cf._autoPaused) return; // IA ligada: ela mesma preenche ao responder

  const lastOut = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const desde = [lastOut?.createdAt, lastDone.get(leadId)].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
  const novas = await prisma.message.findMany({
    where: { leadId, direction: 'INBOUND', channel: { not: 'EMAIL' }, deleted: false, ...(desde ? { createdAt: { gt: desde } } : {}) },
    orderBy: { createdAt: 'desc' }, take: 8, select: { content: true, createdAt: true },
  });
  if (!novas.length) return;
  if (!opts.dryRun) lastDone.set(leadId, novas[0].createdAt);
  const textoNovo = [...novas].reverse().map((m) => voiceNoteForAi(m.content || '')).filter((t) => t && !/^📎/.test(t)).join('\n').trim();
  if (textoNovo.replace(/\W/g, '').length < 3) return; // só arquivo/emoji/"ok": nada pra ler

  const historico = (await prisma.message.findMany({
    where: { leadId, channel: { not: 'EMAIL' }, deleted: false }, orderBy: { createdAt: 'desc' }, take: 14, select: { direction: true, content: true },
  })).reverse().map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Atendente'}: ${voiceNoteForAi(m.content || '').slice(0, 500)}`).join('\n');

  const labels = await fillableFieldLabels(accountId);
  const noCard = [...labels.keys()].filter((k) => fmt(cf[k])).map((k) => `- "${k}": ${fmt(cf[k]).slice(0, 80)}`).join('\n') || '(nenhum)';
  const system = `Você lê a conversa de WhatsApp de um cliente da A&F Soluções Financeiras (crédito imobiliário e com garantia de imóvel) e tira dela os DADOS DO CARD que o cliente informou. Você NÃO responde ninguém: só devolve os dados.

REGRAS
- Só valores que o CLIENTE disse CLARAMENTE nas MENSAGENS NOVAS (pode ser a resposta a uma pergunta do atendente que está no histórico). Nunca invente, deduza, estime nem arredonde.
- Nunca use o que o ATENDENTE escreveu como dado do cliente.
- Participante 1 é o titular do crédito; participante 2 é o outro proponente (cônjuge, sócio). Dado de outra pessoa (vendedor, corretor, parente que não é proponente) não entra.
- CPF só com os números. Data no formato DD/MM/AAAA. Valores em reais como número puro (ex.: 5000 ou 350000).
- Não devolva campo cujo valor já é o mesmo que está no card.
- Use SÓ as chaves da lista. Se nada novo, devolva {}.

CAMPOS DO CARD (chave: o que é)
${await buildFillableFieldsText(accountId)}

Responda SOMENTE com JSON: {"extractedFields": {"chave": "valor"}}`;
  const user = `JÁ PREENCHIDO NO CARD:\n${noCard}\n\nHISTÓRICO RECENTE (contexto):\n${historico}\n\nMENSAGENS NOVAS DO CLIENTE (tire os dados daqui):\n${textoNovo}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 800, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) { console.error('[Card] leitura pela conversa — Anthropic:', res.status, (await res.text()).slice(0, 200)); return; }
  const data = await res.json() as { content: { type: string; text?: string }[] };
  const raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return;
  let got: Record<string, unknown> = {};
  try { got = (JSON.parse(json)?.extractedFields || {}) as Record<string, unknown>; } catch { return; }

  // Só chaves conhecidas e valores que de fato mudam o card.
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(got)) {
    if (!labels.has(k) || v === null || v === undefined || typeof v === 'object') continue;
    const val = fmt(v);
    if (val && val !== fmt(cf[k])) fields[k] = val;
  }
  if (!Object.keys(fields).length || opts.dryRun) return fields;

  await applyAiExtractedActions(accountId, leadId, { extractedFields: fields }, io || undefined);
  const after = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, unknown>;
  const linhas = Object.keys(fields)
    .filter((k) => fmt(after[k]) && fmt(after[k]) !== fmt(cf[k]))
    .map((k) => `- ${labels.get(k)}: ${fmt(after[k])}${fmt(cf[k]) ? ` (era ${fmt(cf[k])})` : ''}`);
  if (!linhas.length) return;
  await prisma.note.create({
    data: { leadId, type: 'DATA_EDIT', content: `🤖 Dados do card preenchidos pela conversa (IA do card ${cf._autoPaused ? 'em STOP TOTAL' : 'desligada'} — só preenchi, não respondi):\n${linhas.join('\n')}` },
  }).catch(() => {});
  if (io) io.to(`lead:${leadId}`).emit('lead_updated', { leadId });
  console.log(`[Card] ${lead.name}: preenchido pela conversa com a IA desligada (${Object.keys(fields).join(', ')})`);
}
