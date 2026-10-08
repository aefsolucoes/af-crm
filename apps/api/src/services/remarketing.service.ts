import { PrismaClient, Prisma } from '@prisma/client';
import { logActivity } from './activity.service';

/**
 * Remarketing por WhatsApp (Fabio 07/10). O admin escolhe estágios na tela
 * Remarketing e os cards elegíveis entram num rodízio de 3 templates
 * aprovados, um a cada 7 dias:
 *   1ª remarketing_credito_af_v2 → 2ª remarketing_credito_condicoes → 3ª remarketing_credito_processo
 * 7 dias depois da 3ª sem resposta, o card vai pra Perdido ("sem retorno no
 * remarketing"). Qualquer mensagem do cliente (inclusive tocar num botão),
 * mudar o card de estágio ou ele virar Ganho/Perdido encerra o rodízio desse
 * card — a conversa segue com a equipe/IA. Cada card passa pelo rodízio UMA
 * vez só (não entra de novo numa rodada futura).
 *
 * Estado fica no próprio card (customFields):
 *   _rmkStartedAt, _rmkStageId, _rmkActive, _rmkPaused, _rmkStep (0-3),
 *   _rmkFirstAt, _rmkLastAt, _rmkFails, _rmkEnd (motivo do fim).
 *
 * Envio aos poucos: só das 9h às 19h (Brasília), segunda a sábado, até
 * MAX_PER_TICK por minuto e no máximo DAILY_FIRST_SENDS primeiras mensagens
 * por dia — o número é o mesmo do atendimento, e bloqueio em massa derruba a
 * qualidade dele na Meta.
 */

const prisma = new PrismaClient();

export const REMARKETING_TEMPLATES = ['remarketing_credito_af_v2', 'remarketing_credito_condicoes', 'remarketing_credito_processo'];
const INTERVAL_DAYS = 7;
const DAILY_FIRST_SENDS = 100;
const MAX_PER_TICK = 12;
const SEND_GAP_MS = 3000;
const DAY_MS = 86_400_000;

type Cf = Record<string, any>;

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Primeiro nome "apresentável" pro {{1}} — null quando não dá (só emoji, número…). */
export function remarketingFirstName(lead: { name: string; customFields: unknown; contact?: { name: string | null } | null }): string | null {
  const cf = (lead.customFields || {}) as Cf;
  for (const raw of [cf.participante_1, lead.name, lead.contact?.name]) {
    // 1ª palavra com letras ("53999257733 GAUTERIO" → "Gauterio").
    for (const word of String(raw || '').trim().split(/\s+/)) {
      const letters = word.replace(/[^\p{L}'-]/gu, '');
      if (letters.length >= 2) return letters.charAt(0).toUpperCase() + letters.slice(1).toLowerCase();
    }
  }
  return null;
}

function hasPhone(contact: { whatsappPhone: string | null; phone: string | null } | null): boolean {
  const digits = String(contact?.whatsappPhone || contact?.phone || '').replace(/\D/g, '');
  return digits.length >= 10 && !/@lid/.test(String(contact?.whatsappPhone || ''));
}

function brasiliaNow(): { hour: number; weekday: number; dayStartUtc: Date } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hourCycle: 'h23', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  // Meia-noite de Brasília (UTC-3, sem horário de verão) em UTC.
  const dayStartUtc = new Date(`${get('year')}-${get('month')}-${get('day')}T03:00:00.000Z`);
  return { hour: parseInt(get('hour'), 10), weekday, dayStartUtc };
}

function inSendWindow(): boolean {
  const { hour, weekday } = brasiliaNow();
  return weekday >= 1 && weekday <= 6 && hour >= 9 && hour < 19;
}

const eligibleWhere = (accountId: string): Prisma.LeadWhereInput => ({ accountId, status: 'OPEN', archived: false, isGroup: false });

/** Entra numa rodada: aberto, com telefone de verdade, nome apresentável e
 *  que nunca passou pelo remarketing. */
function isEligible(l: { name: string; customFields: unknown; contact: { name: string | null; whatsappPhone: string | null; phone: string | null } | null }): boolean {
  return !((l.customFields || {}) as Cf)._rmkStartedAt && hasPhone(l.contact) && !!remarketingFirstName(l);
}

// Só estágios de quem parou de responder — remarketing ("há um tempo você
// conversou com a gente…") não faz sentido pra quem está em Pré-Análise,
// Aguardando Documentação etc.
const REMARKETING_STAGE_RE = /^(prospec|follow ?up|lead sem retorno|remarketing|venda futura)/;

/** Estágios dos funis de Vendas com quantos cards entrariam numa rodada nova. */
export async function listRemarketingStages(accountId: string) {
  const stages = (await prisma.stage.findMany({
    where: { pipeline: { accountId, name: 'Vendas' } },
    orderBy: [{ pipeline: { name: 'asc' } }, { order: 'asc' }],
    select: { id: true, name: true, pipeline: { select: { department: { select: { name: true } } } } },
  })).filter((s) => REMARKETING_STAGE_RE.test(norm(s.name)));
  const leads = await prisma.lead.findMany({
    where: { ...eligibleWhere(accountId), stageId: { in: stages.map((s) => s.id) } },
    select: { stageId: true, name: true, customFields: true, contact: { select: { name: true, whatsappPhone: true, phone: true } } },
  });
  return stages.map((s) => {
    const here = leads.filter((l) => l.stageId === s.id && !((l.customFields || {}) as Cf)._rmkStartedAt);
    const ok = here.filter(isEligible);
    return { id: s.id, name: s.name, department: s.pipeline.department?.name || 'Sem setor', eligible: ok.length, skipped: here.length - ok.length };
  });
}

/** Coloca no rodízio os cards elegíveis dos estágios escolhidos. */
export async function startRemarketing(params: { accountId: string; stageIds: string[]; userId: string; userName: string }) {
  const { accountId, userId, userName } = params;
  const allowed = await prisma.stage.findMany({ where: { id: { in: params.stageIds }, pipeline: { accountId, name: 'Vendas' } }, select: { id: true, name: true } });
  const stageIds = allowed.filter((s) => REMARKETING_STAGE_RE.test(norm(s.name))).map((s) => s.id);
  const leads = await prisma.lead.findMany({
    where: { ...eligibleWhere(accountId), stageId: { in: stageIds } },
    select: { id: true, name: true, stageId: true, customFields: true, contact: { select: { name: true, whatsappPhone: true, phone: true } }, stage: { select: { name: true } } },
  });
  const fresh = leads.filter((l) => !((l.customFields || {}) as Cf)._rmkStartedAt);
  const ok = fresh.filter(isEligible);
  const now = new Date().toISOString();
  for (const l of ok) {
    const cf = (l.customFields || {}) as Cf;
    await prisma.lead.update({
      where: { id: l.id },
      data: {
        // IA ligada: quem responder escrevendo (não pelo botão) também é
        // atendido na hora (Fabio 08/10: "não deixa a IA desligada").
        aiAutoReplyActive: true,
        customFields: { ...cf, _rmkStartedAt: now, _rmkStageId: l.stageId, _rmkActive: true, _rmkPaused: false, _rmkStep: 0, _rmkFails: 0 },
        notes: { create: { type: 'COMMENT', userId, content: `📣 Entrou no remarketing por WhatsApp (3 mensagens, uma a cada ${INTERVAL_DAYS} dias; sem resposta depois da 3ª, vai pra Perdido) — por ${userName}` } },
      },
    });
  }
  const stageNames = Array.from(new Set(ok.map((l) => l.stage.name))).join(', ');
  logActivity({ accountId, userId, userName, action: 'remarketing_started', summary: `iniciou o remarketing de ${ok.length} cliente(s) (${stageNames || '—'})` });
  return { started: ok.length, skipped: fresh.length - ok.length };
}

export async function setRemarketingPaused(accountId: string, paused: boolean): Promise<number> {
  const active = await prisma.lead.findMany({
    where: { accountId, customFields: { path: ['_rmkActive'], equals: true } },
    select: { id: true, customFields: true },
  });
  for (const l of active) {
    await prisma.lead.update({ where: { id: l.id }, data: { customFields: { ...((l.customFields || {}) as Cf), _rmkPaused: paused } } });
  }
  return active.length;
}

/** Painel: quem está no rodízio, em que mensagem, quando é a próxima, e como terminou. */
export async function remarketingStatus(accountId: string) {
  const leads = await prisma.lead.findMany({
    where: { accountId, customFields: { path: ['_rmkStartedAt'], string_starts_with: '20' } },
    select: { id: true, name: true, status: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { name: true, department: { select: { name: true } } } } },
    orderBy: { updatedAt: 'desc' },
    take: 2000,
  });
  const { dayStartUtc } = brasiliaNow();
  const rows = leads.map((l) => {
    const cf = (l.customFields || {}) as Cf;
    const step = Number(cf._rmkStep || 0);
    const lastAt = cf._rmkLastAt ? new Date(cf._rmkLastAt) : null;
    const nextAt = cf._rmkActive ? (step === 0 ? null : new Date((lastAt?.getTime() || Date.now()) + INTERVAL_DAYS * DAY_MS)) : null;
    return {
      id: l.id, name: l.name, department: l.pipeline?.department?.name || '', stage: l.stage?.name || '',
      step, active: !!cf._rmkActive, paused: !!cf._rmkPaused, end: (cf._rmkEnd as string) || null,
      startedAt: cf._rmkStartedAt, lastAt: lastAt?.toISOString() || null, nextAt: nextAt?.toISOString() || null,
    };
  });
  const sentToday = leads.filter((l) => { const cf = (l.customFields || {}) as Cf; return cf._rmkLastAt && new Date(cf._rmkLastAt) >= dayStartUtc; }).length;
  return {
    rows,
    summary: {
      active: rows.filter((r) => r.active).length,
      paused: rows.some((r) => r.active && r.paused),
      waitingFirst: rows.filter((r) => r.active && r.step === 0).length,
      byStep: [1, 2, 3].map((n) => rows.filter((r) => r.active && r.step === n).length),
      replied: rows.filter((r) => r.end === 'respondeu').length,
      lost: rows.filter((r) => r.end === 'perdido').length,
      other: rows.filter((r) => !r.active && r.end && !['respondeu', 'perdido'].includes(r.end)).length,
      sentToday,
    },
    rules: { templates: REMARKETING_TEMPLATES, intervalDays: INTERVAL_DAYS, dailyFirstSends: DAILY_FIRST_SENDS, window: 'segunda a sábado, das 9h às 19h' },
  };
}

/** Qualidade do número na Meta (GREEN/YELLOW/RED) e limite de conversas. */
export async function numberQuality(accountId: string): Promise<{ quality: string | null; tier: string | null; phone: string | null }> {
  const { getWhatsAppConfig } = require('./whatsapp.service') as typeof import('./whatsapp.service');
  const config = await getWhatsAppConfig(accountId, null);
  if (!config?.accessToken || !config.phoneNumberId) return { quality: null, tier: null, phone: null };
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${config.phoneNumberId}?fields=quality_rating,messaging_limit_tier,display_phone_number`, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    const j: any = await r.json();
    return { quality: j.quality_rating || null, tier: j.messaging_limit_tier || null, phone: j.display_phone_number || null };
  } catch {
    return { quality: null, tier: null, phone: null };
  }
}

/** Card que respondeu o remarketing → estágio de Prospecção do funil, IA ligada. */
export async function moveToProspeccao(l: { id: string; accountId: string; name: string; stageId: string; pipelineId: string }, io: any): Promise<boolean> {
  const stages = await prisma.stage.findMany({ where: { pipelineId: l.pipelineId }, orderBy: { order: 'asc' }, select: { id: true, name: true } });
  const target = stages.find((s) => norm(s.name).startsWith('prospec'));
  const current = stages.find((s) => s.id === l.stageId);
  if (!target || target.id === l.stageId) return false;
  const moved = await prisma.lead.update({
    where: { id: l.id },
    data: {
      stageId: target.id,
      aiAutoReplyActive: true,
      notes: { create: { type: 'STAGE_CHANGE', content: `Estágio: "${current?.name || '?'}" → "${target.name}" — por Remarketing (cliente respondeu a mensagem)` } },
    },
  });
  io?.to(`account_${l.accountId}`).emit('lead_moved', { lead: moved });
  logActivity({ accountId: l.accountId, userId: null, userName: 'Remarketing', action: 'lead_stage_changed', leadId: l.id, leadName: l.name, summary: `moveu pra "${target.name}": cliente respondeu o remarketing` });
  return true;
}

async function endRemarketing(leadId: string, cf: Cf, end: string) {
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf, _rmkActive: false, _rmkEnd: end } } });
}

let running = false;
let tplCache: { at: number; list: any[] } | null = null;

async function templateBodies(accountId: string): Promise<any[]> {
  if (tplCache && Date.now() - tplCache.at < 30 * 60 * 1000) return tplCache.list;
  const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
  const list = await listMetaTemplates(accountId);
  tplCache = { at: Date.now(), list };
  return list;
}

/** Roda a cada minuto (index.ts): manda as mensagens que venceram e encerra quem respondeu. */
export async function processRemarketing(io: any): Promise<void> {
  if (running) return;
  running = true;
  try {
    const leads = await prisma.lead.findMany({
      where: { customFields: { path: ['_rmkActive'], equals: true } },
      select: { id: true, accountId: true, name: true, status: true, archived: true, stageId: true, pipelineId: true, customFields: true, contact: { select: { name: true } } },
    });
    if (!leads.length) return;

    // Encerramentos valem a qualquer hora; envios só na janela.
    const due: typeof leads = [];
    for (const l of leads) {
      const cf = (l.customFields || {}) as Cf;
      const replied = await prisma.message.findFirst({
        where: { leadId: l.id, direction: 'INBOUND', createdAt: { gt: new Date(cf._rmkStartedAt) } },
        select: { id: true },
      });
      if (replied) {
        await endRemarketing(l.id, cf, 'respondeu');
        // Respondeu escrevendo (não pelo botão, que já move): vai pra
        // Prospecção pra não ficar esquecido no Lead Sem Retorno (Fabio 08/10).
        if (l.status === 'OPEN' && !l.archived && l.stageId === cf._rmkStageId) await moveToProspeccao(l, io).catch((e) => console.error('[Remarketing] mover pra Prospecção:', e?.message));
        continue;
      }
      if (l.status !== 'OPEN' || l.archived) { await endRemarketing(l.id, cf, l.status === 'WON' ? 'ganho' : 'saiu'); continue; }
      if (l.stageId !== cf._rmkStageId) { await endRemarketing(l.id, cf, 'mudou de estágio'); continue; }
      // A Meta recusou a última: cliente bloqueou marketing da empresa
      // (131050) ou o número não tem WhatsApp (131026) — as próximas também
      // não chegariam. Outros erros (ex.: 130472, número em "experimento" da
      // Meta) seguem: a próxima pode passar.
      if (Number(cf._rmkStep || 0) > 0) {
        const lastTpl = await prisma.message.findFirst({
          where: { leadId: l.id, templateName: { in: REMARKETING_TEMPLATES } },
          orderBy: { createdAt: 'desc' },
          select: { status: true, statusError: true },
        });
        if (lastTpl?.status === 'FAILED' && /131050|131026/.test(lastTpl.statusError || '')) {
          await endRemarketing(l.id, cf, /131050/.test(lastTpl.statusError || '') ? 'bloqueou marketing' : 'sem WhatsApp');
          continue;
        }
      }
      if (cf._rmkPaused) continue;
      const step = Number(cf._rmkStep || 0);
      const lastAt = cf._rmkLastAt ? new Date(cf._rmkLastAt).getTime() : 0;
      if (step === 0 || Date.now() - lastAt >= INTERVAL_DAYS * DAY_MS) due.push(l);
    }
    if (!due.length || !inSendWindow()) return;

    const { dayStartUtc } = brasiliaNow();
    const firstToday: any[] = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "Lead" WHERE "customFields"->>'_rmkFirstAt' >= $1`, dayStartUtc.toISOString());
    let firstBudget = Math.max(0, DAILY_FIRST_SENDS - (firstToday[0]?.n || 0));

    // Quem está há mais tempo esperando vai primeiro.
    due.sort((a, b) => String((a.customFields as Cf)._rmkLastAt || (a.customFields as Cf)._rmkStartedAt).localeCompare(String((b.customFields as Cf)._rmkLastAt || (b.customFields as Cf)._rmkStartedAt)));

    let sent = 0;
    for (const l of due) {
      if (sent >= MAX_PER_TICK) break;
      const cf = (l.customFields || {}) as Cf;
      const step = Number(cf._rmkStep || 0);

      if (step >= REMARKETING_TEMPLATES.length) {
        // 7 dias depois da 3ª sem resposta → Perdido.
        const lostReason = 'Sem retorno no remarketing (3 mensagens)';
        const full = await prisma.lead.findUnique({ where: { id: l.id }, select: { pipeline: { select: { departmentId: true } } } });
        const { updateLead } = require('./lead.service') as typeof import('./lead.service');
        const { moveLeadToPerdidos } = require('./named-pipeline.service') as typeof import('./named-pipeline.service');
        await endRemarketing(l.id, cf, 'perdido');
        await updateLead(l.id, l.accountId, { status: 'LOST', lostReason }, io);
        await moveLeadToPerdidos({ accountId: l.accountId, leadId: l.id, departmentId: full?.pipeline?.departmentId, byName: 'Remarketing', userId: null, motivo: lostReason, io });
        logActivity({ accountId: l.accountId, userId: null, userName: 'Remarketing', action: 'lead_status_changed', leadId: l.id, leadName: l.name, summary: 'marcou como Perdido: sem retorno depois das 3 mensagens de remarketing' });
        continue;
      }
      if (step === 0) {
        if (firstBudget <= 0) continue;
        firstBudget--;
      }

      const nome = remarketingFirstName(l);
      if (!nome) { await endRemarketing(l.id, cf, 'sem nome'); continue; }
      const templateName = REMARKETING_TEMPLATES[step];
      let previewText = `Template "${templateName}" enviado`;
      try {
        const tpl = (await templateBodies(l.accountId)).find((t: any) => t.name === templateName);
        const body = tpl?.components?.find((c: any) => c.type === 'BODY')?.text;
        if (body) {
          previewText = String(body).replace(/\{\{1\}\}/g, nome);
          const buttons = (tpl.components.find((c: any) => c.type === 'BUTTONS')?.buttons || []).map((b: any) => b.text).filter(Boolean);
          if (buttons.length) previewText += `\n\n${buttons.map((t: string) => `[${t}]`).join('  ')}`;
        }
      } catch { /* fica com o rótulo genérico */ }

      const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
      const result = await sendOutboundWhatsAppTemplate({ accountId: l.accountId, leadId: l.id, templateName, language: 'pt_BR', bodyParams: [nome], previewText, io });
      sent++;
      const nowIso = new Date().toISOString();
      if (result.success) {
        await prisma.lead.update({
          where: { id: l.id },
          data: { customFields: { ...cf, _rmkStep: step + 1, _rmkLastAt: nowIso, ...(step === 0 ? { _rmkFirstAt: nowIso } : {}), _rmkFails: 0 } },
        });
        console.log(`[Remarketing] ${l.name}: ${step + 1}ª mensagem (${templateName}) enviada`);
      } else {
        const fails = Number(cf._rmkFails || 0) + 1;
        console.error(`[Remarketing] ${l.name}: falha na ${step + 1}ª mensagem (${fails}/3): ${result.error}`);
        if (fails >= 3) {
          await endRemarketing(l.id, cf, 'erro no envio');
          await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `⚠️ Remarketing parado: o WhatsApp não aceitou o envio 3 vezes (${result.error}).` } }).catch(() => {});
        } else {
          await prisma.lead.update({ where: { id: l.id }, data: { customFields: { ...cf, _rmkFails: fails } } });
        }
      }
      await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    }
  } finally {
    running = false;
  }
}

/** O card recebeu mensagem do remarketing (pra regra dos botões). */
export function wasInRemarketing(customFields: unknown): boolean {
  return !!((customFields || {}) as Cf)._rmkStartedAt;
}

/** "Remarketing" no nome do estágio. */
export function isRemarketingStage(name: string | null | undefined): boolean {
  return norm(name || '') === 'remarketing';
}
