import { PrismaClient, SalesBotRun } from '@prisma/client';
import { sendOutboundWhatsApp } from './message.service';
import { updateLead, updateLeadStage } from './lead.service';

const prisma = new PrismaClient();

// Formato do JSON guardado em SalesBot.flow — espelha
// apps/web/components/salesbot/node-types.tsx (só os 6 tipos do MVP:
// send_message, pause, condition, action, validation, stop_salesbot). Ordem
// do array = próximo passo por padrão; só "condition" desvia (trueStepId/
// falseStepId), permitindo até voltar pra um passo anterior (loop de
// validação, por ex.).
export interface SalesBotFlow {
  trigger: { keywords: string[] };
  steps: SalesBotStep[];
}

export interface SalesBotStep {
  id: string;
  type: 'send_message' | 'pause' | 'condition' | 'action' | 'validation' | 'stop_salesbot';
  config: Record<string, unknown>;
}

export const EMPTY_FLOW: SalesBotFlow = { trigger: { keywords: [] }, steps: [] };

function stepCount(flow: unknown): number {
  const steps = (flow as SalesBotFlow)?.steps;
  return Array.isArray(steps) ? steps.length : 0;
}

export async function listSalesBots(accountId: string) {
  const bots = await prisma.salesBot.findMany({
    where: { accountId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, description: true, active: true, flow: true, createdAt: true, updatedAt: true },
  });
  return bots.map(({ flow, ...rest }) => ({ ...rest, stepCount: stepCount(flow) }));
}

export async function getSalesBot(id: string, accountId: string) {
  return prisma.salesBot.findFirst({ where: { id, accountId } });
}

export async function createSalesBot(accountId: string, data: { name: string; description?: string }) {
  return prisma.salesBot.create({
    data: {
      accountId,
      name: data.name,
      description: data.description || null,
      active: false,
      flow: EMPTY_FLOW as any,
    },
  });
}

export async function updateSalesBot(
  id: string,
  accountId: string,
  data: { name?: string; description?: string | null; active?: boolean; flow?: SalesBotFlow }
) {
  const existing = await prisma.salesBot.findFirst({ where: { id, accountId } });
  if (!existing) return null;
  return prisma.salesBot.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
      ...(data.flow !== undefined ? { flow: data.flow as any } : {}),
    },
  });
}

export async function deleteSalesBot(id: string, accountId: string) {
  const existing = await prisma.salesBot.findFirst({ where: { id, accountId } });
  if (!existing) return false;
  // Runs/logs referenciam salesBotId com onDelete: Restrict (padrão do
  // Prisma) — apaga o histórico de execuções primeiro pra não travar no bot
  // que já rodou de verdade.
  await prisma.salesBotRunLog.deleteMany({ where: { run: { salesBotId: id } } });
  await prisma.salesBotRun.deleteMany({ where: { salesBotId: id } });
  await prisma.salesBot.delete({ where: { id } });
  return true;
}

export async function listSalesBotRuns(salesBotId: string, accountId: string) {
  const bot = await prisma.salesBot.findFirst({ where: { id: salesBotId, accountId } });
  if (!bot) return null;
  const runs = await prisma.salesBotRun.findMany({
    where: { salesBotId },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { logs: { orderBy: { createdAt: 'asc' } } },
  });
  const leadIds = Array.from(new Set(runs.map((r) => r.leadId)));
  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true } });
  const leadNameById = new Map(leads.map((l) => [l.id, l.name]));
  return runs.map((r) => ({ ...r, leadName: leadNameById.get(r.leadId) || '—' }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Motor de execução
// ═══════════════════════════════════════════════════════════════════════════

const MAX_STEPS_PER_INVOCATION = 25; // trava contra loop infinito (condição mal configurada apontando pra si mesma, etc.)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** minúsculo + sem acento — pra "vim do site" bater com "Vim do Site" e "vim do sítio". */
function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

async function logStep(runId: string, step: SalesBotStep, detail: Record<string, unknown>): Promise<void> {
  await prisma.salesBotRunLog
    .create({ data: { runId, stepId: step.id, stepType: step.type, detail: detail as any } })
    .catch((err) => console.error('[SalesBot] Falha ao gravar log de execução:', err));
}

async function finishRun(runId: string, status: 'COMPLETED' | 'STOPPED' | 'ERROR', reason?: string): Promise<void> {
  await prisma.salesBotRun
    .update({ where: { id: runId }, data: { status, stopReason: reason, currentStepId: null } })
    .catch((err) => console.error('[SalesBot] Falha ao encerrar run:', err));
}

function validateText(text: string, type: string, regex?: string): boolean {
  const t = text.trim();
  switch (type) {
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t);
    case 'phone': return t.replace(/\D/g, '').length >= 10;
    // CPF/CNPJ: só checa quantidade de dígitos (sem dígito verificador) —
    // suficiente pro MVP; um valor com a quantidade certa de dígitos mas
    // inválido de verdade passa aqui e só seria pego depois, manualmente.
    case 'cpf': return t.replace(/\D/g, '').length === 11;
    case 'cnpj': return t.replace(/\D/g, '').length === 14;
    case 'number': return t !== '' && !isNaN(Number(t.replace(',', '.')));
    case 'regex':
      if (!regex) return false;
      try { return new RegExp(regex).test(t); } catch { return false; }
    case 'text':
    default:
      return t.length > 0;
  }
}

/** Valor "atual" do lead pro campo escolhido no nó de Condição. */
function conditionActualValue(
  field: string,
  customField: string | undefined,
  lead: { name: string; tags: string[]; customFields: unknown; contact: { name: string; email: string | null; phone: string | null; whatsappPhone: string | null } | null; stage: { name: string } | null },
  incomingText: string
): string {
  switch (field) {
    case 'last_message': return incomingText;
    case 'name': return lead.contact?.name || lead.name || '';
    case 'email': return lead.contact?.email || '';
    case 'phone': return lead.contact?.phone || lead.contact?.whatsappPhone || '';
    case 'stage': return lead.stage?.name || '';
    case 'tag': return (lead.tags || []).join(',');
    case 'custom': return customField ? String((lead.customFields as any)?.[customField] ?? '') : '';
    default: return '';
  }
}

function evaluateCondition(config: Record<string, unknown>, lead: Parameters<typeof conditionActualValue>[2], incomingText: string): boolean {
  const field = String(config.field || '');
  const operator = String(config.operator || 'equals');
  const actual = conditionActualValue(field, config.customField as string | undefined, lead, incomingText).trim().toLowerCase();
  const expected = String(config.value ?? '').trim().toLowerCase();
  switch (operator) {
    case 'equals': return actual === expected;
    case 'not_equals': return actual !== expected;
    case 'contains': return actual.includes(expected);
    case 'not_contains': return !actual.includes(expected);
    case 'starts_with': return actual.startsWith(expected);
    case 'exists': return actual.length > 0;
    case 'not_exists': return actual.length === 0;
    default: return false;
  }
}

/** Ações no CRM disparadas pelo bot. 'webhook' fica fora do MVP (retorna false). */
async function executeAction(leadId: string, step: SalesBotStep): Promise<boolean> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return false;
  const actionType = String(step.config.actionType || '');
  try {
    switch (actionType) {
      case 'assign': {
        const agentId = String(step.config.agentId || '');
        if (!agentId) return false;
        await updateLead(lead.id, lead.accountId, { userId: agentId } as any);
        return true;
      }
      case 'move_stage': {
        const stageId = String(step.config.stageId || '');
        if (!stageId) return false;
        await updateLeadStage(lead.id, lead.accountId, stageId);
        return true;
      }
      case 'add_tag': {
        const tag = String(step.config.tag || '').trim();
        if (!tag) return false;
        const tags = Array.from(new Set([...(lead.tags || []), tag]));
        await updateLead(lead.id, lead.accountId, { tags } as any);
        return true;
      }
      case 'remove_tag': {
        const tag = String(step.config.tag || '').trim();
        const tags = (lead.tags || []).filter((t) => t !== tag);
        await updateLead(lead.id, lead.accountId, { tags } as any);
        return true;
      }
      case 'set_field': {
        const fieldName = String(step.config.fieldName || '');
        if (!fieldName) return false;
        const cf = { ...((lead.customFields as any) || {}), [fieldName]: step.config.fieldValue };
        await updateLead(lead.id, lead.accountId, { customFields: cf } as any);
        return true;
      }
      default:
        return false; // 'webhook' — fora do MVP
    }
  } catch (err) {
    console.error('[SalesBot] Falha ao executar ação:', err);
    return false;
  }
}

async function saveValidatedField(leadId: string, field: string, value: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { accountId: true, customFields: true } });
  if (!lead) return;
  const cf = { ...((lead.customFields as any) || {}), [field]: value.trim() };
  await updateLead(leadId, lead.accountId, { customFields: cf } as any).catch(() => {});
}

/** Executa o fluxo a partir de um passo, até pausar (aguardar resposta/tempo)
 *  ou terminar (Parar bot / erro / fim do fluxo). incomingText é a mensagem
 *  que originou esta chamada — usada pelo nó de Condição ("last_message") e
 *  pelo nó de Validação; vazia quando é a retomada de uma pausa por TEMPO
 *  (não veio nenhuma mensagem nova, só o prazo venceu). */
async function executeStepsFrom(
  run: SalesBotRun,
  bot: { flow: unknown },
  startStepId: string,
  io: unknown,
  incomingText: string
): Promise<void> {
  const flow = bot.flow as SalesBotFlow;
  const steps = flow?.steps || [];
  const stepById = new Map(steps.map((s) => [s.id, s]));
  let currentId: string | null = startStepId;
  let iterations = 0;

  while (currentId && iterations < MAX_STEPS_PER_INVOCATION) {
    iterations++;
    const step = stepById.get(currentId);
    if (!step) {
      await finishRun(run.id, 'ERROR', `Passo "${currentId}" não existe mais no fluxo`);
      return;
    }
    const idx = steps.findIndex((s) => s.id === currentId);
    const nextDefaultId: string | null = steps[idx + 1]?.id ?? null;

    if (step.type === 'send_message') {
      const message = String(step.config.message || '');
      const buttons = Array.isArray(step.config.buttons) ? (step.config.buttons as unknown[]).map(String).filter(Boolean) : undefined;
      const delaySec = Number(step.config.delay || 0);
      if (delaySec > 0 && delaySec <= 30) await sleep(delaySec * 1000);
      else if (delaySec > 30) console.warn(`[SalesBot] delay de ${delaySec}s no passo ${step.id} ignorado — use um passo "Pausar" para esperas longas (sobrevive a restart, isto não).`);

      const lead = await prisma.lead.findUnique({ where: { id: run.leadId }, select: { accountId: true } });
      if (!lead) { await finishRun(run.id, 'ERROR', 'Lead não existe mais'); return; }
      const result = await sendOutboundWhatsApp({ accountId: lead.accountId, leadId: run.leadId, content: message, buttons, io: io as any });
      await logStep(run.id, step, { ok: result.success, error: result.success ? undefined : result.error });
      if (!result.success) { await finishRun(run.id, 'ERROR', `Falha ao enviar mensagem: ${result.error}`); return; }
      currentId = nextDefaultId;
      continue;
    }

    if (step.type === 'pause') {
      const pauseType = String(step.config.pauseType || 'time');
      if (pauseType === 'response') {
        const timeoutHours = Number(step.config.timeout || 24);
        await prisma.salesBotRun.update({
          where: { id: run.id },
          data: { status: 'WAITING_REPLY', currentStepId: nextDefaultId, resumeAt: new Date(Date.now() + timeoutHours * 3_600_000) },
        });
        await logStep(run.id, step, { waiting: 'response', timeoutHours });
        return;
      }
      if (pauseType === 'time') {
        const duration = Number(step.config.duration || 1);
        const unit = String(step.config.unit || 'hours');
        const ms = duration * (unit === 'minutes' ? 60_000 : unit === 'days' ? 86_400_000 : 3_600_000);
        await prisma.salesBotRun.update({
          where: { id: run.id },
          data: { status: 'WAITING_TIME', currentStepId: nextDefaultId, resumeAt: new Date(Date.now() + ms) },
        });
        await logStep(run.id, step, { waiting: 'time', ms });
        return;
      }
      // pauseType === 'event' — a tela nem tem campo pra isso hoje; sem
      // suporte, é melhor errar alto do que travar a run esperando pra sempre.
      await logStep(run.id, step, { error: 'pauseType "event" não é suportado ainda' });
      await finishRun(run.id, 'ERROR', 'Passo de pausa por evento não é suportado ainda');
      return;
    }

    if (step.type === 'condition') {
      const lead = await prisma.lead.findUnique({ where: { id: run.leadId }, include: { contact: true, stage: true } });
      if (!lead) { await finishRun(run.id, 'ERROR', 'Lead não existe mais'); return; }
      const result = evaluateCondition(step.config, lead as any, incomingText);
      await logStep(run.id, step, { result });
      currentId = (result ? (step.config.trueStepId as string) : (step.config.falseStepId as string)) || null;
      continue;
    }

    if (step.type === 'action') {
      const ok = await executeAction(run.leadId, step);
      await logStep(run.id, step, { ok, actionType: step.config.actionType });
      currentId = nextDefaultId;
      continue;
    }

    if (step.type === 'validation') {
      const validationType = String(step.config.validationType || 'text');
      const valid = validateText(incomingText, validationType, step.config.regex as string | undefined);
      if (valid) {
        const field = String(step.config.field || '');
        if (field) await saveValidatedField(run.leadId, field, incomingText);
        await logStep(run.id, step, { valid: true });
        currentId = nextDefaultId;
        continue;
      }
      // Inválido: já tentamos antes nesse mesmo passo? (conta pelos próprios
      // logs — evita precisar de um contador dedicado no schema.)
      const attempts = await prisma.salesBotRunLog.count({ where: { runId: run.id, stepId: step.id } });
      await logStep(run.id, step, { valid: false, attempt: attempts + 1 });
      const retry = !!step.config.retry;
      if (retry && attempts < 4) {
        const errorMessage = String(step.config.errorMessage || 'Não entendi, pode tentar de novo?');
        const lead = await prisma.lead.findUnique({ where: { id: run.leadId }, select: { accountId: true } });
        if (lead) await sendOutboundWhatsApp({ accountId: lead.accountId, leadId: run.leadId, content: errorMessage, io: io as any });
        await prisma.salesBotRun.update({
          where: { id: run.id },
          data: { status: 'WAITING_REPLY', currentStepId: step.id, resumeAt: new Date(Date.now() + 24 * 3_600_000) },
        });
        return;
      }
      if (retry) { await finishRun(run.id, 'ERROR', 'Validação excedeu o número de tentativas'); return; }
      // retry=false: segue mesmo com o valor não validando.
      currentId = nextDefaultId;
      continue;
    }

    if (step.type === 'stop_salesbot') {
      if (step.config.sendFinalMessage) {
        const finalMessage = String(step.config.finalMessage || '');
        if (finalMessage) {
          const lead = await prisma.lead.findUnique({ where: { id: run.leadId }, select: { accountId: true } });
          if (lead) await sendOutboundWhatsApp({ accountId: lead.accountId, leadId: run.leadId, content: finalMessage, io: io as any });
        }
      }
      await logStep(run.id, step, { reason: step.config.reason });
      await finishRun(run.id, 'COMPLETED');
      return;
    }

    // Qualquer outro tipo (reação, comentário, list_message, etc.) está fora
    // do MVP — a paleta do editor nem deveria oferecer, mas se um flow antigo
    // ou editado manualmente tiver um, erra alto em vez de travar em silêncio.
    await logStep(run.id, step, { error: `tipo de passo "${step.type}" não é suportado` });
    await finishRun(run.id, 'ERROR', `Tipo de passo "${step.type}" não é suportado`);
    return;
  }

  if (iterations >= MAX_STEPS_PER_INVOCATION) {
    await finishRun(run.id, 'ERROR', 'Fluxo excedeu o limite de passos numa única execução (possível loop)');
  } else if (!currentId) {
    await finishRun(run.id, 'COMPLETED');
  }
}

/** Chamado nos dois pontos de entrada de mensagem inbound (Baileys/QR e
 *  WhatsApp Cloud API) — decide se essa mensagem pertence a um SalesBot
 *  (continuando uma run já em andamento, ou disparando uma nova por
 *  palavra-chave). Retorna true quando a mensagem foi "consumida" pelo bot,
 *  sinal pros dois pontos de entrada não deixarem template/IA responderem
 *  em cima da mesma mensagem — mesma exclusividade que já existe entre eles. */
export async function maybeSalesBotStep(accountId: string, leadId: string, text: string, io: unknown): Promise<boolean> {
  try {
    const activeRun = await prisma.salesBotRun.findFirst({
      where: { leadId, status: { in: ['RUNNING', 'WAITING_REPLY', 'WAITING_TIME'] } },
      orderBy: { updatedAt: 'desc' },
    });
    if (activeRun) {
      // A conversa já "pertence" a um bot — não deixa template/IA responderem
      // por cima, mesmo se ele não estiver esperando ESTA mensagem específica
      // agora (ex.: WAITING_TIME rodando em paralelo a uma msg avulsa do lead).
      if (activeRun.status !== 'WAITING_REPLY' || !activeRun.currentStepId) return true;
      const bot = await prisma.salesBot.findUnique({ where: { id: activeRun.salesBotId } });
      if (!bot) { await finishRun(activeRun.id, 'ERROR', 'SalesBot foi excluído'); return true; }
      await executeStepsFrom(activeRun, bot, activeRun.currentStepId, io, text);
      return true;
    }

    const bots = await prisma.salesBot.findMany({ where: { accountId, active: true }, orderBy: { createdAt: 'asc' } });
    const normalizedText = normalize(text);
    for (const bot of bots) {
      const flow = bot.flow as unknown as SalesBotFlow;
      const keywords = flow?.trigger?.keywords || [];
      if (!flow?.steps?.length || !keywords.length) continue;
      const matched = keywords.some((k) => k.trim() && normalizedText.includes(normalize(k)));
      if (matched) {
        const run = await prisma.salesBotRun.create({
          data: { accountId, salesBotId: bot.id, leadId, status: 'RUNNING', currentStepId: flow.steps[0].id },
        });
        await executeStepsFrom(run, bot, flow.steps[0].id, io, text);
        return true;
      }
    }
    return false;
  } catch (err) {
    console.error('[SalesBot] Erro em maybeSalesBotStep:', err);
    return false;
  }
}

/** Inicia um SalesBot num lead específico "de fora" (usado pela ação
 *  `start_salesbot` do motor de Automações) — função NOVA, deliberadamente
 *  sem tocar em `maybeSalesBotStep` (já em produção, testado por
 *  palavra-chave). Respeita a mesma exclusividade: não inicia se o lead já
 *  tem uma run em andamento. */
export async function startSalesBotRun(accountId: string, leadId: string, botId: string, io: unknown): Promise<{ started: boolean; reason?: string }> {
  const activeRun = await prisma.salesBotRun.findFirst({
    where: { leadId, status: { in: ['RUNNING', 'WAITING_REPLY', 'WAITING_TIME'] } },
  });
  if (activeRun) return { started: false, reason: 'Lead já tem uma execução de SalesBot em andamento' };

  const bot = await prisma.salesBot.findFirst({ where: { id: botId, accountId, active: true } });
  if (!bot) return { started: false, reason: 'SalesBot não encontrado ou inativo' };

  const flow = bot.flow as unknown as SalesBotFlow;
  if (!flow?.steps?.length) return { started: false, reason: 'SalesBot sem passos configurados' };

  const run = await prisma.salesBotRun.create({
    data: { accountId, salesBotId: bot.id, leadId, status: 'RUNNING', currentStepId: flow.steps[0].id },
  });
  await executeStepsFrom(run, bot, flow.steps[0].id, io, '');
  return { started: true };
}

/** Poll periódico (setInterval em index.ts) — retoma runs WAITING_TIME cujo
 *  prazo já chegou, e desiste de runs WAITING_REPLY cujo prazo de resposta
 *  venceu sem o lead responder. Vive no Postgres (não em memória/fila), então
 *  sobrevive a um restart do processo — só atrasa até o próximo poll. */
export async function pollSalesBotRuns(io: unknown): Promise<void> {
  const now = new Date();

  const due = await prisma.salesBotRun.findMany({ where: { status: 'WAITING_TIME', resumeAt: { lte: now } } });
  for (const run of due) {
    if (!run.currentStepId) { await finishRun(run.id, 'ERROR', 'Sem passo atual pra retomar'); continue; }
    const bot = await prisma.salesBot.findUnique({ where: { id: run.salesBotId } });
    if (!bot) { await finishRun(run.id, 'ERROR', 'SalesBot foi excluído'); continue; }
    await executeStepsFrom(run, bot, run.currentStepId, io, '').catch((err) => console.error('[SalesBot] Erro ao retomar run', run.id, err));
  }

  const timedOut = await prisma.salesBotRun.findMany({ where: { status: 'WAITING_REPLY', resumeAt: { lte: now } } });
  for (const run of timedOut) {
    await finishRun(run.id, 'STOPPED', 'no_reply_timeout');
  }
}
