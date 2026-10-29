import { prisma } from '../lib/prisma';
import { sendOutboundWhatsAppTemplate, sendOutboundWhatsApp } from './message.service';
import { logActivity } from './activity.service';

/* "Ainda deseja prosseguir com o crédito?" (template ainda_deseja_prosseguir, Utilidade, botões "Sim, tenho interesse" / "Não tenho interesse") — Fabio 28/10.
 *  - Disparo: clientes de Home Equity que JÁ estavam em "Aguardando Documentação" em 28/10 ("quando criar, pode encaminhar aos clientes que estão em aguardando
 *    documentação"). Só sai depois que a Meta aprova o template, das 07h às 21h, e espera quem falou com a gente nos últimos 2 dias ou acabou de entrar na etapa.
 *  - "Não tenho interesse": Perdido com a etiqueta "Aprovado sem andamento" e a pergunta do motivo de sempre (no-interest.service). Antes (28/10 tarde) ia pro Remarketing.
 *  - "Sim, tenho interesse": liga a IA do card e confere a documentação — o cliente recebe o que falta (ou "recebi tudo"); sem nenhum arquivo, a IA responde.
 *    Se ele continuar sem completar, o lembrete de documentos de sempre (automação de 3 em 3 dias, template follow_up_doc) roda mais 3 vezes e então este template
 *    sai de novo (processProsseguir). */

export const PROSSEGUIR_TEMPLATE = 'ainda_deseja_prosseguir';
const PROSSEGUIR_TEXT = 'Ainda deseja prosseguir com o crédito?';
// Os botões vão no texto gravado ("…\n\n[A]  [B]") pra conversa do CRM desenhá-los como no WhatsApp e marcar o que o cliente tocou.
const PROSSEGUIR_PREVIEW = `${PROSSEGUIR_TEXT}\n\n[Sim, tenho interesse]  [Não tenho interesse]`;
export const TAG_APROVADO_SEM_ANDAMENTO = 'Aprovado sem andamento';
const DOC_REMINDER_TEMPLATE = 'follow_up_doc';
const LEMBRETES_ANTES_DE_REPETIR = 3;
const DIA = 86_400_000;
const BRT = -3 * 3_600_000;
// Disparo único: só cards que já estavam na etapa em 28/10; a campanha tenta até 04/11 (quem estava conversando recebe quando a conversa esfriar).
const CAMPANHA_CORTE = Date.parse('2026-10-29T03:00:00Z');
const CAMPANHA_ATE = Date.parse('2026-11-05T03:00:00Z');
const POR_RODADA = 10;

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
export type ProsseguirState = { enviadoAt?: string; vezes?: number; simAt?: string | null };

const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const emHorario = (ms = Date.now()) => { const h = new Date(ms + BRT).getUTCHours(); return h >= 7 && h < 21; };

/** Manda o template e guarda no card (`_prosseguir`). */
export async function sendProsseguir(accountId: string, leadId: string, motivo: string, io?: Io): Promise<boolean> {
  const r = await sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: PROSSEGUIR_TEMPLATE, language: 'pt_BR', bodyParams: [], previewText: PROSSEGUIR_PREVIEW, io: io || undefined });
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  const p = (cf._prosseguir || {}) as ProsseguirState;
  if (!r.success) {
    cf._prosseguir = { ...p, falhaAt: new Date().toISOString(), falha: String(r.error || '').slice(0, 160) };
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
    console.error(`[Prosseguir] ${leadId}: template não saiu — ${r.error}`);
    return false;
  }
  cf._prosseguir = { enviadoAt: new Date().toISOString(), vezes: (p.vezes || 0) + 1, simAt: null };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📨 Mandei o template "${PROSSEGUIR_TEXT}" (botões Sim / Não) — ${motivo}.` } }).catch(() => {});
  return true;
}

/** É resposta ao template? (o último envio dele ainda não foi respondido com "Sim") */
function esperandoResposta(p: ProsseguirState | undefined): boolean {
  if (!p?.enviadoAt) return false;
  return !p.simAt || Date.parse(p.simAt) < Date.parse(p.enviadoAt);
}

/** "Não tenho interesse" / pediu pra parar em Aguardando Documentação (o card vai pra Perdido): etiqueta "Aprovado sem andamento". */
export async function tagAprovadoSemAndamento(leadId: string, estavaEm: string, cf: Record<string, any>): Promise<void> {
  if (!norm(estavaEm).includes('aguardando documentacao') && !esperandoResposta(cf._prosseguir)) return;
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { tags: true } });
  if (!l || l.tags.includes(TAG_APROVADO_SEM_ANDAMENTO)) return;
  await prisma.lead.update({ where: { id: leadId }, data: { tags: [...l.tags, TAG_APROVADO_SEM_ANDAMENTO] } });
}

/** "Sim, tenho interesse" ao template: liga a IA e confere a documentação. `responderComIa` = a resposta normal da IA (quando a conferência não tem o que dizer). */
export async function handleProsseguirYes(accountId: string, leadId: string, text: string, io: Io, responderComIa: () => Promise<unknown>): Promise<boolean> {
  if (!/^sim,?\s*tenho interesse[.!]?$/i.test(text.trim())) return false;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true, stage: { select: { name: true } } } });
  if (!lead) return false;
  const cf = { ...((lead.customFields || {}) as Record<string, any>) };
  if (!esperandoResposta(cf._prosseguir) || !norm(lead.stage.name).includes('aguardando documentacao')) return false;
  if (cf._autoPaused) return false; // STOP TOTAL: ninguém responde sozinho
  cf._prosseguir = { ...cf._prosseguir, simAt: new Date().toISOString() };
  await prisma.lead.update({ where: { id: leadId }, data: { aiAutoReplyActive: true, customFields: cf as any } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `✅ Cliente respondeu "Sim, tenho interesse" ao "${PROSSEGUIR_TEXT}". IA do card ligada; conferindo a documentação pra dizer o que falta.` } }).catch(() => {});
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId, leadName: lead.name, summary: 'cliente quer prosseguir: IA ligada e documentação conferida' });
  const arquivos = await prisma.messageAttachment.count({ where: { leadId, message: { direction: 'INBOUND' } } });
  (async () => {
    let falou = false;
    if (arquivos) {
      // A leitura dos arquivos leva alguns minutos: avisa antes, pra ele não ficar sem resposta.
      await sendOutboundWhatsApp({ accountId, leadId, content: 'Ótimo! Vou conferir aqui os documentos que você já mandou e já te digo o que falta.', io: io || undefined });
      const { checkDocsComplete } = require('./docs-checker.service') as typeof import('./docs-checker.service');
      falou = await checkDocsComplete(accountId, leadId, io as any, { force: true }).catch((e) => { console.error('[Prosseguir] conferência:', e?.message || e); return false; });
    }
    if (!falou) await responderComIa();
  })().catch((e) => console.error('[Prosseguir] resposta ao Sim:', e?.message || e));
  return true;
}

let aprovadoNaMeta = false;
let ultimaConsultaMeta = 0;
async function templateAprovado(accountId: string): Promise<boolean> {
  if (aprovadoNaMeta) return true;
  if (Date.now() - ultimaConsultaMeta < 15 * 60_000) return false;
  ultimaConsultaMeta = Date.now();
  try {
    const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
    const t = (await listMetaTemplates(accountId)).find((x: any) => x?.name === PROSSEGUIR_TEMPLATE);
    aprovadoNaMeta = String(t?.status || '').toUpperCase() === 'APPROVED';
  } catch (e: any) { console.error('[Prosseguir] status do template na Meta:', e?.message || e); }
  return aprovadoNaMeta;
}

/** Poller (1 min): a campanha de 28/10 e o reenvio depois de 3 lembretes de documentação sem resposta. */
let botoesAcertados = false;
export async function processProsseguir(accountId: string, io?: Io): Promise<void> {
  // Os primeiros envios (28/10) ficaram gravados sem os botões — completa uma vez.
  if (!botoesAcertados) {
    botoesAcertados = true;
    await prisma.message.updateMany({ where: { templateName: PROSSEGUIR_TEMPLATE, content: PROSSEGUIR_TEXT }, data: { content: PROSSEGUIR_PREVIEW } })
      .then((r) => { if (r.count) console.log(`[Prosseguir] ${r.count} mensagem(ns) completada(s) com os botões`); })
      .catch((e) => { botoesAcertados = false; console.error('[Prosseguir] completar botões:', e?.message); });
  }
  // Loop novo de lembretes no ar: o "Ainda deseja prosseguir?" sai pelo loop (3 dias seguidos), não pela campanha nem pelo reenvio daqui.
  if (await (require('./docs-loop.service') as typeof import('./docs-loop.service')).docLoopAtivo(accountId)) return;
  if (!emHorario() || !(await templateAprovado(accountId))) return;
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, isGroup: false, stage: { name: { contains: 'aguardando document', mode: 'insensitive' } }, pipeline: { department: { name: { contains: 'home equity', mode: 'insensitive' } } } },
    select: { id: true, name: true, stageEnteredAt: true, customFields: true },
  });
  let enviados = 0;
  for (const l of leads) {
    if (enviados >= POR_RODADA) break;
    const cf = (l.customFields || {}) as Record<string, any>;
    if (cf._autoPaused) continue;
    const p = cf._prosseguir as (ProsseguirState & { falhaAt?: string }) | undefined;
    if (p?.falhaAt && Date.now() - Date.parse(p.falhaAt) < DIA) continue; // falhou (sem telefone, Meta recusou): tenta de novo amanhã
    const lastIn = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'INBOUND' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const conversando = !!lastIn && Date.now() - lastIn.createdAt.getTime() < 2 * DIA;
    let motivo = '';
    if (!p?.enviadoAt) {
      // Campanha: só quem já estava na etapa em 28/10, até 04/11; quem acabou de entrar ou está conversando espera.
      if (Date.now() > CAMPANHA_ATE || !l.stageEnteredAt || l.stageEnteredAt.getTime() > CAMPANHA_CORTE) continue;
      if (conversando || Date.now() - l.stageEnteredAt.getTime() < 3 * DIA) continue;
      motivo = 'campanha pros clientes em Aguardando Documentação (Fabio 28/10)';
    } else if (p.simAt && Date.parse(p.simAt) >= Date.parse(p.enviadoAt)) {
      // Disse "Sim": depois de 3 lembretes de documentação sem completar, pergunta de novo — na hora em que sairia o 4º.
      const lembretes = await prisma.message.findMany({ where: { leadId: l.id, direction: 'OUTBOUND', templateName: DOC_REMINDER_TEMPLATE, createdAt: { gt: new Date(p.simAt) } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      if (lembretes.length < LEMBRETES_ANTES_DE_REPETIR || Date.now() - lembretes[0].createdAt.getTime() < 3 * DIA || conversando) continue;
      motivo = `${lembretes.length} lembretes de documentação depois do "Sim" e a documentação não completou`;
    } else continue; // já perguntou e ele ainda não respondeu: o lembrete de documentos de sempre segue
    if (await sendProsseguir(accountId, l.id, motivo, io)) enviados++;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (enviados) console.log(`[Prosseguir] ${enviados} template(s) "${PROSSEGUIR_TEXT}" enviado(s)`);
}

/** Pediu pra parar os lembretes em Aguardando Documentação (Fabio 28/10: "pediu para parar, move para Perdidos, coloca a tag de aprovado"; e no caso
 *  "vamos pensar mais um pouco", com a IA perguntando uma data: "se ele demorar 1 dia para responder, move para Perdido"). Espera 1 dia depois do pedido
 *  (tag da IA, `_pediuPararAt`; tags antigas: a última mensagem de conversa) — se o cliente voltou a falar nesse meio-tempo, não mexe (a IA/equipe
 *  segue; com data combinada a IA já leva pra Venda Futura). Senão: Perdido, funil Perdidos, etiqueta "Aprovado sem andamento". */
const TAG_PAROU = 'Pediu pra parar lembretes';
export async function processPediuParar(accountId: string, io?: Io): Promise<void> {
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, isGroup: false, tags: { has: TAG_PAROU }, stage: { name: { contains: 'aguardando document', mode: 'insensitive' } } },
    select: { id: true, name: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { departmentId: true } } },
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Record<string, any>;
    let pedidoEm = cf._pediuPararAt ? new Date(cf._pediuPararAt) : null;
    if (!pedidoEm) {
      // Tag antiga (sem a data): conta da última mensagem de CONVERSA (cliente ou nossa, sem template) — o próprio "não, obrigada" do cliente costuma ser a última.
      const ultConversa = await prisma.message.findFirst({ where: { leadId: l.id, channel: { not: 'EMAIL' }, templateName: null }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      pedidoEm = ultConversa?.createdAt || new Date(0);
    }
    if (Date.now() - pedidoEm.getTime() < DIA) continue; // ainda dentro do dia de espera
    const voltou = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'INBOUND', channel: { not: 'EMAIL' }, createdAt: { gt: pedidoEm } }, select: { id: true } });
    if (voltou) continue; // cliente voltou a falar depois do pedido: a conversa decide
    const lostReason = 'Pediu pra parar os lembretes de documentação (aprovado, sem andamento)';
    const { updateLead } = require('./lead.service') as typeof import('./lead.service');
    const { moveLeadToPerdidos } = require('./named-pipeline.service') as typeof import('./named-pipeline.service');
    await updateLead(l.id, accountId, { status: 'LOST', lostReason }, io as any);
    await moveLeadToPerdidos({ accountId, leadId: l.id, departmentId: l.pipeline?.departmentId, byName: 'Assistente IA', userId: null, motivo: lostReason, io: io as any });
    await tagAprovadoSemAndamento(l.id, l.stage?.name || '', cf).catch(() => {});
    await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `↪️ Pediu pra parar os lembretes${cf._pediuPararAt ? ` em ${new Date(cf._pediuPararAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).slice(0, 16)}` : ''} e não voltou a falar em 1 dia: card foi pra Perdidos com a etiqueta "${TAG_APROVADO_SEM_ANDAMENTO}".` } }).catch(() => {});
    logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_status_changed', leadId: l.id, leadName: l.name, summary: 'marcou o card como Perdido: pediu pra parar os lembretes de documentação' });
    console.log(`[Pediu pra parar] ${l.name}: Perdidos + "${TAG_APROVADO_SEM_ANDAMENTO}"`);
  }
}

/** Cliente APROVADO achou caro e a IA perguntou "Você deseja seguir com o crédito aprovado?" (Fabio 29/10, Iranildes): sem resposta em 1 dia →
 *  Perdido, funil Perdidos, etiqueta "Aprovado sem andamento" (a mesma regra do "vamos pensar", 28/10). Respondeu ou a equipe assumiu: a conversa decide. */
export async function processSeguirAprovado(accountId: string, io?: Io): Promise<void> {
  const { SEGUIR_APROVADO_Q } = require('./ai-auto-reply.service') as typeof import('./ai-auto-reply.service');
  const leads = await prisma.lead.findMany({
    where: { accountId, status: { in: ['OPEN', 'LOST'] }, archived: false, isGroup: false, customFields: { path: ['_seguirAprovadoAt'], string_starts_with: '20' } },
    select: { id: true, name: true, status: true, tags: true, customFields: true, pipeline: { select: { departmentId: true } } },
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Record<string, any>;
    if (cf._autoPaused) continue; // STOP TOTAL: a equipe cuida
    // A pergunta que valeu é a que SAIU (a IA pode ter falhado no envio).
    const pergunta = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'OUTBOUND', deleted: false, content: { contains: SEGUIR_APROVADO_Q }, createdAt: { gte: new Date(Date.parse(cf._seguirAprovadoAt) - 60_000) } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const limpar = async () => { const { _seguirAprovadoAt, ...resto } = cf; await prisma.lead.update({ where: { id: l.id }, data: { customFields: resto } }); };
    if (!pergunta) { if (Date.now() - Date.parse(cf._seguirAprovadoAt) > DIA) await limpar(); continue; }
    if (Date.now() - pergunta.createdAt.getTime() < DIA) continue;
    const depois = await prisma.message.findFirst({ where: { leadId: l.id, channel: { not: 'EMAIL' }, createdAt: { gt: pergunta.createdAt }, OR: [{ direction: 'INBOUND' }, { direction: 'OUTBOUND', sentByUserId: { not: null } }] }, select: { id: true } });
    if (depois) { await limpar(); continue; } // respondeu, ou alguém da equipe escreveu
    const lostReason = 'Achou caro e não respondeu se quer seguir com o crédito aprovado';
    if (l.status === 'LOST') {
      // Já estava em Perdidos (a equipe mandou a pergunta pra quem a IA tinha fechado): só a etiqueta.
      await limpar();
      if (!l.tags.includes(TAG_APROVADO_SEM_ANDAMENTO)) await prisma.lead.update({ where: { id: l.id }, data: { tags: [...l.tags, TAG_APROVADO_SEM_ANDAMENTO] } }).catch(() => {});
      await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `↪️ Perguntei "${SEGUIR_APROVADO_Q}" e não respondeu em 1 dia: card segue em Perdidos, com a etiqueta "${TAG_APROVADO_SEM_ANDAMENTO}".` } }).catch(() => {});
      continue;
    }
    const { updateLead } = require('./lead.service') as typeof import('./lead.service');
    const { moveLeadToPerdidos } = require('./named-pipeline.service') as typeof import('./named-pipeline.service');
    await limpar();
    await updateLead(l.id, accountId, { status: 'LOST', lostReason }, io as any);
    await moveLeadToPerdidos({ accountId, leadId: l.id, departmentId: l.pipeline?.departmentId, byName: 'Assistente IA', userId: null, motivo: lostReason, io: io as any });
    if (!l.tags.includes(TAG_APROVADO_SEM_ANDAMENTO)) await prisma.lead.update({ where: { id: l.id }, data: { tags: [...l.tags, TAG_APROVADO_SEM_ANDAMENTO] } }).catch(() => {});
    await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `↪️ Achou caro; perguntei "${SEGUIR_APROVADO_Q}" em ${pergunta.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).slice(0, 16)} e não respondeu em 1 dia: card foi pra Perdidos com a etiqueta "${TAG_APROVADO_SEM_ANDAMENTO}".` } }).catch(() => {});
    logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_status_changed', leadId: l.id, leadName: l.name, summary: 'marcou o card como Perdido: aprovado, achou caro e não respondeu se quer seguir' });
    console.log(`[Seguir com o aprovado] ${l.name}: Perdidos + "${TAG_APROVADO_SEM_ANDAMENTO}"`);
  }
}


/** "Sim" à pergunta "Você deseja seguir com o crédito aprovado?" de quem está em Perdidos (Fabio 29/10, Iranildes: a IA tinha fechado o card antes de perguntar):
 *  reabre no funil de Vendas do setor, em Aguardando Documentação — como a reentrada pela CAIXA. Só vale com a pergunta enviada nos últimos 3 dias. */
export async function reopenSeguirAprovado(accountId: string, leadId: string, reason: string | null, io?: Io): Promise<boolean> {
  const { SEGUIR_APROVADO_Q } = require('./ai-auto-reply.service') as typeof import('./ai-auto-reply.service');
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, status: true, tags: true, customFields: true, pipeline: { select: { departmentId: true } } } });
  if (!lead || lead.status !== 'LOST' || !lead.pipeline?.departmentId) return false;
  const perguntou = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', deleted: false, content: { contains: SEGUIR_APROVADO_Q }, createdAt: { gte: new Date(Date.now() - 3 * DIA) } }, select: { id: true } });
  if (!perguntou) return false;
  const sales = await prisma.pipeline.findFirst({ where: { accountId, departmentId: lead.pipeline.departmentId, name: { contains: 'Vendas', mode: 'insensitive' } }, select: { id: true, name: true, stages: { select: { id: true, name: true } } } });
  const alvo = sales?.stages.find((st) => /^aguardando doc/i.test(st.name));
  if (!sales || !alvo) return false;
  const { _seguirAprovadoAt, ...cf } = (lead.customFields || {}) as Record<string, any>;
  await prisma.lead.update({ where: { id: leadId }, data: { status: 'OPEN', archived: false, lostReason: null, pipelineId: sales.id, stageId: alvo.id, stageEnteredAt: new Date(), aiAutoReplyActive: true, customFields: cf as any, tags: lead.tags.filter((t) => t !== TAG_APROVADO_SEM_ANDAMENTO) } });
  await prisma.note.create({ data: { leadId, type: 'STAGE_CHANGE', content: `🔓 Card reaberto: respondeu que quer seguir com o crédito aprovado — saiu do funil "Perdidos" pra "${sales.name}" (${alvo.name})${reason ? `. ${reason}` : ''}` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: '🔓 Aprovado quer seguir', body: `${lead.name}: respondeu que quer seguir com o crédito aprovado — card reaberto em ${alvo.name}`, leadId }).catch(() => {});
  if (io) io.to(`lead:${leadId}`).emit('lead_moved', { leadId, stageId: alvo.id });
  console.log(`[Seguir com o aprovado] ${lead.name}: reaberto em ${sales.name}/${alvo.name}`);
  return true;
}
