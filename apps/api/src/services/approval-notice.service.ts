import { PrismaClient } from '@prisma/client';
import { logActivity } from './activity.service';
import { callableFirstName } from '../lib/text';

/**
 * Aviso de crédito aprovado pra quem nunca falou no WhatsApp (Fabio 09/10,
 * Clarice: preencheu a proposta pelo site, foi aprovada no Inter e a conversa
 * estava fechada — texto comum não chega). Duas partes:
 *
 * 1. processApprovalNotices (a cada 2 min): card que entrou em "Aguardando
 *    Documentação" e cujo cliente NUNCA mandou mensagem no WhatsApp recebe o
 *    template credito_aprovado_condicoes ("seu crédito foi aprovado na
 *    pré-análise. Quer saber as condições?" + [Sim, quero saber] [Não tenho
 *    interesse]). Uma vez por card, a qualquer hora (sem janela de horário), só com o template aprovado.
 *
 * 2. maybeSendApprovalOnYes: o cliente tocou em "Sim, quero saber" → manda o
 *    texto de aprovação no formato da equipe (✅ … 📋 Resumo da proposta …),
 *    montado com as opções de aprovação que a skill do Fabio grava nas NOTAS
 *    do card (ou, sem nota, com a aba Financiamento). Nunca inventa número:
 *    todo valor tem que estar escrito no card; se faltar, avisa a equipe pra
 *    mandar à mão (a conversa já está aberta nessa hora).
 */

const prisma = new PrismaClient();

export const APPROVAL_TEMPLATE = 'credito_aprovado_condicoes';
/** Lembrete pra quem recebeu o aviso de aprovação e não respondeu (Fabio 13/10): até 3 vezes —
 *  1º 2 dias depois do aviso, os outros a cada 3 dias; 3 dias depois do 3º sem resposta o card
 *  vai pra "Lead Sem Retorno". Texto aprovado pelo Fabio, enviado à Meta como MARKETING. */
export const APPROVAL_REMINDER_TEMPLATE = 'credito_aprovado_lembrete';
const FIRST_REMINDER_AFTER_DAYS = 2;
const NEXT_REMINDER_EVERY_DAYS = 3;
const MAX_REMINDERS = 3;
const MOVE_AFTER_LAST_DAYS = 3;
const RETRY_AFTER_FAIL_MS = 6 * 60 * 60 * 1000;
const MAX_FAILED_REMINDERS = 3;
const DAY_MS = 86_400_000;
const YES_RE = /^sim,?\s*quero saber\b/i;
const RECENT_DAYS = 3;

let running = false;
let runningReminders = false;
const tplCache = new Map<string, { at: number; approved: boolean; body: string | null }>();

/** Status/texto de um template na Meta, com cache de 15 min. */
async function metaTemplate(accountId: string, name: string): Promise<{ approved: boolean; body: string | null }> {
  const hit = tplCache.get(name);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit;
  const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
  const t: any = (await listMetaTemplates(accountId).catch(() => [])).find((x: any) => x.name === name);
  const info = { at: Date.now(), approved: t?.status === 'APPROVED', body: t?.components?.find((c: any) => c.type === 'BODY')?.text || null };
  tplCache.set(name, info);
  return info;
}
const approvalTemplate = (accountId: string) => metaTemplate(accountId, APPROVAL_TEMPLATE);

/** Roda a cada 2 min (index.ts). */
export async function processApprovalNotices(io: any): Promise<void> {
  if (running) return;
  running = true;
  try {
    const leads = await prisma.lead.findMany({
      where: {
        status: 'OPEN', archived: false, isGroup: false,
        stageEnteredAt: { gte: new Date(Date.now() - RECENT_DAYS * 86_400_000) },
        stage: { name: { startsWith: 'Aguardando Document', mode: 'insensitive' } },
      },
      select: { id: true, accountId: true, name: true, customFields: true, contact: { select: { name: true } } },
    });
    for (const l of leads) {
      const cf = (l.customFields || {}) as Record<string, any>;
      if (cf._aprovTemplateAt) continue;
      // Cliente que já falou no WhatsApp segue pelo atendimento normal.
      const spoke = await prisma.message.count({ where: { leadId: l.id, direction: 'INBOUND', channel: 'WHATSAPP' } });
      if (spoke > 0) continue;
      // A equipe (Andreia) também manda esse template à mão: se já foi enviado
      // com sucesso pra esse cliente, por qualquer um, não manda de novo.
      const already = await prisma.message.count({ where: { leadId: l.id, direction: 'OUTBOUND', templateName: APPROVAL_TEMPLATE, status: { not: 'FAILED' } } });
      if (already > 0) continue;
      const tpl = await approvalTemplate(l.accountId);
      if (!tpl.approved) return; // ainda em análise na Meta — tenta na próxima rodada
      const nome = callableFirstName(cf.participante_1, l.name, l.contact?.name) || 'cliente';
      const previewText = `${(tpl.body || '').replace(/\{\{1\}\}/g, nome)}\n\n[Sim, quero saber]  [Não tenho interesse]`;
      const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
      const r = await sendOutboundWhatsAppTemplate({ accountId: l.accountId, leadId: l.id, templateName: APPROVAL_TEMPLATE, language: 'pt_BR', bodyParams: [nome], previewText, io });
      const fresh = (await prisma.lead.findUnique({ where: { id: l.id }, select: { customFields: true } }))?.customFields as Record<string, any> || {};
      if (r.success) {
        await prisma.lead.update({ where: { id: l.id }, data: { aiAutoReplyActive: true, customFields: { ...fresh, _aprovTemplateAt: new Date().toISOString() } } });
        console.log(`[Aprovação] ${l.name}: template "${APPROVAL_TEMPLATE}" enviado (cliente nunca falou no WhatsApp)`);
      } else {
        const fails = Number(fresh._aprovTemplateFails || 0) + 1;
        await prisma.lead.update({ where: { id: l.id }, data: { customFields: { ...fresh, _aprovTemplateFails: fails, ...(fails >= 3 ? { _aprovTemplateAt: 'falhou' } : {}) } } });
        console.error(`[Aprovação] ${l.name}: falha ao enviar o template (${fails}/3): ${r.error}`);
      }
    }
  } finally {
    running = false;
  }
}

export interface ReminderPlanItem { leadId: string; accountId: string; name: string; action: 'remind' | 'move'; number?: number }

/** Quem precisa de lembrete (ou de ir pra Lead Sem Retorno) agora. Só leitura — o envio é em processApprovalReminders. */
export async function planApprovalReminders(): Promise<ReminderPlanItem[]> {
  const leads = await prisma.lead.findMany({
    where: { status: 'OPEN', archived: false, isGroup: false, stage: { name: { startsWith: 'Aguardando Document', mode: 'insensitive' } } },
    select: { id: true, accountId: true, name: true },
  });
  const plan: ReminderPlanItem[] = [];
  const now = Date.now();
  for (const l of leads) {
    const tpl = await prisma.message.findFirst({
      where: { leadId: l.id, direction: 'OUTBOUND', templateName: APPROVAL_TEMPLATE, status: { not: 'FAILED' } },
      orderBy: { createdAt: 'desc' }, select: { createdAt: true },
    });
    if (!tpl) continue;
    const replied = await prisma.message.count({ where: { leadId: l.id, direction: 'INBOUND', channel: 'WHATSAPP', createdAt: { gt: tpl.createdAt } } });
    if (replied > 0) continue; // respondeu: o fluxo normal assume
    const tries = await prisma.message.findMany({
      where: { leadId: l.id, direction: 'OUTBOUND', templateName: APPROVAL_REMINDER_TEMPLATE, createdAt: { gt: tpl.createdAt } },
      orderBy: { createdAt: 'asc' }, select: { createdAt: true, status: true },
    });
    const ok = tries.filter((t) => t.status !== 'FAILED');
    if (tries.length - ok.length >= MAX_FAILED_REMINDERS) continue; // a Meta recusou várias vezes: deixa pra equipe
    const lastTry = tries[tries.length - 1];
    if (lastTry && now - lastTry.createdAt.getTime() < RETRY_AFTER_FAIL_MS) continue;
    if (ok.length >= MAX_REMINDERS) {
      if (now - ok[ok.length - 1].createdAt.getTime() >= MOVE_AFTER_LAST_DAYS * DAY_MS) plan.push({ leadId: l.id, accountId: l.accountId, name: l.name, action: 'move' });
      continue;
    }
    const dueAt = ok.length === 0 ? tpl.createdAt.getTime() + FIRST_REMINDER_AFTER_DAYS * DAY_MS : ok[ok.length - 1].createdAt.getTime() + NEXT_REMINDER_EVERY_DAYS * DAY_MS;
    if (now >= dueAt) plan.push({ leadId: l.id, accountId: l.accountId, name: l.name, action: 'remind', number: ok.length + 1 });
  }
  return plan;
}

/** Roda a cada 2 min (index.ts): manda os lembretes que venceram e move pra Lead Sem Retorno quem não respondeu aos 3. */
export async function processApprovalReminders(io: any): Promise<void> {
  if (runningReminders) return;
  runningReminders = true;
  try {
    const plan = await planApprovalReminders();
    if (!plan.length) return;
    for (const item of plan) {
      const lead = await prisma.lead.findUnique({ where: { id: item.leadId }, select: { id: true, name: true, pipelineId: true, customFields: true, stage: { select: { name: true } }, contact: { select: { name: true } } } });
      if (!lead) continue;
      if (item.action === 'remind') {
        const tpl = await metaTemplate(item.accountId, APPROVAL_REMINDER_TEMPLATE);
        if (!tpl.approved) continue; // ainda em análise na Meta — tenta na próxima rodada
        const cf = (lead.customFields || {}) as Record<string, any>;
        const nome = callableFirstName(cf.participante_1, lead.name, lead.contact?.name) || 'cliente';
        const previewText = `${(tpl.body || '').replace(/\{\{1\}\}/g, nome)}\n\n[Sim, quero saber]  [Não tenho interesse]`;
        const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
        const r = await sendOutboundWhatsAppTemplate({ accountId: item.accountId, leadId: lead.id, templateName: APPROVAL_REMINDER_TEMPLATE, language: 'pt_BR', bodyParams: [nome], previewText, io });
        if (r.success) {
          await prisma.lead.update({ where: { id: lead.id }, data: { aiAutoReplyActive: true } }).catch(() => {});
          console.log(`[Aprovação] ${lead.name}: ${item.number}º lembrete de aprovação enviado`);
        } else {
          console.error(`[Aprovação] ${lead.name}: falha no ${item.number}º lembrete: ${r.error}`);
        }
      } else {
        // 3 lembretes e nenhuma resposta: Lead Sem Retorno do mesmo funil.
        const target = (await prisma.stage.findMany({ where: { pipelineId: lead.pipelineId }, orderBy: { order: 'asc' }, select: { id: true, name: true } }))
          .find((st) => st.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().startsWith('lead sem retorno'));
        if (!target) { console.error(`[Aprovação] ${lead.name}: sem estágio "Lead Sem Retorno" no funil — card não movido`); continue; }
        const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
        await updateLeadStage(lead.id, item.accountId, target.id);
        await prisma.note.create({ data: { leadId: lead.id, type: 'STAGE_CHANGE', content: `Estágio: "${lead.stage?.name || '?'}" → "${target.name}" — por Aviso de aprovação (o cliente não respondeu ao aviso de crédito aprovado nem aos ${MAX_REMINDERS} lembretes)` } }).catch(() => {});
        logActivity({ accountId: item.accountId, userId: null, userName: 'Aviso de aprovação', action: 'lead_stage_changed', leadId: lead.id, leadName: lead.name, summary: `moveu pra "${target.name}": cliente aprovado não respondeu ao aviso nem a ${MAX_REMINDERS} lembretes` });
        io?.to(`account_${item.accountId}`).emit('lead_moved', { leadId: lead.id, stageId: target.id });
        console.log(`[Aprovação] ${lead.name}: ${MAX_REMINDERS} lembretes sem resposta → ${target.name}`);
      }
    }
  } finally {
    runningReminders = false;
  }
}

/** true = o cliente recebeu o template de aprovação ("seu crédito foi aprovado, quer saber as
 *  condições?") e AINDA NÃO respondeu nada no WhatsApp depois dele. O lembrete de documentação
 *  espera isso (Fabio 13/10): sem resposta o cliente nunca viu a lista de documentos, e o
 *  lembrete falaria de "documentos solicitados anteriormente". */
export async function isWaitingApprovalReply(leadId: string): Promise<boolean> {
  const tpl = await prisma.message.findFirst({
    where: { leadId, direction: 'OUTBOUND', templateName: APPROVAL_TEMPLATE, status: { not: 'FAILED' } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (!tpl) return false;
  const replied = await prisma.message.count({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP', createdAt: { gt: tpl.createdAt } } });
  return replied === 0;
}

interface ApprovalOption { instituicao: string; valor: string; prazo?: string; taxa?: string; primeiraParcela?: string; ultimaParcela?: string }

/** Os dígitos de um valor ("R$ 6.289,96" → "628996") aparecem no texto de onde ele veio? */
function appearsIn(value: string | undefined, source: string): boolean {
  if (!value) return true;
  const d = value.replace(/\D/g, '');
  if (!d) return true;
  return source.replace(/\D/g, ' ').split(/\s+/).some((tok) => tok.includes(d)) || source.replace(/[^\d]/g, '').includes(d);
}

/** Lê as opções aprovadas nas notas (Claude extrai; o código confere cada número). */
async function optionsFromNotes(leadId: string): Promise<ApprovalOption[] | null> {
  const notes = await prisma.note.findMany({
    where: { leadId, createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) } },
    orderBy: { createdAt: 'asc' },
    select: { content: true },
  });
  const relevant = notes.map((n) => n.content).filter((c) => /aprov/i.test(c) && /R\$\s?\d/.test(c) && !/^(Estágio:|🤖|Lead migrado|📁|Resposta automática|Movido)/.test(c));
  if (!relevant.length) return null;
  const source = relevant.join('\n\n---\n\n');
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: `Você lê notas internas de um correspondente bancário sobre a análise de crédito de um cliente e extrai as opções de crédito APROVADAS (ignore bancos reprovados, em análise ou pré-qualificados). Copie os valores EXATAMENTE como estão escritos nas notas (não calcule, não arredonde, não invente). Se a nota mais recente corrigir uma anterior, vale a mais recente. Responda SÓ com JSON: {"options":[{"instituicao":"Banco Inter","valor":"R$ 400.000,00","prazo":"240 meses","taxa":"1,19% a.m. + IPCA","primeiraParcela":"R$ 6.289,96","ultimaParcela":"R$ 5.508,12"}]} — o campo "taxa" é CURTO: só a taxa principal, sem CET e sem explicação, MAS SEMPRE com o indexador quando a nota citar um (IPCA, TR etc.) — ex.: "1,19% a.m. + IPCA" ou "21,70% a.a. (≈1,65% a.m.)"; nunca omita "+ IPCA" quando a nota diz que a taxa é indexada; campo sem informação na nota: omita. Nenhuma opção aprovada: {"options":[]}.`,
      messages: [{ role: 'user', content: source.slice(0, 12000) }],
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const data: any = await res.json().catch(() => null);
  const raw = String(data?.content?.find((b: any) => b.type === 'text')?.text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: any;
  try { parsed = JSON.parse(m[0]); } catch { return null; }
  const options: ApprovalOption[] = (parsed.options || []).filter((o: any) => o?.instituicao && o?.valor);
  // Trava contra número inventado: todo valor tem que estar escrito nas notas.
  for (const o of options) {
    for (const v of [o.valor, o.prazo, o.taxa, o.primeiraParcela, o.ultimaParcela]) {
      if (!appearsIn(v, source)) return null;
    }
  }
  return options.length ? options : null;
}

function money(v: unknown): string | undefined {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : undefined;
}

/** Sem nota de aprovação: usa a aba Financiamento do card (o que a skill preenche). */
async function optionFromCard(leadId: string): Promise<ApprovalOption[] | null> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { value: true, customFields: true } });
  const cf = (l?.customFields || {}) as Record<string, any>;
  const valor = money(cf.valor_aprovado) || money(cf.valor_credito) || money(l?.value);
  if (!cf.instituicao || !valor || !cf.primeira_parcela) return null;
  return [{
    instituicao: String(cf.instituicao),
    valor,
    prazo: cf.prazo_financ ? String(cf.prazo_financ) : undefined,
    taxa: cf.taxa_efetiva ? String(cf.taxa_efetiva) : undefined,
    primeiraParcela: money(cf.primeira_parcela),
    ultimaParcela: money(cf.ultima_parcela),
  }];
}

export function renderApprovalText(options: ApprovalOption[]): string {
  const block = (o: ApprovalOption) => [
    '📋 Resumo da proposta:',
    `🏦 Instituição: ${o.instituicao}`,
    `💰 Valor aprovado: ${o.valor}`,
    o.prazo && `📅 Prazo: ${o.prazo}`,
    o.taxa && `📈 Taxa de juros: ${o.taxa}`,
    o.primeiraParcela && `💵 1ª parcela: ${o.primeiraParcela}`,
    o.ultimaParcela && `💵 Última parcela: ${o.ultimaParcela}`,
  ].filter(Boolean).join('\n');
  const head = options.length > 1 ? `✅ Consegui ${options.length} opções de aprovação pra você escolher!` : '✅ Crédito aprovado!';
  return `${head}\n\n${options.map(block).join('\n\n')}\n\nAgora vamos para a próxima etapa do processo!`;
}

/** Texto de aprovação montado pro card (notas primeiro, aba Financiamento
 *  depois); null se faltar dado. Usado no envio e pra conferir sem enviar. */
export async function buildApprovalText(leadId: string): Promise<{ text: string; source: 'notas' | 'card' } | null> {
  // Duas tentativas nas notas antes de cair na aba Financiamento: a leitura
  // pode variar e a trava de números descarta resposta com valor que não
  // está escrito na nota.
  const fromNotes = (await optionsFromNotes(leadId).catch(() => null)) || (await optionsFromNotes(leadId).catch(() => null));
  if (fromNotes) return { text: renderApprovalText(fromNotes), source: 'notas' };
  const fromCard = await optionFromCard(leadId).catch(() => null);
  return fromCard ? { text: renderApprovalText(fromCard), source: 'card' } : null;
}

/** Cliente tocou em "Sim, quero saber" no template de aprovação. true = tratou. */
export async function maybeSendApprovalOnYes(accountId: string, leadId: string, text: string, io: any): Promise<boolean> {
  if (!YES_RE.test(text.trim())) return false;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, userId: true } });
  if (!lead) return false;
  const built = await buildApprovalText(leadId);
  if (!built) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '⚠️ O cliente tocou em "Sim, quero saber" (crédito aprovado), mas não achei as condições de aprovação nas notas nem na aba Financiamento. Mande as condições à mão — a conversa está aberta.' } }).catch(() => {});
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `${lead.name}: quer saber as condições`, body: 'Tocou em "Sim, quero saber" — mande as condições de aprovação.', leadId }).catch(() => {});
    io?.to(lead.userId ? `user_${lead.userId}` : `account_${accountId}`).emit('ai_handoff', { leadId, leadName: lead.name, reason: 'Cliente quer saber as condições da aprovação — mande à mão (não achei as condições no card).' });
    return true;
  }
  const content = built.text;
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const sent = await sendOutboundWhatsApp({ accountId, leadId, content, io });
  if (sent.success) {
    await prisma.lead.update({ where: { id: leadId }, data: { aiAutoReplyActive: true } }).catch(() => {});
    logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_replied', leadId, leadName: lead.name, summary: `mandou as condições de aprovação (dados ${built.source === 'notas' ? 'das notas' : 'do card'}) — cliente tocou em "Sim, quero saber"` });
    console.log(`[Aprovação] ${lead.name}: condições enviadas (dados ${built.source === 'notas' ? 'das notas' : 'do card'})`);
  }
  return true;
}

