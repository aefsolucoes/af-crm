import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp } from './message.service';
import { logActivity } from './activity.service';

type Io = any;

/** PROPOSTA DE NOVO DE QUEM JÁ ESTÁ ADIANTADO (Fabio 08/11, Juan José — em Vistoria do Imóvel, preencheu a proposta no site de novo pra ver se a CAIXA/Inter saía mais
 *  barato): "quando isso acontecer, o CRM deve ler toda a conversa e avisar ao cliente em que etapa estamos" — com a IA do card ligada OU desligada.
 *  advanceLeadOnProposalForm marca `_propostaAdiante` (card adiante da Pré-Análise: ele fica onde está). Este poller (1 min, laço do credit-auto) espera o cliente parar de
 *  escrever (costuma mandar um áudio logo depois), lê a conversa inteira e conta a etapa. Não manda se a equipe já respondeu depois da proposta, com STOP total ou com a
 *  janela de 24 h fechada — nesses casos fica só a nota. */

const ESPERA_MS = 90_000;
const SILENCIO_MS = 60_000;
const VALIDADE_MS = 6 * 3_600_000;
const WINDOW_MS = 23 * 3_600_000;

const SYSTEM = `Você escreve UMA mensagem de WhatsApp de uma correspondente de crédito (Home Equity — empréstimo com imóvel em garantia — e financiamento imobiliário) pra um cliente que JÁ ESTÁ ADIANTADO no processo e acabou de preencher a proposta no site de novo. Leia a conversa INTEIRA e diga a ele, com clareza, em que etapa o processo dele está agora e qual é o próximo passo. Responda SÓ com JSON: {"mensagem":"<texto>"}
Regras:
- Fale como a consultora, usando "a gente"/"nós" (nunca o nome da empresa). Português do Brasil, tom de conversa, curto (2 a 4 frases), sem markdown, no máximo 1 emoji.
- Cumprimente pelo nome (COMO CHAMAR, se houver) e deixe claro que ele não precisa preencher a proposta de novo: o processo dele já está andando.
- A etapa vem do card (ETAPA ATUAL) e da conversa: diga o que já foi feito (ex.: crédito aprovado no banco tal, documentação recebida, vistoria solicitada) e o que falta agora — só o que o card e a conversa mostram. Nunca invente data, prazo, valor, taxa ou nome de empresa.
- Se ele perguntou ou pediu algo junto com a proposta (outro banco, taxa menor, outro valor…), NÃO responda nem prometa nada: diga em 1 frase que a gente vê isso e responde por aqui.
- Não peça documento, não fale de reprovação, não cite comissão nem nome de alguém da equipe.`;

/** Marca o card (só a 1ª proposta da rajada — o e-mail e o WhatsApp da mesma proposta chegam com segundos de diferença). */
export async function marcarPropostaAdiante(leadId: string): Promise<void> {
  const agora = new Date().toISOString();
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_propostaAdiante}', to_jsonb(${agora}::text), true) WHERE id = ${leadId} AND COALESCE("customFields"->>'_propostaAdiante', '') = ''`;
}

/** Aviso de etapa pendente: a IA da conversa não responde à proposta (o aviso responde). */
export async function temPropostaAdiante(leadId: string): Promise<boolean> {
  const r = await prisma.$queryRaw<{ m: string | null }[]>`SELECT "customFields"->>'_propostaAdiante' AS m FROM "Lead" WHERE id = ${leadId}`;
  return !!r[0]?.m;
}

async function nota(leadId: string, content: string): Promise<void> {
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
}

async function conversa(leadId: string): Promise<string> {
  const msgs = await prisma.message.findMany({
    where: { leadId, deleted: false, content: { not: '' } },
    orderBy: { createdAt: 'desc' }, take: 80,
    select: { direction: true, channel: true, content: true, createdAt: true },
  });
  return msgs.reverse().map((m) => `[${m.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}] ${m.direction === 'INBOUND' ? 'Cliente' : 'Nós'}${m.channel === 'EMAIL' ? ' (e-mail)' : ''}: ${m.content.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n');
}

async function escrever(contexto: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 4096 /* o raciocínio conta nesse limite */, system: SYSTEM, messages: [{ role: 'user', content: contexto }] }),
  }).catch(() => null);
  if (!res || !res.ok) {
    if (res) console.error('[Proposta adiante] Erro Anthropic:', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[] } | null;
  try {
    const j = JSON.parse((data?.content?.find((b) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || '{}');
    const m = String(j.mensagem ?? '').trim();
    return m.length >= 20 ? m.slice(0, 900) : null;
  } catch { return null; }
}

async function avisar(accountId: string, leadId: string, marca: string, io?: Io): Promise<void> {
  const desde = Date.parse(marca);
  const velha = !(desde > 0) || Date.now() - desde > VALIDADE_MS;
  if (!velha) {
    if (Date.now() - desde < ESPERA_MS) return;
    const ultima = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (ultima && Date.now() - ultima.createdAt.getTime() < SILENCIO_MS) return; // ainda escrevendo
  }
  const tirou = await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_propostaAdiante' WHERE id = ${leadId} AND "customFields"->>'_propostaAdiante' = ${marca}`;
  if (!tirou || velha) return;

  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { name: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { name: true, stages: { orderBy: { order: 'asc' }, select: { name: true } } } } },
  });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const etapa = `${lead.pipeline?.name || '?'} → ${lead.stage?.name || '?'}`;
  const cab = `📍 O cliente preencheu a proposta de novo já em "${etapa}"`;
  if (cf._autoPaused) { await nota(leadId, `${cab}: não avisei a etapa (cliente em STOP total).`); return; }
  const equipe = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', channel: 'WHATSAPP', sentByUserId: { not: null }, createdAt: { gt: new Date(desde) } }, select: { id: true } });
  if (equipe) { await nota(leadId, `${cab}: a equipe já respondeu depois da proposta, então não mandei o aviso de etapa.`); return; }
  const lastWa = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (!lastWa || Date.now() - lastWa.createdAt.getTime() > WINDOW_MS) { await nota(leadId, `${cab}: a janela de 24 h do WhatsApp está fechada, então não avisei a etapa — avise por template se precisar.`); return; }

  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const chamar = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name);
  const contexto = `Cliente: ${lead.name}\nCOMO CHAMAR: ${chamar || '(sem nome)'}\nETAPA ATUAL do card: funil "${lead.pipeline?.name}" → etapa "${lead.stage?.name}"\nEtapas desse funil, em ordem: ${(lead.pipeline?.stages || []).map((s) => s.name).join(' → ')}\n\nCONVERSA (mais antigas primeiro):\n${await conversa(leadId)}`;
  const texto = await escrever(contexto);
  if (!texto) { await nota(leadId, `${cab}: não consegui escrever o aviso de etapa (IA fora do ar) — avise o cliente em que etapa estamos.`); return; }
  const sent = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io: io || undefined });
  await nota(leadId, sent.success
    ? `${cab}: o CRM leu a conversa e avisou em que etapa estamos: "${texto}"`
    : `${cab}: o aviso de etapa não saiu (${(sent as any).error || 'erro'}). Texto pronto: "${texto}"`);
  if (sent.success) logActivity({ accountId, userId: null, userName: 'CRM', action: 'ai_replied', leadId, leadName: lead.name, summary: 'avisou em que etapa o processo está (o cliente preencheu a proposta de novo)' });
}

/** Poller (1 min, no laço do credit-auto). */
export async function processPropostaAdiante(accountId: string, io?: Io): Promise<void> {
  const rows = await prisma.$queryRaw<{ id: string; marca: string }[]>`
    SELECT id, "customFields"->>'_propostaAdiante' AS marca FROM "Lead"
    WHERE "accountId" = ${accountId} AND COALESCE("customFields"->>'_propostaAdiante', '') <> '' LIMIT 10`;
  for (const r of rows) await avisar(accountId, r.id, r.marca, io).catch((e) => console.error('[Proposta adiante]', e?.message));
}
