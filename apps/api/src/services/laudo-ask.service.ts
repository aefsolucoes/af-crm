import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp } from './message.service';
import { buildLaudoJob, requestLaudo } from './vistoria-inter.service';

type Io = Parameters<typeof sendOutboundWhatsApp>[0]['io'];

/**
 * APARTAMENTO + VISTORIA DO INTER → PERGUNTAR AO CLIENTE AS "REGRINHAS" (Fabio 21/10: "sempre perguntar ao cliente, quando for apartamento e vistoria do Inter, aquelas regrinhas da vistoria pra conseguir
 * preencher sem precisar do cliente"; caso Digmar Rosolini: o Inter mandou o formulário do laudo digital e o card não tinha nenhum dado do apartamento).
 * Antes dependia da IA da conversa lembrar de perguntar. Agora é determinístico: card com vistoria do Inter em andamento (link do laudo, vistoria solicitada ou aguardando o engajamento) e imóvel APARTAMENTO
 * (campo do card ou "Tipo do imóvel" da proposta) sem as 4 informações → o CRM manda UMA mensagem com a lista; a IA da conversa registra a resposta (APARTMENT_APPRAISAL_RULES) nos campos
 * imovel_dormitorios / imovel_banheiros / imovel_suites / imovel_vagas_exclusivas. Com o card completo (e o link do laudo), o laudo entra sozinho na fila da extensão "Vistoria Inter"
 * (ela preenche e PARA na tela de conferência — quem envia é a equipe).
 */

/** Só cards que entraram no funil de contratação a partir daqui: os que já estavam em "Vistoria do Imóvel" (Digmar, Rosana…) ficam como estão (Fabio 21/10: "deixa esses como estão"). */
export const LAUDO_ASK_FROM = new Date('2026-10-21T13:00:00Z');
const asked = (cf: Record<string, any>) => !!cf._laudoAsk;
const vazio = (v: unknown) => v === undefined || v === null || String(v).trim() === '';
const CAMPOS_REGRINHAS = ['imovel_dormitorios', 'imovel_banheiros', 'imovel_suites', 'imovel_vagas_exclusivas'];

export const laudoAskText = (): string => [
  'Pra adiantar a avaliação do seu apartamento (o laudo é digital, preenchido por nós junto ao banco), preciso de 4 informações:',
  '',
  '1. Dormitórios: quantos no total (quartos + suítes), sem contar o quarto de empregada',
  '2. Banheiros: quantos no total (suítes + sociais + lavabo, e o de empregada se houver)',
  '3. Suítes: quantas — só suíte de verdade (semisuíte não conta)',
  '4. Vagas de garagem: só as de uso exclusivo — quantas e o documento/matrícula da vaga (0 se não tiver)',
  '',
  'Com isso a gente preenche tudo por você, sem precisar te incomodar de novo.',
].join('\n');

/** "Tipo do imóvel: Residencial — Apartamento" na proposta do site. Pura (testável). */
export function tipoDaProposta(texto: string): 'Apartamento' | 'Casa' | null {
  const m = /Tipo do im[oó]vel:\s*([^\n]+)/i.exec(String(texto || ''));
  if (!m) return null;
  if (/apart/i.test(m[1])) return 'Apartamento';
  if (/casa|sobrado/i.test(m[1])) return 'Casa';
  return null;
}

/** Número da proposta do Inter a partir do link do laudo (https://avaliacaoimovel.bancointer.com.br/005686174). Pura (testável). */
export function propostaDoLink(link: string): string | null {
  const m = /bancointer\.com\.br\/(\d{6,10})\b/i.exec(String(link || ''));
  return m ? m[1] : null;
}

async function marca(leadId: string, patch: Record<string, unknown>) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, any>), ...patch } as any } });
}

export async function processLaudoAsk(accountId: string, io: Io): Promise<void> {
  // 1) perguntar as regrinhas
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false AND l."aiAutoReplyActive" = true
      AND l."stageEnteredAt" >= ${LAUDO_ASK_FROM}
      AND NOT jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_laudoAsk')
      AND (jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), 'link_laudo_inter') OR jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_vistoriaRequestedAt')
           OR COALESCE(l."customFields"->'_vistoriaAi'->>'status', '') IN ('AGUARDA_ENGAJAMENTO', 'ENVIADA'))
    LIMIT 20`;
  for (const { id } of ids) {
    try { await askOne(accountId, id, io); } catch (e: any) { console.warn('[Laudo] pergunta:', e?.message); }
  }
  // 2) card completo + link do laudo → entra na fila da extensão
  const prontos = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND l."stageEnteredAt" >= ${LAUDO_ASK_FROM}
      AND jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), 'link_laudo_inter')
      AND COALESCE(l."customFields"->>'_laudoStatus', '') = '' AND NOT jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_laudoAutoQueuedAt')
    LIMIT 20`;
  for (const { id } of prontos) {
    try { await queueIfReady(accountId, id); } catch (e: any) { console.warn('[Laudo] fila:', e?.message); }
  }
}

async function askOne(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true } });
  if (!lead || !lead.aiAutoReplyActive) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused || asked(cf)) return;
  // tipo do imóvel: card, senão a proposta do site
  let tipo: string | null = /apart/i.test(String(cf.imovel_tipo || '')) ? 'Apartamento' : /casa|sobrado/i.test(String(cf.imovel_tipo || '')) ? 'Casa' : null;
  if (!tipo) {
    const prop = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Tipo do imóvel' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
    tipo = prop ? tipoDaProposta(prop.content) : null;
    if (tipo) { await marca(leadId, { imovel_tipo: tipo }); cf.imovel_tipo = tipo; }
  }
  if (!tipo) return; // sem saber se é casa ou apartamento: a IA da conversa descobre (regra APARTMENT_APPRAISAL_RULES)
  if (tipo === 'Casa') { await marca(leadId, { _laudoAsk: { skip: 'casa: a avaliação é com visita do engenheiro', at: new Date().toISOString() } }); return; }
  if (CAMPOS_REGRINHAS.every((k) => !vazio(cf[k]))) { await marca(leadId, { _laudoAsk: { skip: 'campos já preenchidos', at: new Date().toISOString() } }); return; }
  // a IA da conversa (ou a equipe) já fez essas perguntas
  const jaPerguntou = await prisma.message.count({ where: { leadId, direction: 'OUTBOUND', AND: [{ content: { contains: 'suíte', mode: 'insensitive' } }, { content: { contains: 'dormit', mode: 'insensitive' } }] } });
  if (jaPerguntou > 0) { await marca(leadId, { _laudoAsk: { skip: 'já perguntado na conversa', at: new Date().toISOString() } }); return; }
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return; // fora das 07h–21h: tenta de novo no próximo minuto
  if (!(await whatsappWindowOpen(leadId))) {
    // Janela de 24 h fechada (sem resposta do cliente): sem template aprovado pra isso, avisa a equipe UMA vez e manda sozinho quando o cliente falar.
    if (!cf._laudoAskWait) {
      await marca(leadId, { _laudoAskWait: new Date().toISOString() });
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '🏢 Apartamento + vistoria do Inter: preciso perguntar ao cliente dormitórios, banheiros, suítes e vagas com uso exclusivo (laudo digital), mas a janela de 24 h do WhatsApp está fechada. A IA manda a pergunta assim que ele responder qualquer mensagem; se preferir, peça por um template/ligação.' } }).catch(() => {});
      try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: '🏢 Laudo do apartamento', body: `${lead.name}: preciso perguntar dormitórios/banheiros/suítes/vagas (janela fechada)`, leadId }).catch(() => {}); } catch { /* aviso */ }
    }
    return;
  }
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: laudoAskText(), io: io as any });
  if (!r.success) return;
  await marca(leadId, { _laudoAsk: { askedAt: new Date().toISOString() } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '🏢 Apartamento + vistoria do Inter: perguntei ao cliente as 4 informações do laudo digital (dormitórios, banheiros, suítes, vagas com uso exclusivo). A IA registra a resposta nos campos do card; com o card completo e o link do laudo, o laudo entra sozinho na fila da extensão "Vistoria Inter".' } }).catch(() => {});
}

/** Card com o link do laudo e todos os dados: coloca na fila da extensão (ela preenche e para na conferência). Também completa o número da proposta a partir do link. */
async function queueIfReady(accountId: string, leadId: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, customFields: true } });
  if (!lead) return;
  let cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused) return;
  if (vazio(cf.num_proposta)) {
    const n = propostaDoLink(String(cf.link_laudo_inter || ''));
    if (n) { await marca(leadId, { num_proposta: n }); cf = { ...cf, num_proposta: n }; }
  }
  const { job } = buildLaudoJob(leadId, lead.name, cf);
  if (!job) return;
  const dono = await prisma.user.findFirst({ where: { accountId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!dono) return;
  await marca(leadId, { _laudoAutoQueuedAt: new Date().toISOString() });
  await requestLaudo(accountId, leadId, dono.id);
}
