import { prisma } from '../lib/prisma';

/* BANCOS COMBINADOS ANTES DA PROPOSTA (Fabio 30/10, Marco Antonio: recusou o crédito porque "as taxas estão atreladas ao IPCA"; a IA respondeu que "Santander, Bradesco e CAIXA
 * trabalham com taxa fixa mensal… quer que eu encaminhe sua proposta considerando esses bancos?" e ele topou → "quando a proposta chegar, rodar apenas nos bancos que o próprio CRM
 * informou. Inclusive pedir documentação pra rodar na CAIXA").
 * Na entrada da análise automática a IA lê a conversa ANTES da proposta. Se nós combinamos bancos específicos com o cliente (ou ele recusou algum e a gente concordou):
 *  - `_bancosFora` recebe os bancos automáticos (Inter, Creditas, Santander) que ficaram de fora — nenhum caminho automático roda neles (createRequests);
 *  - CAIXA combinada → a documentação da CAIXA é pedida ao cliente (nome limpo + Habite-se + documentos), a IA da conversa segue a sequência e a ficha entra na fila da CAIXA;
 *  - banco que o CRM não roda sozinho no Home Equity (Bradesco, Itaú, BRB…) → nota + push pra equipe rodar à mão.
 * Estado no card: `_bancosCombinados` = { bancos, fora, caixa, manuais, motivo, at, caixaPedidoAt?, caixaEsperaResposta?, negAvisadoAt? }. */

type Cf = Record<string, any>;
const AUTO: Record<string, string> = { INTER: 'INTER', CREDITAS: 'CREDITAS', SANTANDER: 'CREDIMORAR' };
const NOMES: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', SANTANDER: 'Santander', CAIXA: 'CAIXA', BRADESCO: 'Bradesco', ITAU: 'Itaú', BRB: 'BRB', C6: 'C6 Bank', BARI: 'Banco Bari', CASHME: 'CashMe' };
const CANON = Object.keys(NOMES);
const GREETING_TEMPLATE = 'ola_tudo_bem';
const BANCO_RX = /santander|bradesco|caixa|\binter\b|creditas|ita[uú]|\bbrb\b|\bc6\b|bari|cashme|ipca|taxa fixa|juros? fixo/i;

export type Combinado = { bancos: string[]; fora: string[]; caixa: boolean; manuais: string[]; motivo: string; at: string; caixaPedidoAt?: string; caixaEsperaResposta?: boolean; negAvisadoAt?: string };

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => {
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ }
};
const nomes = (xs: string[]) => xs.map((b) => NOMES[b] || b).join(', ');

async function salvar(leadId: string, patch: Cf) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Cf), ...patch } as any } });
}

/** Lê a conversa antes da proposta e grava o que foi combinado. null = nada combinado (roda os bancos de sempre); 'ERRO' = a leitura falhou (tenta na próxima volta). Uma leitura por card. */
export async function detectarBancosCombinados(leadId: string, proposalMarkers: string[]): Promise<Combinado | null | 'ERRO'> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  if (cf._bancosCombinados) return cf._bancosCombinados as Combinado;
  if (cf._bancosCombinadosLidoAt) return null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const proposta = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', OR: proposalMarkers.map((m) => ({ content: { contains: m } })) }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  const ate = proposta?.createdAt || new Date();
  const antes = await prisma.message.findMany({
    where: { leadId, createdAt: { lt: ate, gt: new Date(ate.getTime() - 30 * 86_400_000) } },
    orderBy: { createdAt: 'desc' }, take: 24, select: { direction: true, content: true, sentByUserId: true },
  });
  // Template de boas-vindas ("Bancos parceiros: BRB, CAIXA, Itaú…"), e-mails automáticos e propostas anteriores ("Bancos solicitados", marcação padrão do formulário) não são combinação de bancos.
  const conversa = antes.reverse().filter((m) => !/Bancos parceiros:|Bancos solicitados/i.test(m.content || '') && !String(m.content || '').startsWith('📧') && !proposalMarkers.some((k) => String(m.content || '').includes(k)));
  if (!conversa.some((m) => BANCO_RX.test(m.content || ''))) { await salvar(leadId, { _bancosCombinadosLidoAt: new Date().toISOString() }); return null; }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 1500,
      system: `Você lê a conversa de um correspondente bancário (A&F, crédito com garantia de imóvel) com o cliente ANTES de ele preencher a proposta. Decida se NÓS (A&F: atendente ou IA) combinamos com o cliente em QUAIS BANCOS a proposta seria analisada.
COMBINADO = nós dissemos que a proposta/análise seria feita com bancos ESPECÍFICOS (ex.: "quer que eu encaminhe sua proposta considerando Santander e CAIXA?") e o cliente aceitou ou seguiu em frente; OU o cliente recusou um banco ou um tipo de taxa (ex.: "não quero IPCA", "não quero o Inter") e nós concordamos em deixar de fora.
NÃO É COMBINADO: bancos marcados no formulário da proposta, lista geral de bancos parceiros, citar um banco como exemplo sem limitar a análise, o cliente só perguntar de um banco, falar de banco de um empréstimo/financiamento que ele já tem, ou nada sobre bancos. Só vale o que foi DITO na conversa.
Bancos (use estes nomes): INTER, CREDITAS, SANTANDER, CAIXA, BRADESCO, ITAU, BRB, C6, BARI, CASHME. No Home Equity o Inter cobra taxa + IPCA.
Responda SÓ JSON: {"combinado":true|false,"bancos":["…"],"recusados":["…"],"motivo":"frase curta"} — "bancos" = os que ficaram combinados pra analisar (vazio se só houve recusa); "recusados" = os que o cliente recusou ou que ficaram de fora.`,
      messages: [{ role: 'user', content: conversa.map((m) => `${m.direction === 'INBOUND' ? 'CLIENTE' : m.sentByUserId ? 'EQUIPE' : 'NÓS (IA)'}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 400)}`).join('\n') }],
    }),
  }).catch(() => null);
  if (!res?.ok) return 'ERRO'; // falhou a leitura: tenta de novo na próxima volta da análise automática
  const d: any = await res.json().catch(() => null);
  let j: any = null;
  try { j = JSON.parse(String(d?.content?.find((b: any) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || 'null'); } catch { j = null; }
  const limpa = (xs: any) => (Array.isArray(xs) ? xs : []).map((x: any) => String(x).toUpperCase().replace(/[^A-Z0-9]/g, '')).map((x: string) => (x === 'ITA' ? 'ITAU' : x)).filter((x: string) => CANON.includes(x));
  const bancos: string[] = [...new Set<string>(limpa(j?.bancos))];
  const recusados: string[] = [...new Set<string>(limpa(j?.recusados))].filter((b) => !bancos.includes(b));
  if (!j?.combinado || (!bancos.length && !recusados.length)) { await salvar(leadId, { _bancosCombinadosLidoAt: new Date().toISOString() }); return null; }
  // Com lista combinada, todo banco automático fora dela fica de fora; só com recusa, sai só o recusado.
  const foraCanon = Object.keys(AUTO).filter((b) => (bancos.length ? !bancos.includes(b) : recusados.includes(b)));
  const c: Combinado = {
    bancos, fora: foraCanon.map((b) => AUTO[b]), caixa: bancos.includes('CAIXA'),
    manuais: bancos.filter((b) => !AUTO[b] && b !== 'CAIXA'), motivo: String(j.motivo || '').slice(0, 300), at: new Date().toISOString(),
  };
  const foraAntes: string[] = Array.isArray(cf._bancosFora) ? cf._bancosFora : [];
  await salvar(leadId, { _bancosCombinados: c, _bancosFora: [...new Set([...foraAntes, ...c.fora])], _bancosCombinadosLidoAt: new Date().toISOString() });
  return c;
}

/** Texto do pedido da documentação da CAIXA (regras da CAIXA: nome limpo + Habite-se; documentação ANTES da análise). */
function textoCaixa(nome: string | null, rodando: string[]): string {
  const ja = rodando.length ? `já mandei sua proposta para análise no ${nomes(rodando)}. ` : '';
  return `${nome ? `${nome}, ` : ''}${ja}Na CAIXA a documentação é pedida antes da análise. Pra darmos entrada lá também, me confirma: seu nome está limpo (sem restrição) e o imóvel tem Habite-se? São exigências da CAIXA.\n\nSe sim, pode ir me mandando por aqui: RG e CPF, comprovante de endereço, último contracheque, certidão de estado civil (e RG e CPF do cônjuge, se tiver) e a certidão de matrícula do imóvel.`;
}

/** Pede a documentação da CAIXA: 07h–21h; conversa fechada = template "Olá, tudo bem?" e o pedido sai quando ele responder; fora do horário fica pro poller. */
export async function pedirDocsCaixa(accountId: string, leadId: string, io?: any): Promise<'ENVIADO' | 'TEMPLATE' | 'DEPOIS' | 'FALHOU'> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, aiAutoReplyActive: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const c = cf._bancosCombinados as Combinado | undefined;
  if (!lead || !c?.caixa || c.caixaPedidoAt || c.caixaEsperaResposta) return 'DEPOIS';
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!lead.aiAutoReplyActive || cf._autoPaused || !inNoticeWindow()) return 'DEPOIS';
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || null;
  const rodando = Object.keys(AUTO).filter((b) => c.bancos.includes(b));
  const texto = textoCaixa(nome, rodando);
  const msg = require('./message.service') as typeof import('./message.service');
  if (!(await whatsappWindowOpen(leadId))) {
    const t = await msg.sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: GREETING_TEMPLATE, language: 'pt_BR', bodyParams: [], previewText: 'Olá, tudo bem?', io: undefined } as any);
    if (!t.success) return 'FALHOU';
    const { queueOnReply } = require('./reply-pending.service') as typeof import('./reply-pending.service');
    await queueOnReply(prisma as any, { leadId, label: 'documentação da CAIXA', text: texto, noteText: '📨 Conversa fechada: mandei o template "Olá, tudo bem?". O pedido da documentação da CAIXA sai quando o cliente responder.' });
    await salvar(leadId, { _bancosCombinados: { ...c, caixaEsperaResposta: true } });
    return 'TEMPLATE';
  }
  const r = await msg.sendOutboundWhatsApp({ accountId, leadId, content: texto, io });
  if (!r.success) return 'FALHOU';
  await salvar(leadId, { _bancosCombinados: { ...c, caixaPedidoAt: new Date().toISOString() } });
  await note(leadId, '🏦 CAIXA combinada com o cliente antes da proposta: pedi a documentação da CAIXA (nome limpo + Habite-se + RG/CPF, comprovante de endereço, contracheque, estado civil e matrícula). Quando a ficha estiver pronta, o card entra na fila da CAIXA.');
  return 'ENVIADO';
}

/** Poller (1 min): pedidos da CAIXA que ficaram pra depois (fora do horário, IA desligada na hora). */
export async function processCaixaCombinada(accountId: string, io?: any): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_bancosCombinados'->>'caixa' = 'true'
      AND "customFields"->'_bancosCombinados'->>'caixaPedidoAt' IS NULL
      AND COALESCE("customFields"->'_bancosCombinados'->>'caixaEsperaResposta', 'false') <> 'true'
      AND "customFields"->>'_autoStartedAt' IS NOT NULL
    LIMIT 10`;
  for (const { id } of ids) await pedirDocsCaixa(accountId, id, io).catch((e: any) => console.error('[Bancos combinados] CAIXA:', e?.message));
}

/** Na entrada da análise automática: anota o combinado, avisa a equipe dos bancos que ela roda à mão e pede a documentação da CAIXA. */
export async function aplicarCombinado(accountId: string, leadId: string, leadName: string, c: Combinado, io?: any): Promise<void> {
  const rodando = Object.keys(AUTO).filter((b) => !c.fora.includes(AUTO[b]));
  const partes = [
    `🤝 Bancos combinados com o cliente ANTES da proposta: ${c.bancos.length ? nomes(c.bancos) : '—'}${c.motivo ? ` (${c.motivo})` : ''}.`,
    c.fora.length ? `Ficaram de FORA da análise automática: ${nomes(Object.keys(AUTO).filter((b) => c.fora.includes(AUTO[b])))}.` : '',
    rodando.length ? `Rodando sozinho: ${nomes(rodando)}.` : 'Nenhum banco da análise automática ficou combinado.',
    c.caixa ? 'CAIXA: vou pedir a documentação ao cliente (a CAIXA analisa só com ela).' : '',
    c.manuais.length ? `👉 ${nomes(c.manuais)}: o CRM não roda no Home Equity — rodar à mão.` : '',
  ].filter(Boolean);
  await note(leadId, partes.join(' '));
  if (c.manuais.length || c.caixa) push(accountId, `🤝 ${leadName}: bancos combinados`, [c.manuais.length ? `rodar à mão: ${nomes(c.manuais)}` : '', c.caixa ? 'CAIXA: documentação pedida' : ''].filter(Boolean).join(' · '), leadId);
  if (c.caixa) await pedirDocsCaixa(accountId, leadId, io).catch((e: any) => console.error('[Bancos combinados] CAIXA:', e?.message));
}

/** Bloco pra IA da conversa. Vazio quando não houve combinação. */
export async function aiBancosCombinadosContext(leadId: string): Promise<string> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const c = ((lead?.customFields || {}) as Cf)._bancosCombinados as Combinado | undefined;
  if (!c) return '';
  const fora = Object.keys(AUTO).filter((b) => c.fora.includes(AUTO[b]));
  return `BANCOS COMBINADOS COM O CLIENTE ANTES DA PROPOSTA (Fabio 30/10): ${c.bancos.length ? nomes(c.bancos) : 'nenhum específico'}${c.motivo ? ` — ${c.motivo}` : ''}. Fale SÓ desses bancos; ${fora.length ? `${nomes(fora)} ficou(aram) de fora e NÃO rodam (não ofereça nem cite como opção). ` : ''}${c.manuais.length ? `${nomes(c.manuais)}: a equipe roda à mão — se ele perguntar, diga que a equipe está cuidando, sem prometer prazo nem aprovação. ` : ''}${c.caixa ? `CAIXA: ${c.caixaPedidoAt ? 'a documentação da CAIXA JÁ FOI PEDIDA' : 'a documentação da CAIXA vai ser pedida'} — siga a SEQUÊNCIA DA CAIXA desde já (não espere a aprovação de outro banco e não pergunte "você realmente deseja seguir com a CAIXA?"): nome limpo e Habite-se; se os dois forem sim, receba a documentação (RG, CPF, comprovante de endereço, último contracheque, certidão de estado civil, cônjuge se tiver, certidão de matrícula do imóvel); nome com restrição ou sem Habite-se = na CAIXA essas são as regras, siga com os outros bancos combinados.` : ''}`;
}

/** Todos os bancos automáticos combinados já disseram NÃO, mas ainda há CAIXA ou banco manual: o card não fecha sozinho — a equipe é avisada uma vez. true = segurou. */
export async function segurarNegativa(accountId: string, leadId: string, leadName: string, cf: Cf): Promise<boolean> {
  const c = cf._bancosCombinados as Combinado | undefined;
  if (!c || (!c.caixa && !c.manuais.length)) return false;
  if (!c.negAvisadoAt) {
    await salvar(leadId, { _bancosCombinados: { ...c, negAvisadoAt: new Date().toISOString() } });
    const resta = [c.caixa ? 'CAIXA' : '', ...c.manuais].filter(Boolean);
    await note(leadId, `✋ Os bancos da análise automática combinados com o cliente não aprovaram, mas ainda falta ${nomes(resta)} (combinado antes da proposta). Não mandei a negativa nem fechei o card: decida com a ${nomes(resta)}.`);
    push(accountId, `✋ ${leadName}: falta ${nomes(resta)}`, 'Automáticos não aprovaram; card segurado (bancos combinados)', leadId);
  }
  return true;
}
