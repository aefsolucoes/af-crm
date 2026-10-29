import { PrismaClient, AutomationTrigger } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp, sendOutboundWhatsAppTemplate, sendOutboundEmail } from './message.service';
import { updateLead, updateLeadStage } from './lead.service';
import { logActivity } from './activity.service';


/** minúsculo e sem acento — mesmo critério de campaign-detection.service.ts,
 *  pra "Follow Up"/"follow-up"/"FOLLOW UP" casarem igual. */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

export type AutomationActionType =
  | 'send_message'
  | 'send_template'
  | 'send_email'
  | 'assign_agent'
  | 'move_stage'
  | 'move_stage_by_name'
  | 'add_note'
  | 'add_tag'
  | 'webhook'
  | 'activate_ai'
  | 'deactivate_ai';

export interface AutomationAction {
  type: AutomationActionType;
  config: Record<string, unknown>;
}

/** Ações que falam de verdade com o cliente — se uma dessas falhar, as
 *  ações seguintes da regra (mover estágio, gravar nota) não devem rodar:
 *  elas presumem que a comunicação deu certo. Mesmo critério já usado em
 *  maybeMessageReceivedAutomations pra decidir se a mensagem foi
 *  "respondida" por automação. */
const COMMUNICATION_ACTION_TYPES = new Set<AutomationActionType>(['send_message', 'send_template', 'send_email']);

/** O cliente JÁ mandou mensagem de verdade pelo WhatsApp? (o "Proposta preenchida no site"/"🔔 Lead" é o site avisando, não o cliente falando). Decide Utilidade x Marketing. */
export async function clienteJaFalou(leadId: string): Promise<boolean> {
  const n = await prisma.message.count({
    where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP', NOT: [{ content: { contains: 'Proposta preenchida no site' } }, { content: { startsWith: '🔔' } }] },
  });
  return n > 0;
}

/** Contexto do disparo — o que muda de gatilho pra gatilho (texto da
 *  mensagem recebida, novo estágio, tag adicionada). */
export interface RunContext {
  incomingText?: string;
  newStageId?: string;
  addedTag?: string;
  /** Setor do lead — só preenchido no gatilho FORM_SUBMITTED, pra permitir
   *  uma regra por setor (ex.: template de boas-vindas diferente pra Home
   *  Equity e Financiamento Habitacional, mesmo formulário do site pros dois). */
  departmentId?: string;
  /** Mudança de etapa causada por uma proposta que chegou por E-MAIL: roda as
   *  ações internas (ligar IA, tag…) mas NÃO manda nada pro cliente — o "Recebi
   *  sua proposta" sai só quando a proposta chegar pelo WhatsApp (Fabio 10/10). */
  skipClientMessages?: boolean;
  /** Execução de uma ação que tinha sido ADIADA (delayMinutes): roda de verdade, sem agendar de novo. */
  deferredRun?: boolean;
}

type LeadForActions = {
  id: string;
  accountId: string;
  pipelineId: string;
  name: string;
  tags: string[];
  pipeline: { departmentId: string | null };
  contact: { name: string | null; phone: string | null; whatsappPhone: string | null; email: string | null } | null;
};

// ═══════════════════════════════════════════════════════════════════════════
// CRUD
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
  // {{nome}} só com nome de verdade — com número/emoji/símbolo fica vazio e a
  // frase se ajeita ("Oi {{nome}}, tudo bem?" → "Oi, tudo bem?").
  const { isCallableName } = require('../lib/text') as typeof import('../lib/text');
  const nomeCru = (lead.contact?.name || lead.name || '').trim();
  const vars: Record<string, string> = {
    nome: isCallableName(nomeCru) ? nomeCru : '',
    telefone: lead.contact?.phone || lead.contact?.whatsappPhone || '',
    mensagem_recebida: context?.incomingText || '',
  };
  return text.replace(/\{\{([^}]+)\}\}/g, (_m, key) => {
    const v = vars[String(key).trim()];
    return v !== undefined ? v : `{{${key}}}`;
  }).replace(/ +([,!?.])/g, '$1').replace(/ {2,}/g, ' ');
}

// ═══════════════════════════════════════════════════════════════════════════
// Motor de execução
// ═══════════════════════════════════════════════════════════════════════════

/** O aviso de "recebi sua proposta" já foi dado (mesmo texto nos últimos 14 dias) ou a análise nos bancos já rodou (últimos 14 dias)? Então não é proposta nova. */
async function proposalAckAlreadyDone(leadId: string, content: string): Promise<boolean> {
  const since = new Date(Date.now() - 14 * 86_400_000);
  const sent = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', createdAt: { gte: since }, content }, select: { id: true } });
  if (sent) return true;
  const analyzed = await prisma.creditAnalysis.findFirst({ where: { leadId, kind: 'RUN', dryRun: false, createdAt: { gte: since } }, select: { id: true } });
  return !!analyzed;
}

/** Template aprovado na Meta? (cache curto: o "não aprovado ainda" expira em 2 min pra pegar a aprovação logo; o "aprovado" dura 15 min) */
const tplApprovedCache = new Map<string, { at: number; ok: boolean }>();
async function metaTemplateApproved(accountId: string, departmentId: string | undefined, name: string): Promise<boolean> {
  const key = `${accountId}:${name}`;
  const hit = tplApprovedCache.get(key);
  if (hit && Date.now() - hit.at < (hit.ok ? 15 : 2) * 60_000) return hit.ok;
  const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
  const t: any = (await listMetaTemplates(accountId, departmentId).catch(() => [])).find((x: any) => x.name === name);
  const ok = t?.status === 'APPROVED';
  tplApprovedCache.set(key, { at: Date.now(), ok });
  return ok;
}

async function executeAction(action: AutomationAction, lead: LeadForActions, context: RunContext, io: unknown): Promise<boolean> {
  if (context.skipClientMessages && ['send_message', 'send_template', 'send_email'].includes(action.type)) {
    // Proposta que chegou por e-mail: o cliente não tem janela de 24 h no WhatsApp. Se a ação tem `windowClosedTemplate` APROVADO na Meta (ex.: "proposta_recebida"), a confirmação
    // vai por ele; sem o template aprovado, não manda (comportamento antigo).
    const wct = action.type === 'send_message' ? String(action.config.windowClosedTemplate || '') : '';
    if (!(wct && (await metaTemplateApproved(lead.accountId, lead.pipeline?.departmentId || undefined, wct)))) {
      console.log(`[Automation] ação "${action.type}" não enviada: proposta chegou por e-mail — a confirmação sai quando chegar pelo WhatsApp`);
      return false;
    }
  }
  switch (action.type) {
    case 'send_message': {
      const content = fillVariables(String(action.config.message || ''), lead, context);
      if (!content.trim()) return false;
      // "Recebi sua proposta" só vale pra proposta NOVA (Fabio 19/10, Mara: reabriu o card e moveu pra Pré-Análise à mão e o aviso saiu de novo, com a análise já feita).
      if (action.config.onlyForNewProposal === true && (await proposalAckAlreadyDone(lead.id, content))) {
        console.log(`[Automation] mensagem "de proposta recebida" não enviada pro lead ${lead.id}: já foi enviada ou a análise já rodou`);
        return true; // pulou de propósito: as próximas ações da regra seguem
      }
      // Janela de 24 h fechada: texto livre não sai (erro 131047). Com `windowClosedTemplate` aprovado, o MESMO texto vai pelo template (variável {{1}} = nome).
      const wct = String(action.config.windowClosedTemplate || '');
      if (wct) {
        const { whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
        if (!(await whatsappWindowOpen(lead.id)) && (await metaTemplateApproved(lead.accountId, lead.pipeline?.departmentId || undefined, wct))) {
          const nome = fillVariables('{{nome}}', lead, context).trim() || 'cliente';
          const viaTemplate = await sendOutboundWhatsAppTemplate({ accountId: lead.accountId, leadId: lead.id, templateName: wct, language: 'pt_BR', bodyParams: [nome], previewText: content, io: io as any });
          return viaTemplate.success;
        }
      }
      const result = await sendOutboundWhatsApp({ accountId: lead.accountId, leadId: lead.id, content, io: io as any });
      return result.success;
    }
    case 'send_template': {
      let templateName = String(action.config.templateName || '');
      if (!templateName) return false;
      const language = String(action.config.language || 'pt_BR');
      // Utilidade em vez de Marketing pra quem JÁ conversou com a gente (Fabio 23/10): `utilityTemplateName` na ação = versão de UTILIDADE do template; vale só se o cliente já mandou mensagem de verdade no WhatsApp
      // e a Meta mantém o template APROVADO como UTILITY. Quem nunca falou recebe o de marketing de sempre (`templateName`).
      let templatesMeta: any[] | null = null;
      try {
        const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
        templatesMeta = await listMetaTemplates(lead.accountId, lead.pipeline.departmentId);
      } catch { /* sem a lista da Meta: segue com o template configurado */ }
      const utilName = String(action.config.utilityTemplateName || '');
      if (utilName && templatesMeta && templatesMeta.some((t: any) => t.name === utilName && t.language === language && t.status === 'APPROVED' && t.category === 'UTILITY') && (await clienteJaFalou(lead.id))) {
        templateName = utilName;
      }
      const rawParams = Array.isArray(action.config.bodyParams) ? (action.config.bodyParams as unknown[]).map(String) : [];
      // Variável de template não pode ir vazia pra Meta: sem nome de verdade, "cliente".
      const bodyParams = rawParams.map((p) => fillVariables(p, lead, context).trim() || 'cliente');
      // Mostra o texto DE VERDADE que foi mandado (igual o envio manual pela
      // Inbox já faz) — sem isso, a conversa só mostrava 'Template "X"
      // enviado', sem dar pra saber o que o cliente recebeu. Busca o corpo
      // aprovado na Meta e preenche as variáveis; se falhar (ex.: Graph API
      // fora do ar), cai no rótulo genérico — nunca impede o envio em si.
      let previewText = `Template "${templateName}" enviado`;
      try {
        const templates = templatesMeta;
        if (!templates) throw new Error('sem lista de templates');
        const tpl = templates.find((t: any) => t.name === templateName && t.language === language);
        const bodyComponent = tpl?.components?.find((c: any) => c.type === 'BODY');
        if (bodyComponent?.text) {
          previewText = String(bodyComponent.text).replace(/\{\{(\d+)\}\}/g, (_m: string, n: string) => bodyParams[Number(n) - 1] ?? `{{${n}}}`);
          const buttonTexts = (tpl?.components?.find((c: any) => c.type === 'BUTTONS')?.buttons || []).map((b: any) => b.text).filter(Boolean);
          if (buttonTexts.length) previewText += `\n\n${buttonTexts.map((t: string) => `[${t}]`).join('  ')}`;
        }
      } catch { /* fica com o rótulo genérico */ }
      // ECONOMIA (Fabio 13/10: "evitar ao máximo o custo com templates"): com a janela de 24 h aberta (o cliente escreveu no WhatsApp nas últimas
      // ~23 h) o MESMO texto vai como mensagem normal — GRÁTIS — em vez do template pago. Os botões do template não vão (a resposta do cliente,
      // em texto, é tratada pela IA). `forceTemplate: true` na ação desliga isso.
      let result: Awaited<ReturnType<typeof sendOutboundWhatsAppTemplate>> | null = null;
      if (action.config.forceTemplate !== true && !previewText.startsWith('Template "')) {
        const lastIn = await prisma.message.findFirst({ where: { leadId: lead.id, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
        if (lastIn && Date.now() - lastIn.createdAt.getTime() < 23 * 3_600_000) {
          const livre = await sendOutboundWhatsApp({ accountId: lead.accountId, leadId: lead.id, content: previewText.replace(/\n\n(\[[^\]]+\]\s*)+$/, ''), io: io as any });
          if (livre.success) result = livre;
        }
      }
      if (!result) {
        result = await sendOutboundWhatsAppTemplate({
          accountId: lead.accountId, leadId: lead.id, templateName, language, bodyParams,
          previewText, io: io as any,
        });
      }
      // "Também por e-mail": o mesmo texto vai pro e-mail do card, se houver
      // — mesmo que o WhatsApp tenha falhado (aí o e-mail vale ainda mais).
      // É um extra: não muda o resultado da ação (não trava as seguintes).
      const email = lead.contact?.email?.trim();
      const customBody = action.config.emailBody ? fillVariables(String(action.config.emailBody), lead, context).trim() : '';
      if (action.config.alsoEmail === true && email && (customBody || !previewText.startsWith('Template "'))) {
        const { sendFollowUpEmail } = require('./email-inbox.service') as typeof import('./email-inbox.service');
        await sendFollowUpEmail({ accountId: lead.accountId, leadId: lead.id, to: email, text: customBody || previewText.replace(/\n\n(\[[^\]]+\]\s*)+$/, ''), subject: action.config.emailSubject ? fillVariables(String(action.config.emailSubject), lead, context) : null, io: io as any });
      }
      return result.success;
    }
    case 'send_email': {
      const subject = fillVariables(String(action.config.subject || ''), lead, context);
      const body = fillVariables(String(action.config.body || ''), lead, context);
      if (!subject.trim() || !body.trim()) return false;
      const email = lead.contact?.email?.trim();
      if (!email) return false;
      // "Uma vez por cliente" (ex.: e-mail "Sua pré-análise foi aprovada" ao
      // entrar em Aguardando Documentação — card que volta pra etapa não recebe de novo).
      if (action.config.oncePerLead === true) {
        const already = await prisma.message.findFirst({ where: { leadId: lead.id, direction: 'OUTBOUND', channel: 'EMAIL', content: { startsWith: `📧 ${subject.trim()}` } }, select: { id: true } });
        if (already) return true;
      }
      // Pela caixa do comercial@ (assinatura, cópia em Enviados e na conversa
      // do card); sem caixa configurada, cai no envio simples.
      const { sendFollowUpEmail } = require('./email-inbox.service') as typeof import('./email-inbox.service');
      return sendFollowUpEmail({ accountId: lead.accountId, leadId: lead.id, to: email, text: body, subject, io: io as any });
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
    case 'move_stage_by_name': {
      // Move pro estágio X DENTRO DO FUNIL ATUAL do lead (não um id fixo) —
      // funciona igual pra qualquer setor sem precisar de uma regra por
      // setor: cada lead resolve o "seu" estágio (ex.: "Follow Up") dentro
      // do próprio funil "Vendas" onde já está.
      const stageName = norm(String(action.config.stageName || ''));
      if (!stageName) return false;
      const stages = await prisma.stage.findMany({ where: { pipelineId: lead.pipelineId } });
      const match = stages.find((s) => norm(s.name).includes(stageName));
      if (!match) return false;
      await updateLeadStage(lead.id, lead.accountId, match.id);
      return true;
    }
    case 'add_note': {
      const text = String(action.config.text || '').trim();
      if (!text) return false;
      const note = await prisma.note.create({ data: { leadId: lead.id, content: text, type: 'COMMENT' } });
      logActivity({
        accountId: lead.accountId, userId: null, userName: 'Automação', action: 'note_added',
        leadId: lead.id, leadName: lead.name, summary: `escreveu uma nota: "${text.slice(0, 80)}"`,
      });
      return !!note;
    }
    case 'add_tag': {
      const tag = String(action.config.tag || '').trim();
      if (!tag) return false;
      const tags = Array.from(new Set([...(lead.tags || []), tag]));
      await updateLead(lead.id, lead.accountId, { tags });
      return true;
    }
    case 'activate_ai': {
      // Liga a IA de auto-resposta (mesmo campo do botão "Ativar IA" da
      // Inbox) — pra automatizar exatamente esse toggle por regra (ex.:
      // "entrou em Prospecção/Follow Up" → liga sozinho), sem precisar
      // ninguém clicar conversa por conversa.
      await prisma.lead.update({ where: { id: lead.id }, data: { aiAutoReplyActive: true } });
      if (io) (io as any).to(`lead:${lead.id}`).emit('lead_ai_toggled', { leadId: lead.id, active: true });
      return true;
    }
    case 'deactivate_ai': {
      await prisma.lead.update({ where: { id: lead.id }, data: { aiAutoReplyActive: false } });
      if (io) (io as any).to(`lead:${lead.id}`).emit('lead_ai_toggled', { leadId: lead.id, active: false });
      return true;
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
    include: { contact: { select: { name: true, phone: true, whatsappPhone: true, email: true } }, pipeline: { select: { departmentId: true } } },
  });
  if (!lead) return;

  const actions = (rule.actions as unknown as AutomationAction[]) || [];
  const results: { type: string; ok: boolean }[] = [];
  for (let idx = 0; idx < actions.length; idx++) {
    const action = actions[idx];
    // Template com atraso (ex.: boas-vindas 10 min depois, pra não gastar mensagem da Meta se o cliente já falou com a gente): agenda e segue
    // com as outras ações (ex.: ligar a IA agora, pra ela atender quem escrever nesse meio-tempo, de graça, dentro da janela de 24 h).
    const delay = Number((action.config as any)?.delayMinutes) || 0;
    if (action.type === 'send_template' && delay > 0 && !context.deferredRun && !context.skipClientMessages) {
      const jaAgendado = await prisma.automationDeferred.findFirst({ where: { ruleId: rule.id, leadId, actionIndex: idx, status: { in: ['PENDING', 'RUNNING'] } }, select: { id: true } });
      if (!jaAgendado) await prisma.automationDeferred.create({ data: { accountId: lead.accountId, ruleId: rule.id, leadId, actionIndex: idx, runAt: new Date(Date.now() + delay * 60_000) } });
      results.push({ type: action.type, ok: true, deferred: true } as any);
      continue;
    }
    let ok: boolean;
    try {
      ok = await executeAction(action, lead, context, io);
      results.push({ type: action.type, ok });
    } catch (err) {
      console.error('[Automation] Falha ao executar ação', action.type, 'da regra', rule.id, err);
      results.push({ type: action.type, ok: false });
      ok = false;
    }
    // Se a ação que fala com o cliente falhou (ex.: template rejeitado pela
    // Meta), para aqui — sem isso as ações seguintes (mover estágio,
    // "Follow-up automático enviado") rodavam do mesmo jeito, escondendo a
    // falha: o card avançava como se a mensagem tivesse saído quando na
    // verdade o cliente nunca recebeu nada.
    if (!ok && COMMUNICATION_ACTION_TYPES.has(action.type)) break;
  }

  await prisma.automationLog
    .create({ data: { ruleId: rule.id, leadId, success: results.every((r) => r.ok), actionsResult: results as any } })
    .catch((err) => console.error('[Automation] Falha ao gravar log:', err));
}

/** Poll de 1 min: executa as ações adiadas que venceram. Antes de mandar o template, confere se ainda vale: se o cliente JÁ falou com a gente
 *  (a janela de 24 h está aberta, a IA/equipe responde de graça) ou já houve contato nosso, NÃO gasta o template pago. */
export async function processDeferredAutomations(io: unknown): Promise<void> {
  const due = await prisma.automationDeferred.findMany({ where: { status: 'PENDING', runAt: { lte: new Date() } }, orderBy: { runAt: 'asc' }, take: 25 });
  for (const job of due) {
    const claimed = await prisma.automationDeferred.updateMany({ where: { id: job.id, status: 'PENDING' }, data: { status: 'RUNNING' } });
    if (!claimed.count) continue;
    const finish = (status: string, note?: string) => prisma.automationDeferred.update({ where: { id: job.id }, data: { status, note: note ? note.slice(0, 300) : null, doneAt: new Date() } }).catch(() => {});
    try {
      const rule = await prisma.automationRule.findUnique({ where: { id: job.ruleId } });
      const action = rule && rule.active ? ((rule.actions as unknown as AutomationAction[]) || [])[job.actionIndex] : null;
      if (!rule || !rule.active || !action) { await finish('SKIPPED', 'regra desativada ou mudou'); continue; }
      const lead = await prisma.lead.findUnique({
        where: { id: job.leadId },
        include: { contact: { select: { name: true, phone: true, whatsappPhone: true, email: true } }, pipeline: { select: { departmentId: true } } },
      });
      if (!lead || lead.archived || lead.status !== 'OPEN') { await finish('SKIPPED', 'lead não está mais aberto'); continue; }
      if ((action.config as any)?.skipIfClientContacted !== false) {
        // Só conta WhatsApp: o e-mail da proposta do site chega como mensagem de ENTRADA no card, mas NÃO abre a janela de 24 h do WhatsApp
        // (sem o template o cliente nunca receberia a boas-vindas no WhatsApp).
        const falou = await prisma.message.findFirst({ where: { leadId: job.leadId, channel: 'WHATSAPP', createdAt: { gte: job.createdAt }, direction: { in: ['INBOUND', 'OUTBOUND'] } }, select: { direction: true } });
        if (falou) { await finish('SKIPPED', falou.direction === 'INBOUND' ? 'o cliente já falou com a gente: janela de 24 h aberta, sem gastar template' : 'já houve contato nosso com o cliente'); continue; }
      }
      if (rule.trigger === 'FORM_SUBMITTED') {
        // O lembrete das boas-vindas diz "não chegou a concluir a proposta" — falso se ela JÁ chegou (José Roberto 19/10: proposta às 19:36, lembrete às 19:40 e o cliente voltou a preencher).
        // Nesse caso não manda o texto nem o e-mail do lembrete: abre a conversa só com o "Olá, tudo bem?" (sem janela de 24 h o WhatsApp só deixa abrir com template) e a IA, que já sabe da proposta, atende.
        const propostaChegou = await prisma.message.findFirst({ where: { leadId: job.leadId, direction: 'INBOUND', content: { startsWith: '📋 Proposta' } }, select: { id: true } });
        if (propostaChegou) {
          const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
          const t = await sendOutboundWhatsAppTemplate({ accountId: lead.accountId, leadId: lead.id, templateName: 'ola_tudo_bem', language: 'pt_BR', bodyParams: [], previewText: 'Olá, tudo bem?' });
          await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: t.success ? '📨 A proposta já tinha chegado: não mandei o lembrete "não concluiu a proposta"; abri a conversa só com o "Olá, tudo bem?".' : `⚠️ A proposta já tinha chegado (lembrete "não concluiu" não enviado), mas o "Olá, tudo bem?" falhou: ${(t as any).error}` } }).catch(() => {});
          await prisma.automationLog.create({ data: { ruleId: rule.id, leadId: job.leadId, success: !!t.success, actionsResult: [{ type: action.type, ok: !!t.success, deferred: true, substituto: 'ola_tudo_bem' }] as any } }).catch(() => {});
          await finish(t.success ? 'DONE' : 'FAILED', 'proposta já chegou: só "Olá, tudo bem?"');
          continue;
        }
      }
      const ok = await executeAction(action, lead, { departmentId: lead.pipeline?.departmentId || undefined, deferredRun: true }, io);
      await prisma.automationLog.create({ data: { ruleId: rule.id, leadId: job.leadId, success: ok, actionsResult: [{ type: action.type, ok, deferred: true }] as any } }).catch(() => {});
      await finish(ok ? 'DONE' : 'FAILED', ok ? undefined : 'o envio do template falhou');
    } catch (err: any) {
      console.error('[Automation] ação adiada falhou', job.id, err?.message);
      await finish('FAILED', err?.message || 'erro');
    }
  }
}

function matchesTriggerConfig(rule: { trigger: AutomationTrigger; triggerConfig: unknown }, context: RunContext): boolean {
  const cfg = (rule.triggerConfig as Record<string, unknown>) || {};
  switch (rule.trigger) {
    case 'STAGE_CHANGE':
      return !cfg.stageId || cfg.stageId === context.newStageId;
    case 'TAG_ADDED':
      return !cfg.tag || String(cfg.tag).trim().toLowerCase() === String(context.addedTag || '').trim().toLowerCase();
    case 'FORM_SUBMITTED':
      return !cfg.departmentId || cfg.departmentId === context.departmentId;
    default:
      return true;
  }
}

/** Motor genérico — chamado nos pontos de hook de NEW_LEAD/STAGE_CHANGE/
 *  TAG_ADDED. Fire-and-forget: nunca deve travar nem quebrar quem chamou (os
 *  pontos de hook ficam em código quente — criação de lead, troca de
 *  estágio). MESSAGE_RECEIVED usa `maybeMessageReceivedAutomations` abaixo
 *  (precisa devolver se "respondeu", pra entrar na exclusividade com
 *  template/IA); INACTIVITY usa `checkInactivityAutomations`
 *  (é um poll, não um evento). */
export async function runAutomations(params: {
  accountId: string;
  trigger: AutomationTrigger;
  leadId: string;
  io: unknown;
  context?: RunContext;
}): Promise<void> {
  try {
    const parado = await prisma.lead.findUnique({ where: { id: params.leadId }, select: { customFields: true } });
    if ((parado?.customFields as any)?._autoPaused) return; // Stop total do cliente: nenhuma automação
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
 *  template/IA (só um responde por mensagem). Só considera a
 *  mensagem "respondida" se alguma regra tinha ação de responder de verdade
 *  (send_message/send_template) — uma regra que só adiciona
 *  tag não deve impedir a IA de responder depois. */
export async function maybeMessageReceivedAutomations(accountId: string, leadId: string, text: string, io: unknown): Promise<boolean> {
  try {
    const rules = await prisma.automationRule.findMany({ where: { accountId, trigger: 'MESSAGE_RECEIVED', active: true } });
    let repliedByAutomation = false;
    for (const rule of rules) {
      await executeRuleForLead(rule, leadId, io, { incomingText: text })
        .catch((err) => console.error('[Automation] Falha na regra', rule.id, err));
      const actions = (rule.actions as unknown as AutomationAction[]) || [];
      if (actions.some((a) => COMMUNICATION_ACTION_TYPES.has(a.type))) {
        repliedByAutomation = true;
      }
    }
    return repliedByAutomation;
  } catch (err) {
    console.error('[Automation] Erro em maybeMessageReceivedAutomations:', err);
    return false;
  }
}

/** Poll periódico (setInterval em index.ts) — é
 *  granularidade de dias, não de minutos, então não precisa de cadência
 *  curta. Dedupe via AutomationLog: só dispara de novo pra um lead depois
 *  de uma mensagem NOVA resetar o silêncio (evita repetir a cada poll
 *  enquanto o lead continua inativo). */
/** Hora atual em São Paulo — não depende do fuso do servidor (Railway roda
 *  em UTC), pra "só de manhã" valer o horário de Brasília de verdade. */
function currentHourSaoPaulo(): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }).format(new Date()));
}

/** Diferença em DIAS DE CALENDÁRIO (fuso de São Paulo), não em horas
 *  corridas — um lead que entrou às 23h de segunda já conta 1 dia na terça
 *  de manhã, não só depois de 24h completas (senão "sempre no dia seguinte
 *  de manhã" viraria "2 dias depois" pra quem entra à tarde). */
function calendarDaysSince(date: Date): number {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y1, m1, d1] = fmt.format(date).split('-').map(Number);
  const [y2, m2, d2] = fmt.format(new Date()).split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

export async function checkInactivityAutomations(io: unknown): Promise<void> {
  const rules = await prisma.automationRule.findMany({ where: { trigger: 'INACTIVITY', active: true } });
  for (const rule of rules) {
    try {
      const cfg = (rule.triggerConfig as any) || {};
      const days = Number(cfg.days || 3);
      if (!days || days <= 0) continue;

      // Janela de horário (opcional) — ex.: 8h-10h. Quando configurada, usa
      // dia de CALENDÁRIO em vez de "N*24h corridas" (ver calendarDaysSince),
      // e só executa a regra inteira se o poll atual cair dentro da janela —
      // fora dela, tenta de novo no próximo poll (a cada 15min), sem marcar
      // nada como "já feito" (executeRuleForLead só grava o log ao executar).
      const hasWindow = cfg.sendHourStart !== undefined && cfg.sendHourEnd !== undefined;
      if (hasWindow) {
        const hour = currentHourSaoPaulo();
        if (hour < Number(cfg.sendHourStart) || hour >= Number(cfg.sendHourEnd)) {
          console.log(`[Automation][inatividade] "${rule.name}" (${rule.id}): fora da janela (agora=${hour}h, janela=${cfg.sendHourStart}h-${cfg.sendHourEnd}h) — pulando esse poll inteiro.`);
          continue;
        }
      }

      // Etapa atual (opcional, mas fortemente recomendada) — sem isso a
      // regra pegava QUALQUER lead inativo da conta inteira (Consórcio,
      // Caixa de Entrada, qualquer setor), não só quem está de fato
      // "esperando follow-up" na etapa certa. Mesmo critério de nome usado
      // em move_stage_by_name — funciona em qualquer funil sem precisar de
      // uma regra por setor.
      //
      // Incidente real: "Prospecção" existe com o NOME IDÊNTICO nos funis de
      // Home Equity e Financiamento Habitacional — tentar diferenciar só
      // pelo nome ("Prospecção Finan"/"Prospecção Home") nunca bate com
      // nada, porque esse texto não é substring do nome real da etapa
      // ("Prospecção" sozinho). Por isso agora tem o filtro de Setor
      // abaixo, separado — stageName continua só pra etapa em si.
      const stageNamePattern = norm(String(cfg.stageName || ''));
      const departmentId = cfg.departmentId ? String(cfg.departmentId) : null;
      // Repete mesmo com o lead calado (ex.: lembrete de documento a cada N
      // dias) — sem isso, o dedupe abaixo (baseado em lastMsgAt) só dispara
      // UMA vez por período de silêncio, e só libera de novo depois que o
      // lead manda uma mensagem nova. Com essa flag, o dedupe passa a ser
      // "já disparei nos últimos N dias", não "já disparei desde a última
      // mensagem dele" — dispara de novo mesmo que ele nunca responda.
      const repeatEveryDays = cfg.repeatEveryDays === true;
      // Exclui lead com essa tag (ex.: "Pediu pra parar lembretes", marcada
      // pela IA quando o cliente reage mal a ser cobrado) — mesmo padrão de
      // onlySiteLeads, só que de exclusão em vez de inclusão.
      const excludeTag = cfg.excludeTag ? String(cfg.excludeTag) : null;
      // Só dispara depois de N dias NA ETAPA atual (Lead.stageEnteredAt) —
      // pedido do usuário: o template de documentação sai 3 dias depois do
      // card entrar em "Aguardando Documentação", não na hora. Sem isso, um
      // cliente que já estava calado havia dias recebia o lembrete assim que
      // o card mudava de etapa.
      const minDaysInStage = Number(cfg.minDaysInStage || 0);
      const stageThreshold = new Date(Date.now() - minDaysInStage * 86_400_000);

      const threshold = new Date(Date.now() - days * 86_400_000);
      const leads = await prisma.lead.findMany({
        where: {
          accountId: rule.accountId, status: 'OPEN', archived: false, isGroup: false, messages: { some: {} },
          ...(cfg.onlySiteLeads ? { tags: { has: 'Site' } } : {}),
          ...(cfg.includeTag ? { tags: { has: String(cfg.includeTag) } } : {}), // só quem tem esta tag (ex.: "Aguardando Bacen" → lembrete dos documentos do SCR)
          ...(excludeTag ? { NOT: { tags: { has: excludeTag } } } : {}),
        },
        select: {
          id: true,
          stage: { select: { name: true } },
          stageEnteredAt: true,
          pipeline: { select: { departmentId: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { createdAt: true } },
        },
      });
      // Diagnóstico (incidente real: regra ativa, configuração aparentemente
      // certa, e mesmo assim um lead específico nunca recebia o follow-up —
      // sem log nenhum não dava pra saber EM QUAL filtro ele estava caindo).
      // Conta quantos leads passam em cada filtro, nessa ordem — se o número
      // já zera cedo (ex.: "stage" ou "setor"), o problema é config; se só
      // zera no "eligible"/"already", é timing/dedupe.
      let countStage = 0, countDept = 0, countEligible = 0, countAlready = 0, countExecuted = 0, countHeld = 0;
      // Lembrete de documentação (etapa "Aguardando Documentação"): espera o cliente
      // RESPONDER ao template de aprovação (Fabio 13/10) — ver isWaitingApprovalReply.
      const docReminder = stageNamePattern.includes('aguardando document');
      const { isWaitingApprovalReply } = require('./approval-notice.service') as typeof import('./approval-notice.service');

      for (const lead of leads) {
        if (stageNamePattern && !norm(lead.stage?.name || '').includes(stageNamePattern)) continue;
        countStage++;
        if (departmentId && lead.pipeline?.departmentId !== departmentId) continue;
        countDept++;
        let lastMsgAt = lead.messages[0]?.createdAt;
        if (!lastMsgAt) continue;
        if (minDaysInStage > 0 && (!lead.stageEnteredAt || lead.stageEnteredAt > stageThreshold)) continue;
        if (docReminder) {
          // Lembrete de documentação (Fabio 28/10: "veja se essa conversa foi produtiva; se fica inativo por 2 dias, retorna o lembrete"):
          // só conta conversa de verdade — mensagem do CLIENTE no WhatsApp ou de alguém da EQUIPE escrevendo à mão. Template nosso,
          // resposta automática sem o cliente ter falado e e-mail do banco não seguravam mais o lembrete por 3 dias. Parado 2 dias
          // (cfg.idleDays) → lembrete; repete a cada `days`. E não empilha: template nosso nos últimos 2 dias (ex.: "Ainda deseja
          // prosseguir?") segura até completar 2 dias.
          const idleDays = Number(cfg.idleDays || 2);
          const [conversa, ultimoTemplate] = await Promise.all([
            prisma.message.findFirst({
              where: { leadId: lead.id, channel: { not: 'EMAIL' }, OR: [{ direction: 'INBOUND' }, { direction: 'OUTBOUND', sentByUserId: { not: null } }] },
              orderBy: { createdAt: 'desc' }, select: { createdAt: true },
            }),
            prisma.message.findFirst({
              where: { leadId: lead.id, direction: 'OUTBOUND', templateName: { not: null }, status: { not: 'FAILED' } },
              orderBy: { createdAt: 'desc' }, select: { createdAt: true },
            }),
          ]);
          lastMsgAt = conversa?.createdAt || lead.stageEnteredAt || lastMsgAt;
          const parado = hasWindow ? calendarDaysSince(lastMsgAt) >= idleDays : lastMsgAt <= new Date(Date.now() - idleDays * 86_400_000);
          const semTemplateRecente = !ultimoTemplate || (hasWindow ? calendarDaysSince(ultimoTemplate.createdAt) >= idleDays : ultimoTemplate.createdAt <= new Date(Date.now() - idleDays * 86_400_000));
          if (!parado || !semTemplateRecente) continue;
          if (await isWaitingApprovalReply(lead.id)) { countHeld++; continue; }
        } else {
          const eligible = hasWindow ? calendarDaysSince(lastMsgAt) >= days : lastMsgAt <= threshold;
          if (!eligible) continue;
        }
        countEligible++;
        const already = await prisma.automationLog.findFirst({
          where: repeatEveryDays
            ? { ruleId: rule.id, leadId: lead.id, createdAt: { gt: new Date(Date.now() - days * 86_400_000) } }
            : { ruleId: rule.id, leadId: lead.id, createdAt: { gt: lastMsgAt } },
        });
        if (already) { countAlready++; continue; }
        countExecuted++;
        await executeRuleForLead(rule, lead.id, io, {}).catch((err) => console.error('[Automation] Falha (inatividade)', rule.id, err));
      }

      console.log(`[Automation][inatividade] "${rule.name}" (${rule.id}): ${leads.length} leads na base (OPEN${cfg.onlySiteLeads ? '+Site' : ''}${excludeTag ? `, sem tag "${excludeTag}"` : ''}) → ${countStage} bateram etapa "${cfg.stageName || '(qualquer)'}" → ${countDept} bateram setor${departmentId ? '' : ' (qualquer, sem filtro)'} → ${countEligible} elegíveis por tempo (${days}d${repeatEveryDays ? ', repete mesmo calado' : ''}${minDaysInStage ? `, ${minDaysInStage}d+ na etapa` : ''}) → ${countExecuted} executados (${countAlready} já tinham disparado antes${docReminder ? `; ${countHeld} esperando resposta ao template de aprovação` : ''}).`);
    } catch (err) {
      console.error('[Automation] Erro em checkInactivityAutomations (regra ' + rule.id + '):', err);
    }
  }
}
