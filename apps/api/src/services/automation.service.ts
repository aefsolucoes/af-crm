import { PrismaClient, AutomationTrigger } from '@prisma/client';
import { sendOutboundWhatsApp, sendOutboundWhatsAppTemplate } from './message.service';
import { updateLead, updateLeadStage } from './lead.service';
import { startSalesBotRun } from './salesbot.service';

const prisma = new PrismaClient();

export type AutomationActionType =
  | 'send_message'
  | 'send_template'
  | 'assign_agent'
  | 'move_stage'
  | 'add_tag'
  | 'start_salesbot'
  | 'webhook';

export interface AutomationAction {
  type: AutomationActionType;
  config: Record<string, unknown>;
}

/** Contexto do disparo — o que muda de gatilho pra gatilho (texto da
 *  mensagem recebida, novo estágio, tag adicionada). */
export interface RunContext {
  incomingText?: string;
  newStageId?: string;
  addedTag?: string;
}

type LeadForActions = {
  id: string;
  accountId: string;
  name: string;
  tags: string[];
  pipeline: { departmentId: string | null };
  contact: { name: string | null; phone: string | null; whatsappPhone: string | null } | null;
};

// ═══════════════════════════════════════════════════════════════════════════
// CRUD — espelha salesbot.service.ts
// ═══════════════════════════════════════════════════════════════════════════

export async function listAutomationRules(accountId: string) {
  const rules = await prisma.automationRule.findMany({
    where: { accountId },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { logs: true } } },
  });
  return rules.map(({ _count, ...rest }) => ({ ...rest, executionCount: _count.logs }));
}

export async function getAutomationRule(id: string, accountId: string) {
  return prisma.automationRule.findFirst({ where: { id, accountId } });
}

export async function createAutomationRule(accountId: string, data: {
  name: string;
  trigger: AutomationTrigger;
  triggerConfig?: Record<string, unknown>;
  actions: AutomationAction[];
  active?: boolean;
}) {
  return prisma.automationRule.create({
    data: {
      accountId,
      name: data.name,
      trigger: data.trigger,
      triggerConfig: (data.triggerConfig ?? null) as any,
      actions: data.actions as any,
      active: data.active ?? true,
    },
  });
}

export async function updateAutomationRule(id: string, accountId: string, data: Partial<{
  name: string;
  trigger: AutomationTrigger;
  triggerConfig: Record<string, unknown> | null;
  actions: AutomationAction[];
  active: boolean;
}>) {
  const existing = await prisma.automationRule.findFirst({ where: { id, accountId } });
  if (!existing) return null;
  return prisma.automationRule.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.trigger !== undefined ? { trigger: data.trigger } : {}),
      ...(data.triggerConfig !== undefined ? { triggerConfig: data.triggerConfig as any } : {}),
      ...(data.actions !== undefined ? { actions: data.actions as any } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
    },
  });
}

export async function deleteAutomationRule(id: string, accountId: string) {
  const existing = await prisma.automationRule.findFirst({ where: { id, accountId } });
  if (!existing) return false;
  // AutomationLog.rule tem onDelete: Cascade — não precisa apagar os logs à mão.
  await prisma.automationRule.delete({ where: { id } });
  return true;
}

export async function listAutomationLogs(ruleId: string, accountId: string) {
  const rule = await prisma.automationRule.findFirst({ where: { id: ruleId, accountId } });
  if (!rule) return null;
  const logs = await prisma.automationLog.findMany({
    where: { ruleId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  const leadIds = Array.from(new Set(logs.map((l) => l.leadId)));
  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true } });
  const leadNameById = new Map(leads.map((l) => [l.id, l.name]));
  return logs.map((l) => ({ ...l, leadName: leadNameById.get(l.leadId) || '—' }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Variáveis — {{campo}} dentro da mensagem de uma ação send_message/send_template
// (generaliza o padrão inline já usado em routes/ai.ts, ferramenta de resposta
// rápida da IA). {{mensagem_recebida}} é o pedido original que motivou o motor.
// ═══════════════════════════════════════════════════════════════════════════

export function fillVariables(text: string, lead: LeadForActions, context?: RunContext): string {
  const vars: Record<string, string> = {
    nome: lead.contact?.name || lead.name || '',
    telefone: lead.contact?.phone || lead.contact?.whatsappPhone || '',
    mensagem_recebida: context?.incomingText || '',
  };
  return text.replace(/\{\{([^}]+)\}\}/g, (_m, key) => {
    const v = vars[String(key).trim()];
    return v !== undefined ? v : `{{${key}}}`;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Motor de execução
// ═══════════════════════════════════════════════════════════════════════════

async function executeAction(action: AutomationAction, lead: LeadForActions, context: RunContext, io: unknown): Promise<boolean> {
  switch (action.type) {
    case 'send_message': {
      const content = fillVariables(String(action.config.message || ''), lead, context);
      if (!content.trim()) return false;
      const result = await sendOutboundWhatsApp({ accountId: lead.accountId, leadId: lead.id, content, io: io as any });
      return result.success;
    }
    case 'send_template': {
      const templateName = String(action.config.templateName || '');
      if (!templateName) return false;
      const language = String(action.config.language || 'pt_BR');
      const rawParams = Array.isArray(action.config.bodyParams) ? (action.config.bodyParams as unknown[]).map(String) : [];
      const bodyParams = rawParams.map((p) => fillVariables(p, lead, context));
      const result = await sendOutboundWhatsAppTemplate({
        accountId: lead.accountId, leadId: lead.id, templateName, language, bodyParams,
        previewText: `Template "${templateName}" enviado`, io: io as any,
      });
      return result.success;
    }
    case 'assign_agent': {
      const mode = String(action.config.mode || 'specific');
      if (mode === 'least_open_leads') {
        const users = await prisma.user.findMany({
          where: { accountId: lead.accountId },
          select: { id: true, _count: { select: { leads: { where: { status: 'OPEN', archived: false } } } } },
        });
        if (!users.length) return false;
        const chosen = users.reduce((a, b) => (b._count.leads < a._count.leads ? b : a));
        await updateLead(lead.id, lead.accountId, { userId: chosen.id });
        return true;
      }
      const userId = String(action.config.userId || '');
      if (!userId) return false;
      await updateLead(lead.id, lead.accountId, { userId });
      return true;
    }
    case 'move_stage': {
      const stageId = String(action.config.stageId || '');
      if (!stageId) return false;
      const stage = await prisma.stage.findFirst({ where: { id: stageId, pipeline: { accountId: lead.accountId } } });
      if (!stage) return false;
      await updateLeadStage(lead.id, lead.accountId, stageId);
      return true;
    }
    case 'add_tag': {
      const tag = String(action.config.tag || '').trim();
      if (!tag) return false;
      const tags = Array.from(new Set([...(lead.tags || []), tag]));
      await updateLead(lead.id, lead.accountId, { tags });
      return true;
    }
    case 'start_salesbot': {
      const botId = String(action.config.botId || '');
      if (!botId) return false;
      const result = await startSalesBotRun(lead.accountId, lead.id, botId, io);
      return result.started;
    }
    case 'webhook': {
      const url = String(action.config.url || '');
      if (!url) return false;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leadId: lead.id, leadName: lead.name, ...context }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        return res.ok;
      } catch (err) {
        console.error('[Automation] Falha no webhook:', (err as any)?.message);
        return false;
      }
    }
    default:
      return false;
  }
}

async function executeRuleForLead(
  rule: { id: string; actions: unknown },
  leadId: string,
  io: unknown,
  context: RunContext
): Promise<void> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    include: { contact: { select: { name: true, phone: true, whatsappPhone: true } }, pipeline: { select: { departmentId: true } } },
  });
  if (!lead) return;

  const actions = (rule.actions as unknown as AutomationAction[]) || [];
  const results: { type: string; ok: boolean }[] = [];
  for (const action of actions) {
    try {
      const ok = await executeAction(action, lead, context, io);
      results.push({ type: action.type, ok });
    } catch (err) {
      console.error('[Automation] Falha ao executar ação', action.type, 'da regra', rule.id, err);
      results.push({ type: action.type, ok: false });
    }
  }

  await prisma.automationLog
    .create({ data: { ruleId: rule.id, leadId, success: results.every((r) => r.ok), actionsResult: results as any } })
    .catch((err) => console.error('[Automation] Falha ao gravar log:', err));
}

function matchesTriggerConfig(rule: { trigger: AutomationTrigger; triggerConfig: unknown }, context: RunContext): boolean {
  const cfg = (rule.triggerConfig as Record<string, unknown>) || {};
  switch (rule.trigger) {
    case 'STAGE_CHANGE':
      return !cfg.stageId || cfg.stageId === context.newStageId;
    case 'TAG_ADDED':
      return !cfg.tag || String(cfg.tag).trim().toLowerCase() === String(context.addedTag || '').trim().toLowerCase();
    default:
      return true;
  }
}

/** Motor genérico — chamado nos pontos de hook de NEW_LEAD/STAGE_CHANGE/
 *  TAG_ADDED. Fire-and-forget: nunca deve travar nem quebrar quem chamou (os
 *  pontos de hook ficam em código quente — criação de lead, troca de
 *  estágio). MESSAGE_RECEIVED usa `maybeMessageReceivedAutomations` abaixo
 *  (precisa devolver se "respondeu", pra entrar na exclusividade com
 *  SalesBot/template/IA); INACTIVITY usa `checkInactivityAutomations`
 *  (é um poll, não um evento). */
export async function runAutomations(params: {
  accountId: string;
  trigger: AutomationTrigger;
  leadId: string;
  io: unknown;
  context?: RunContext;
}): Promise<void> {
  try {
    const rules = await prisma.automationRule.findMany({
      where: { accountId: params.accountId, trigger: params.trigger, active: true },
    });
    for (const rule of rules) {
      if (!matchesTriggerConfig(rule, params.context || {})) continue;
      await executeRuleForLead(rule, params.leadId, params.io, params.context || {})
        .catch((err) => console.error('[Automation] Falha na regra', rule.id, err));
    }
  } catch (err) {
    console.error('[Automation] Erro em runAutomations:', err);
  }
}

/** Gatilho "mensagem recebida" — mesma exclusividade que já existe entre
 *  SalesBot/template/IA (só um responde por mensagem). Só considera a
 *  mensagem "respondida" se alguma regra tinha ação de responder de verdade
 *  (send_message/send_template/start_salesbot) — uma regra que só adiciona
 *  tag não deve impedir a IA de responder depois. */
export async function maybeMessageReceivedAutomations(accountId: string, leadId: string, text: string, io: unknown): Promise<boolean> {
  try {
    const rules = await prisma.automationRule.findMany({ where: { accountId, trigger: 'MESSAGE_RECEIVED', active: true } });
    let repliedByAutomation = false;
    for (const rule of rules) {
      await executeRuleForLead(rule, leadId, io, { incomingText: text })
        .catch((err) => console.error('[Automation] Falha na regra', rule.id, err));
      const actions = (rule.actions as unknown as AutomationAction[]) || [];
      if (actions.some((a) => a.type === 'send_message' || a.type === 'send_template' || a.type === 'start_salesbot')) {
        repliedByAutomation = true;
      }
    }
    return repliedByAutomation;
  } catch (err) {
    console.error('[Automation] Erro em maybeMessageReceivedAutomations:', err);
    return false;
  }
}

/** Poll periódico (setInterval em index.ts, igual pollSalesBotRuns) — é
 *  granularidade de dias, não de minutos, então não precisa de cadência
 *  curta. Dedupe via AutomationLog: só dispara de novo pra um lead depois
 *  de uma mensagem NOVA resetar o silêncio (evita repetir a cada poll
 *  enquanto o lead continua inativo). */
export async function checkInactivityAutomations(io: unknown): Promise<void> {
  const rules = await prisma.automationRule.findMany({ where: { trigger: 'INACTIVITY', active: true } });
  for (const rule of rules) {
    try {
      const days = Number((rule.triggerConfig as any)?.days || 3);
      if (!days || days <= 0) continue;
      const threshold = new Date(Date.now() - days * 86_400_000);
      const leads = await prisma.lead.findMany({
        where: { accountId: rule.accountId, status: 'OPEN', archived: false, isGroup: false, messages: { some: {} } },
        select: { id: true, messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } } },
      });
      for (const lead of leads) {
        const lastMsgAt = lead.messages[0]?.createdAt;
        if (!lastMsgAt || lastMsgAt > threshold) continue;
        const already = await prisma.automationLog.findFirst({ where: { ruleId: rule.id, leadId: lead.id, createdAt: { gt: lastMsgAt } } });
        if (already) continue;
        await executeRuleForLead(rule, lead.id, io, {}).catch((err) => console.error('[Automation] Falha (inatividade)', rule.id, err));
      }
    } catch (err) {
      console.error('[Automation] Erro em checkInactivityAutomations (regra ' + rule.id + '):', err);
    }
  }
}
