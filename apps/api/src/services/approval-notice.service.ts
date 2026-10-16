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
 *    interesse]). Uma vez por card, só das 07h às 21h (Fabio 14/10), só com o template aprovado.
 *
 * 2. maybeSendApprovalOnYes: o cliente tocou em "Sim, quero saber" → manda o
 *    texto de aprovação no formato da equipe (✅ … 📋 Resumo da proposta …),
 *    montado com as opções de aprovação que a skill do Fabio grava nas NOTAS
 *    do card (ou, sem nota, com a aba Financiamento). Nunca inventa número:
 *    todo valor tem que estar escrito no card; se faltar, avisa a equipe pra
 *    mandar à mão (a conversa já está aberta nessa hora).
 */

import { parseDocumentosExigidos, whichParticipant } from './credit-analysis.service';

const prisma = new PrismaClient();

// ─── Horário dos avisos ao cliente (Fabio 14/10): só das 07:00 às 21:00, horário de Brasília (UTC-3, sem horário de verão) ───
export const NOTICE_START_HOUR = 7;
export const NOTICE_END_HOUR = 21;
const BRT_MS = -3 * 3_600_000;
export function inNoticeWindow(d = new Date()): boolean {
  const h = new Date(d.getTime() + BRT_MS).getUTCHours();
  return h >= NOTICE_START_HOUR && h < NOTICE_END_HOUR;
}
/** Agora, se estiver dentro do horário; senão o próximo 07:00 de Brasília. */
export function nextNoticeStart(d = new Date()): Date {
  if (inNoticeWindow(d)) return d;
  const l = new Date(d.getTime() + BRT_MS);
  const dia = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + (l.getUTCHours() >= NOTICE_END_HOUR ? 1 : 0), NOTICE_START_HOUR, 0, 0);
  return new Date(dia - BRT_MS);
}


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
  if (!inNoticeWindow()) return; // aviso ao cliente só das 07h às 21h
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
  if (!inNoticeWindow()) return; // lembrete ao cliente só das 07h às 21h
  if (runningReminders) return;
  runningReminders = true;
  try {
    const plan = await planApprovalReminders();
    if (!plan.length) return;
    for (const item of plan) {
      const lead = await prisma.lead.findUnique({ where: { id: item.leadId }, select: { id: true, name: true, pipelineId: true, customFields: true, stage: { select: { name: true } }, contact: { select: { name: true } } } });
      if (!lead) continue;
      if ((lead.customFields as any)?._autoPaused) continue; // Stop total do cliente: sem lembrete nem mudança de etapa
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

interface ApprovalOption { quitacao?: string; troco?: string; aMenor?: boolean; documentos?: { perfil: string; itens: string[] }; instituicao: string; valor: string; liquido?: boolean; prazo?: string; taxa?: string; primeiraParcela?: string; ultimaParcela?: string; nome?: string; pedido?: string; incompleta?: boolean }

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
    o.nome && `👤 Aprovado no nome de: ${o.nome} (2º participante da proposta)`,
    o.liquido ? `💰 Valor líquido: ${o.valor}` : `💰 Valor aprovado: ${o.valor}`, // Fabio 15/10: sem o "(já descontados IOF, tarifa de cadastro e custas)"
    o.pedido && `ℹ️ Valor menor que o solicitado (você pediu ${o.pedido})`,
    o.quitacao && `🏠 Quitação do financiamento do imóvel: ${o.quitacao}`,
    o.troco && `💸 Troco pra você: ${o.troco}`,
    o.prazo && `📅 Prazo: ${o.prazo}`,
    o.taxa && `📈 Taxa de juros: ${o.taxa}`,
    o.primeiraParcela && `💵 1ª parcela: ${o.primeiraParcela}`,
    o.ultimaParcela && `💵 Última parcela: ${o.ultimaParcela}`,
  ].filter(Boolean).join('\n');
  const head = options.length > 1 ? `✅ Consegui ${options.length} opções de aprovação pra você escolher!` : '✅ Crédito aprovado!';
  const tail = options.length > 1 ? '\n\n👉 Qual dessas opções você prefere? É só me responder por aqui que eu sigo com a que você escolher.' : ''; // opção única: a mensagem acaba no resumo (Fabio 14/10)
  return `${head}\n\n${options.map(block).join('\n\n')}${tail}`;
}

// Texto da mensagem 2 (Fabio 14/10): cabeçalho único, "Documentos pessoais" + Imóvel, e os documentos do cônjuge/2º participante quando houver.
const DOCS_HEADER = 'Para seguir com a contratação do crédito encaminhar os seguintes documentos:';
const DOCS_MARK = 'encaminhar os seguintes documentos';
const DOCS_MARK_OLD = 'o banco pede os seguintes documentos';
const FALLBACK_PESSOAIS = ['Documento de identificação', 'Comprovante de residência', 'Comprovante de estado civil (certidão de nascimento ou casamento)'];
const FALLBACK_IMOVEL = ['Certidão de ônus reais/ Matrícula do imóvel', 'Inscrição Imobiliária/ IPTU', 'Capa do IPTU com as metragens'];

/** Linhas "• ..." de cada seção ("*Proponente:*" / "*Imóvel:*") da Resposta rápida "Documentos Home Equity" — a equipe edita lá. */
function parseDocsTemplate(body: string | null | undefined): { pessoais: string[]; imovel: string[] } {
  const out = { pessoais: [] as string[], imovel: [] as string[] };
  let cur: 'pessoais' | 'imovel' | null = null;
  for (const raw of String(body || '').split('\n')) {
    const l = raw.trim();
    if (/^\*?\s*proponente/i.test(l)) { cur = 'pessoais'; continue; }
    if (/^\*?\s*im[oó]vel/i.test(l)) { cur = 'imovel'; continue; }
    const m = /^[•\-*]\s*(.+)$/.exec(l);
    if (cur && m) out[cur].push(m[1].trim());
  }
  return out;
}

/** Mensagem 2 do aviso de aprovação: documentos pessoais (+ os de renda SÓ se o banco pediu comprovação de renda) + os do CÔNJUGE/2º PARTICIPANTE quando houver + os do imóvel. */
export async function buildDocsText(accountId: string, options: ApprovalOption[], leadId?: string): Promise<string> {
  const tpl = await docsTemplate(accountId);
  const parsed = parseDocsTemplate(tpl?.body);
  const pessoais = parsed.pessoais.length ? parsed.pessoais : FALLBACK_PESSOAIS;
  const imovel = parsed.imovel.length ? parsed.imovel : FALLBACK_IMOVEL;
  // Cliente disse no formulário que NÃO possui a certidão de ônus/matrícula (ou não sabe): ela é ESSENCIAL (sem ela a contratação não conclui) — a lista continua pedindo e ele é convidado a contar o que tem do imóvel (Fabio 15/10).
  let semCertidao = false;
  if (leadId) {
    const l0 = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    semCertidao = /^nao/.test(String(((l0?.customFields || {}) as Record<string, any>).possui_certidao || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim());
  }
  const renda: string[] = [];
  for (const o of options) for (const d of o.documentos?.itens || []) if (!renda.includes(d)) renda.push(d);
  const lista = [...pessoais, ...renda].map((d) => `• ${d}`).join('\n');
  let conjuge = '';
  if (leadId) {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const p2 = String(((lead?.customFields || {}) as Record<string, any>).participante_2 || '').trim();
    if (p2) conjuge = `\n\n*Documentos pessoais do cônjuge / 2º participante (${p2}):*\n${pessoais.map((d) => `• ${d}`).join('\n')}\n_Se moram juntos, o comprovante de residência e a certidão podem ser os mesmos._`;
  }
  return `${DOCS_HEADER}\n\n*Documentos pessoais*\n${lista}${conjuge}\n\n*Imóvel:*\n${imovel.map((d) => `• ${d}`).join('\n')}${semCertidao ? '\n_Se você não tiver a certidão de ônus/matrícula, me conta o que você tem do imóvel (escritura, matrícula, IPTU ou qualquer documento com o número da matrícula) que eu te ajudo._' : ''}`;
}

/** Texto de aprovação montado pro card (notas primeiro, aba Financiamento
 *  depois); null se faltar dado. Usado no envio e pra conferir sem enviar. */
/** Quando a análise foi feita no nome do 2º participante (ex.: titular invertido), o aviso ao cliente tem que dizer em nome de quem
 *  saiu a aprovação. Devolve, por instituição do texto, o nome (ou null quando é o titular normal). */
async function holderResolver(leadId: string): Promise<(instituicao: string) => string | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const main = String(cf.participante_1 || lead?.name || '');
  const p2 = String(cf.participante_2 || '').trim();
  const norm = (s: string) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const analyses = await prisma.creditAnalysis.findMany({
    where: { leadId, status: { in: ['APPROVED', 'CONDITIONAL'] }, dryRun: false },
    orderBy: { createdAt: 'asc' }, select: { bank: true, holderName: true },
  });
  const overrides = await prisma.creditOverride.findMany({ where: { leadId }, select: { bank: true, data: true } });
  const byBank = new Map<string, string>();
  for (const a of analyses) if (a.holderName) byBank.set(a.bank, a.holderName);
  const inverted = new Set(overrides.filter((o) => (o.data as any)?.inverter === true).map((o) => o.bank));
  const bankOf = (inst: string) => (/inter/i.test(inst) ? 'INTER' : /creditas/i.test(inst) ? 'CREDITAS' : /santander|credimorar/i.test(inst) ? 'CREDIMORAR' : '');
  return (inst: string) => {
    const bank = bankOf(inst);
    const holder = (bank && byBank.get(bank)) || (bank && inverted.has(bank) && p2 ? p2 : '') || '';
    return holder && norm(holder) !== norm(main) ? holder : null;
  };
}

async function withHolders(leadId: string, options: ApprovalOption[]): Promise<ApprovalOption[]> {
  const holder = await holderResolver(leadId).catch(() => null);
  return holder ? options.map((o) => ({ ...o, nome: holder(o.instituicao) || undefined })) : options;
}

/** Imóvel com financiamento (Fabio 15/10): na aprovação, diz quanto do valor vai QUITAR o imóvel e quanto sobra de TROCO pro cliente. O saldo vem do card ("Saldo devedor", que o print
 *  atualiza) ou, sem ele, do que a proposta informou em "Valor que falta para quitação". Só aparece quando o valor aprovado cobre a quitação. */
async function withPayoff(leadId: string, options: ApprovalOption[]): Promise<ApprovalOption[]> {
  try {
    const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const cf = (l?.customFields || {}) as Record<string, any>;
    const { parseBrl, proposalFinancing } = require('./saldo-devedor.service') as typeof import('./saldo-devedor.service');
    let saldo = parseBrl(cf.saldo_devedor);
    if (!(saldo > 0)) { const p = await proposalFinancing(leadId); if (p && p.quitado === false) saldo = p.falta; }
    if (!(saldo > 0)) return options;
    const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    return options.map((o) => {
      const valor = parseBrl(o.valor);
      return valor > saldo ? { ...o, quitacao: brl(saldo), troco: brl(Math.round((valor - saldo) * 100) / 100) } : o;
    });
  } catch { return options; }
}

/** Opções aprovadas que a aba Análise de Crédito já registrou (a mais recente de cada banco, com valor). Números estruturados:
 *  é a fonte preferida; se não houver, cai nas notas e depois no card. */
const normN = (t: string) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** 1 = titular, 2 = 2º participante (esposa/segundo proponente): pelo CPF da análise, senão pelo nome mais parecido (ver whichParticipant). */
async function holderBucketer(leadId: string): Promise<(holder?: string | null, holderCpf?: string | null) => 1 | 2> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const card = { name1: String(cf.participante_1 || lead?.name || ''), name2: String(cf.participante_2 || ''), cpf1: cf.cpf_1, cpf2: cf.cpf_2 };
  return (holder, holderCpf) => whichParticipant(card, holder, holderCpf);
}

async function optionsFromAnalyses(leadId: string): Promise<ApprovalOption[] | null> {
  const rows = await prisma.creditAnalysis.findMany({
    where: { leadId, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL', 'REJECTED'] }, createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) } },
    orderBy: { createdAt: 'asc' },
  });
  const bucket = await holderBucketer(leadId);
  // O veredito MAIS RECENTE de cada banco+PARTICIPANTE vale: se depois de aprovado o banco negou (ex.: Creditas nega a análise seguinte à pré-qualificação), não oferece
  // mais essa opção — mas a negativa do titular não apaga a aprovação do 2º participante (esposa/segundo proponente) no mesmo banco.
  const byKey = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const k = `${r.bank}|${bucket(r.holderName, r.holderCpf)}`;
    if (r.status === 'REJECTED') byKey.delete(k);
    else if (r.approvedValue != null) byKey.set(k, r);
  }
  // Por banco, a aprovação de MAIOR valor (titular ou 2º participante).
  const byBank = new Map<string, (typeof rows)[number]>();
  for (const r of byKey.values()) {
    const cur = byBank.get(r.bank);
    if (!cur || (r.netValue || r.approvedValue || 0) > (cur.netValue || cur.approvedValue || 0)) byBank.set(r.bank, r);
  }
  const label: Record<string, string> = { INTER: 'Banco Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
  const options = Array.from(byBank.values())
    .sort((a, b) => (b.netValue || b.approvedValue || 0) - (a.netValue || a.approvedValue || 0))
    .map((r): ApprovalOption => ({
      aMenor: /aprovad[oa] a menor/i.test(r.detail || ''),
      instituicao: label[r.bank] || r.bank,
      // Creditas: o cliente vê só o valor LÍQUIDO (regra do Fabio) — o total (bruto) não aparece no aviso.
      valor: money(r.netValue || r.approvedValue) as string,
      liquido: !!r.netValue,
      prazo: r.termMonths ? `${r.termMonths} meses` : undefined,
      taxa: r.rate ? r.rate.replace(/(\d)\.(\d)/g, '$1,$2') : undefined, // 1.40% → 1,40%
      primeiraParcela: money(r.firstInstallment),
      ultimaParcela: money(r.lastInstallment),
      pedido: /aprovad[oa] a menor/i.test(r.detail || '') ? (/pedido:?\s*(R\$\s*[\d.]+,\d{2})/i.exec(r.detail || '') || [])[1] : undefined,
      incompleta: /aprovad[oa] a menor/i.test(r.detail || '') && !r.firstInstallment,
      documentos: /aprovad[oa] a menor/i.test(r.detail || '') ? parseDocumentosExigidos(r.detail) || undefined : undefined,
    }));
  if (!options.length) return null;
  // REGRA DO FABIO (14/10): aprovado no INTER pelo valor TOTAL — no nome do titular, da esposa ou do 2º proponente — é SEMPRE o que vai ao cliente (menor taxa, valor total).
  // Aprovação parcial ("a menor") de outro banco NÃO entra no aviso quando algum banco aprovou o valor total.
  const interTotal = options.find((o) => o.instituicao === 'Banco Inter' && !o.aMenor && !o.incompleta);
  if (interTotal) return [interTotal];
  const totais = options.filter((o) => !o.aMenor);
  return totais.length ? totais : options;
}

/** Bancos que APROVARAM (último veredito de cada banco+participante) mas ainda sem os números gravados — o aviso espera, senão sai só a outra opção (Alexandre/Larissa, 14/10). */
export async function aprovadasSemNumeros(leadId: string): Promise<string[]> {
  const rows = await prisma.creditAnalysis.findMany({
    where: { leadId, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL', 'REJECTED'] }, createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) } },
    orderBy: { createdAt: 'desc' },
  });
  const bucket = await holderBucketer(leadId);
  const visto = new Set<string>();
  const out = new Set<string>();
  for (const r of rows) {
    const k = `${r.bank}|${bucket(r.holderName, r.holderCpf)}`;
    if (visto.has(k)) continue;
    visto.add(k);
    if (r.status !== 'REJECTED' && r.approvedValue == null) out.add(r.bank);
  }
  return Array.from(out);
}

export async function buildApprovalText(leadId: string): Promise<{ text: string; source: 'analises' | 'notas' | 'card'; options: ApprovalOption[] } | null> {
  const fromAnalyses = await optionsFromAnalyses(leadId).catch(() => null);
  if (fromAnalyses) { const o = await withPayoff(leadId, await withHolders(leadId, fromAnalyses)); return { text: renderApprovalText(o), source: 'analises', options: o }; }
  // Duas tentativas nas notas antes de cair na aba Financiamento: a leitura
  // pode variar e a trava de números descarta resposta com valor que não
  // está escrito na nota.
  const fromNotes = (await optionsFromNotes(leadId).catch(() => null)) || (await optionsFromNotes(leadId).catch(() => null));
  if (fromNotes) { const o = await withPayoff(leadId, await withHolders(leadId, fromNotes)); return { text: renderApprovalText(o), source: 'notas', options: o }; }
  const fromCard = await optionFromCard(leadId).catch(() => null);
  if (!fromCard) return null;
  const oc = await withPayoff(leadId, await withHolders(leadId, fromCard));
  return { text: renderApprovalText(oc), source: 'card', options: oc };
}

/** Banco do PDF da simulação (Fabio 14/10): a proposta que o cliente ESCOLHEU ou, sem escolha, a de MENOR TAXA entre as aprovadas
 *  (o veredito mais recente de cada banco vale). Só UM banco por vez. */
async function pickApprovedSimulationInstitution(leadId: string): Promise<{ institution: string; why: string } | null> {
  const rows = await prisma.creditAnalysis.findMany({
    where: { leadId, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL', 'REJECTED'] }, createdAt: { gte: new Date(Date.now() - 45 * 86_400_000) } },
    orderBy: { createdAt: 'asc' },
  });
  // O PDF TEM que ser da opção que o cliente VÊ no aviso (João Henrique 15/10: o aviso oferecia o Creditas de R$ 274 mil e o PDF foi do Inter "aprovado a menor" de R$ 114 mil).
  const noAviso = await optionsFromAnalyses(leadId).catch(() => null);
  const bancosDoAviso = new Set<string>((noAviso || []).map((o) => (/inter/i.test(o.instituicao) ? 'INTER' : /creditas/i.test(o.instituicao) ? 'CREDITAS' : /santander|credimorar/i.test(o.instituicao) ? 'CREDIMORAR' : '')));
  const byBank = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    if (r.status === 'REJECTED') byBank.delete(r.bank);
    else if (r.approvedValue != null && r.bank !== 'CREDITAS' && (!noAviso || bancosDoAviso.has(r.bank))) byBank.set(r.bank, r); // Creditas: sem PDF (o simulador do portal não é a proposta aprovada)
  }
  const { pickSimulationBank } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const pick = pickSimulationBank(Array.from(byBank.values()).map((r) => ({ bank: r.bank, rate: r.rate, chosen: r.chosen, firstInstallment: r.firstInstallment })));
  if (!pick) return null;
  const map: Record<string, string> = { CREDIMORAR: 'SANTANDER', INTER: 'INTER', CREDITAS: 'CREDITAS' };
  return map[pick.bank] ? { institution: map[pick.bank], why: pick.why } : null;
}

/** Logo depois do texto com as condições de aprovação (Fabio 14/10): pede o PDF da simulação (modelo A&F) de UM banco — o que o cliente
 *  escolheu ou o de menor taxa. A extensão do banco lê os dados e o CRM manda o PDF sozinho em ~1-2 min. Nunca derruba o aviso. */
export async function requestSimulationsAfterApproval(p: { accountId: string; leadId: string; userId?: string }): Promise<string[]> {
  try {
    const pick = await pickApprovedSimulationInstitution(p.leadId);
    if (!pick) return [];
    const { requestSimulationDocs } = require('./simulation-doc.service') as typeof import('./simulation-doc.service');
    const r = await requestSimulationDocs(prisma, { accountId: p.accountId, leadId: p.leadId, institutions: [pick.institution], userId: p.userId, source: p.userId ? 'USER' : 'AI', skipIfSentWithinHours: 12 });
    if (r.created.length) {
      console.log(`[Aprovação] simulação em PDF pedida (${pick.institution} — ${pick.why}) logo depois das condições`);
      await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `📄 Simulação em PDF pedida: ${pick.institution} (${pick.why}). Sai pelo WhatsApp assim que a extensão ler no portal.` } }).catch(() => {});
    }
    return r.created.map((c) => c.institution);
  } catch (e: any) {
    console.error('[Aprovação] não consegui pedir o PDF da simulação:', e?.message);
    return [];
  }
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
    logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_replied', leadId, leadName: lead.name, summary: `mandou as condições de aprovação (dados ${built.source === 'analises' ? 'das análises de crédito' : built.source === 'notas' ? 'das notas' : 'do card'}) — cliente tocou em "Sim, quero saber"` });
    console.log(`[Aprovação] ${lead.name}: condições enviadas (dados ${built.source === 'analises' ? 'das análises de crédito' : built.source === 'notas' ? 'das notas' : 'do card'})`);
    // Mensagem 2: documentos (uma vez só por cliente).
    if (!(await docsAlreadySent(leadId))) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const docsText = await buildDocsText(accountId, built.options, leadId);
      await sendOutboundWhatsApp({ accountId, leadId, content: docsText, io });
    }
    requestSimulationsAfterApproval({ accountId, leadId }).catch(() => {});
  }
  return true;
}

// ─── Aviso de aprovação sob demanda (botão "Avisar cliente" da aba Análise de Crédito) ───
const WINDOW_MS = 23 * 3_600_000; // janela de 24 h do WhatsApp, com folga

async function whatsappWindowOpen(leadId: string): Promise<boolean> {
  const last = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  return !!last && Date.now() - last.createdAt.getTime() < WINDOW_MS;
}

const norm = (v: string) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Lista de documentos padrão do Home Equity (Resposta rápida "Documentos Home Equity") do setor do card. */
async function docsTemplate(accountId: string) {
  return prisma.messageTemplate.findFirst({ where: { accountId, name: { contains: 'Documentos Home Equity', mode: 'insensitive' } }, select: { body: true } });
}

/** A lista de documentos já foi mandada pra esse cliente nos últimos dias? (não manda duas vezes) */
async function docsAlreadySent(leadId: string): Promise<boolean> {
  return (await prisma.message.count({ where: { leadId, direction: 'OUTBOUND', createdAt: { gte: new Date(Date.now() - 5 * 86_400_000) }, OR: [{ content: { contains: 'precisaremos da seguinte documentação' } }, { content: { contains: DOCS_MARK } }, { content: { contains: DOCS_MARK_OLD } }] } })) > 0;
}

/** Etapa "Aguardando Documentação" do funil do card, se o card ainda está ANTES dela. */
async function awaitingDocsMove(leadId: string): Promise<{ from: string; to: string; targetId: string } | null> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { pipelineId: true, stageId: true } });
  if (!lead) return null;
  const stages = await prisma.stage.findMany({ where: { pipelineId: lead.pipelineId }, orderBy: { order: 'asc' }, select: { id: true, name: true, order: true } });
  const target = stages.find((st) => /^aguardando document/i.test(norm(st.name)));
  const current = stages.find((st) => st.id === lead.stageId);
  if (!target || !current || current.order >= target.order) return null;
  return { from: current.name, to: target.name, targetId: target.id };
}

/** O que seria enviado: texto com TODAS as opções aprovadas (cada uma com o nome em que saiu, se for o 2º participante) e como vai. */
export async function previewApprovalNotice(leadId: string): Promise<{ text: string; docsText: string; options: number; mode: 'text' | 'template'; docs: { available: boolean; alreadySent: boolean }; move: { from: string; to: string } | null; warnings: string[] } | null> {
  const built = await optionsFromAnalyses(leadId).catch(() => null);
  if (!built) return null;
  // "Aprovado a menor": as parcelas certas são as da NOVA simulação com os valores aprovados (a extensão refaz). Sem elas, não avisa.
  const warnings = (built.filter((o) => o.incompleta).map((o) => `${o.instituicao}: aprovado a menor — faltam a 1ª e a última parcela (a extensão ainda não refez a simulação com os valores aprovados). Clique em "Conferir" nesse banco e tente de novo.`));
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { accountId: true } });
  // Já mandamos um resumo antes (ex.: sem as parcelas certas)? Então este é uma ATUALIZAÇÃO, e o texto diz isso.
  const anterior = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', content: { contains: 'Resumo da proposta' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  const corpoNovo = renderApprovalText(await withPayoff(leadId, await withHolders(leadId, built)));
  const semNum = await aprovadasSemNumeros(leadId);
  if (semNum.length) {
    const nomes: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
    warnings.push(`${semNum.map((b) => nomes[b] || b).join(', ')} aprovou, mas ainda sem os números (a extensão está lendo) — o aviso espera, pra não mandar só a outra opção.`);
  }
  // Como o texto diz: banco NOVO (saiu o resultado de mais um) x valores que mudaram. Compara bancos e números do último resumo — não o texto inteiro
  // (Iara 14/10: o formato mudou e o cliente recebeu "Atualizei os valores" sem valor nenhum ter mudado).
  const bancosAntes = anterior ? [...anterior.content.matchAll(/Institui[çc][ãa]o:\s*([^\n]+)/g)].map((m) => m[1].trim()) : [];
  const dinheiro = (t: string) => (t.match(/R\$\s*[\d.]+,\d{2}/g) || []).map((v) => v.replace(/\s/g, '')).sort().join('|');
  const bancoNovo = !!anterior && built.some((o) => !bancosAntes.includes(o.instituicao));
  const mudou = !!anterior && !bancoNovo && dinheiro(anterior.content) !== dinheiro(corpoNovo);
  // A aprovação anterior era PARCIAL ("a menor") e agora existe uma de valor TOTAL: o aviso novo substitui a anterior (Fabio 14/10).
  const eraParcial = !!anterior && /Valor menor que o solicitado/.test(anterior.content) && !/Valor menor que o solicitado/.test(corpoNovo);
  const prefixo = bancoNovo && eraParcial ? '🆕 Boa notícia! Saiu a aprovação do valor TOTAL em outro banco, com condição melhor que a anterior. Considere esta:\n\n'
    : bancoNovo ? '🆕 Saiu o resultado de mais um banco para o seu pedido. Seguem as opções aprovadas:\n\n'
    : mudou ? '🔄 Atualizei os valores da sua proposta, agora com os números certos:\n\n' : '';
  const text = `${prefixo}${corpoNovo}`;
  // O MESMO aviso (mesmas opções, mesmos números) já foi enviado? Não manda de novo igual — só se algo mudou.
  const lastSummary = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', content: { contains: 'Resumo da proposta' }, createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } }, orderBy: { createdAt: 'desc' }, select: { content: true, createdAt: true } });
  const body = renderApprovalText(await withPayoff(leadId, await withHolders(leadId, built)));
  if (lastSummary && lastSummary.content.replace(/^(🔄|🆕)[^\n]*\n\n/, '').trim() === body.trim()) {
    warnings.push(`Esse mesmo aviso (mesmos valores) já foi enviado às ${lastSummary.createdAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' })} — não vou mandar igual de novo. Se os números mudarem, o aviso novo sai como atualização.`);
  }
  const [mode, tpl, already, move] = await Promise.all([
    whatsappWindowOpen(leadId), lead ? docsTemplate(lead.accountId) : null, docsAlreadySent(leadId), awaitingDocsMove(leadId),
  ]);
  const docsText = lead ? await buildDocsText(lead.accountId, await withHolders(leadId, built), leadId) : '';
  return { text, docsText, options: built.length, mode: mode ? 'text' : 'template', docs: { available: !!tpl, alreadySent: already }, move: move ? { from: move.from, to: move.to } : null, warnings };
}

/** O cliente já recebeu um resumo e agora existe uma opção aprovada de um banco que NÃO estava nele (ex.: a Creditas saiu horas depois do Santander).
 *  Usado pela análise automática pra mandar a opção nova sozinha — a IA prometeu "vamos aguardar o resultado" e alguém precisa cumprir (Juan, 14/10). */
export async function novoBancoPendente(leadId: string): Promise<boolean> {
  const anterior = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', content: { contains: 'Resumo da proposta' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  if (!anterior) return false;
  const built = await optionsFromAnalyses(leadId).catch(() => null);
  if (!built || built.some((o) => o.incompleta)) return false;
  const antes = [...anterior.content.matchAll(/Institui[çc][ãa]o:\s*([^\n]+)/g)].map((m) => m[1].trim());
  return built.some((o) => !antes.includes(o.instituicao));
}

/** Manda a lista de documentos (Resposta rápida) se ainda não foi e se a janela de 24 h estiver aberta. */
async function sendDocsList(p: { accountId: string; leadId: string; userId?: string; io?: any }, text?: string): Promise<boolean> {
  if (!(await whatsappWindowOpen(p.leadId)) || (await docsAlreadySent(p.leadId))) return false;
  const tpl = text ? null : await docsTemplate(p.accountId);
  if (!text && !tpl) return false;
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const d = await sendOutboundWhatsApp({ accountId: p.accountId, leadId: p.leadId, content: text || tpl!.body, userId: p.userId, io: p.io });
  return !!d.success;
}

/** Move pra Aguardando Documentação (mesmo caminho do botão de mover estágio: nota, atividade e automações da etapa). */
async function moveToAwaitingDocs(p: { accountId: string; leadId: string; userId?: string; io?: any }): Promise<string | null> {
  const mv = await awaitingDocsMove(p.leadId);
  if (!mv) return null;
  const lead = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { name: true } });
  const userName = p.userId ? (await prisma.user.findUnique({ where: { id: p.userId }, select: { name: true } }))?.name || 'Usuário' : 'Análise automática';
  const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
  await updateLeadStage(p.leadId, p.accountId, mv.targetId);
  await prisma.note.create({ data: { leadId: p.leadId, type: 'STAGE_CHANGE', content: `Estágio: "${mv.from}" → "${mv.to}" — por ${userName} (cliente avisado da aprovação)` } });
  logActivity({ accountId: p.accountId, userId: p.userId || null, userName, action: 'lead_stage_changed', leadId: p.leadId, leadName: lead?.name || '', summary: `moveu de "${mv.from}" para "${mv.to}" (aviso de aprovação)` });
  const { runAutomations } = require('./automation.service') as typeof import('./automation.service');
  await runAutomations({ accountId: p.accountId, trigger: 'STAGE_CHANGE', leadId: p.leadId, io: p.io, context: { newStageId: mv.targetId } }).catch((e: any) => console.error('[Aviso de aprovação] automações da etapa:', e?.message));
  return mv.to;
}

/** Só a parte que vem DEPOIS do aviso (lista de documentos + mover a etapa) — pra completar um aviso que já foi enviado sem elas. */
export async function finishApprovalFollowUp(p: { accountId: string; leadId: string; userId?: string; io?: any; sendDocs?: boolean; moveStage?: boolean }): Promise<{ docsSent: boolean; moved: string | null }> {
  const docsSent = p.sendDocs === false ? false : await sendDocsList(p);
  const moved = p.moveStage === false ? null : await moveToAwaitingDocs(p);
  return { docsSent, moved };
}

/** Manda o aviso. Dentro da janela de 24 h vai o texto com as opções (e, se marcado, a lista de documentos); fora dela vai o template
 *  de aprovação e o texto completo sai quando o cliente tocar em "Sim, quero saber". Se marcado, move o card pra Aguardando Documentação
 *  (dispara as automações da etapa: IA ligada e e-mail "pré-análise aprovada"). */
export async function sendApprovalNoticeNow(p: { accountId: string; leadId: string; userId?: string; io?: any; sendDocs?: boolean; moveStage?: boolean; ignoreWindow?: boolean; /** aviso automático: espera o PDF da simulação ficar pronto e manda junto com o texto (Fabio 15/10) */ holdForPdf?: boolean }): Promise<{ ok: boolean; mode?: 'text' | 'template'; options?: number; docsSent?: boolean; moved?: string | null; scheduled?: boolean; at?: string; already?: boolean; waiting?: boolean; error?: string }> {
  const sendDocs = p.sendDocs !== false;
  const moveStage = p.moveStage !== false;
  const preview = await previewApprovalNotice(p.leadId);
  if (!preview) return { ok: false, error: 'Não há opção aprovada com valor pra avisar o cliente (preencha o resultado da análise).' };
  if (preview.warnings.length) return { ok: false, error: preview.warnings.join(' ') };
  const lead = await prisma.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true, name: true, customFields: true, contact: { select: { name: true } } } });
  if (!lead) return { ok: false, error: 'Card não encontrado' };
  const cf = (lead.customFields || {}) as Record<string, any>;
  // Já está na conversa? (qualquer remetente) Aviso com texto: todas as opções (banco + valor + nome) já foram enviadas; com template: o cliente recebeu e ainda não respondeu.
  // Template (janela fechada): além do "template já espera resposta", confere se o RESUMO da aprovação já foi dito antes na conversa — senão, 24 h depois, o cliente que já recebeu
  // a aprovação (e os documentos) ganhava o "Temos uma ótima notícia…" de novo (Maria Antônia, 15/10).
  const jaTem = preview.mode === 'template'
    ? ((await isWaitingApprovalReply(p.leadId)) ? { at: null as Date | null, preliminar: false } : await approvalAlreadyInChat(p.leadId, preview.text))
    : await approvalAlreadyInChat(p.leadId, preview.text);
  // Se as opções só foram ditas no aviso ANTECIPADO ("aguardando outros bancos"), o aviso final NÃO repete o resumo: manda só a lista de documentos, o pedido do PDF e move o card.
  const soComplemento = !!jaTem?.preliminar;
  if (jaTem && !soComplemento) return { ok: false, already: true, error: `O cliente já recebeu este aviso de aprovação na conversa${jaTem.at ? ` (${fmtQuando(jaTem.at)})` : ' (template enviado, ainda sem resposta dele)'} — não reenviei.` };
  // Fora do horário (07h–21h): não manda agora — agenda pro próximo 07:00; o poller manda em ordem (processScheduledNotices).
  if (!p.ignoreWindow && !inNoticeWindow()) {
    const at = nextNoticeStart();
    await prisma.lead.update({ where: { id: p.leadId }, data: { customFields: { ...cf, _noticeAt: at.toISOString(), _noticeSeq: Date.now(), _noticeBy: p.userId || null, _noticeDocs: sendDocs, _noticeMove: moveStage } } });
    const hora = at.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `⏰ Aviso ao cliente agendado para ${hora} (os avisos só saem das ${NOTICE_START_HOUR}h às ${NOTICE_END_HOUR}h).` } }).catch(() => {});
    return { ok: true, scheduled: true, at: at.toISOString() };
  }
  let docsSent = false;
  let heldPdfId: string | undefined;
  if (preview.mode === 'text' && p.holdForPdf && !p.userId) {
    // O PDF da simulação vai JUNTO com o aviso (Fabio 15/10): pede antes, espera ficar pronto e só então manda texto + documentos + PDF, um atrás do outro.
    try {
      const pick = await pickApprovedSimulationInstitution(p.leadId);
      if (pick) {
        const { holdForNotice } = require('./simulation-doc.service') as typeof import('./simulation-doc.service');
        const h = await holdForNotice(prisma, { accountId: p.accountId, leadId: p.leadId, institution: pick.institution });
        if (h.state === 'waiting') return { ok: false, waiting: true, error: 'Aguardando o PDF da simulação ficar pronto pra mandar junto com o aviso.' };
        if (h.state === 'ready') heldPdfId = h.requestId;
      }
    } catch (e: any) { console.error('[Aprovação] espera do PDF falhou (segue sem esperar):', e?.message); }
  }
  if (preview.mode === 'text') {
    const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
    const r = soComplemento ? { success: true } : await sendOutboundWhatsApp({ accountId: p.accountId, leadId: p.leadId, content: preview.text, userId: p.userId, io: p.io });
    if (!r.success) return { ok: false, error: (r as any).error || 'Falha ao enviar' };
    // Lista de documentos (a mesma Resposta rápida da equipe), logo depois do aviso — uma vez só.
    if (sendDocs) { await new Promise((resolve) => setTimeout(resolve, 2500)); docsSent = await sendDocsList(p, preview.docsText); }
    if (heldPdfId) { // PDF pronto: sai logo depois do texto e da lista de documentos
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const { releaseHeld } = require('./simulation-doc.service') as typeof import('./simulation-doc.service');
      await releaseHeld(prisma, heldPdfId, p.io).catch((e: any) => console.error('[Aprovação] PDF da simulação não saiu junto:', e?.message));
    } else {
      requestSimulationsAfterApproval({ accountId: p.accountId, leadId: p.leadId, userId: p.userId }).catch(() => {});
    }
  } else {
    const tpl = await approvalTemplate(p.accountId);
    if (!tpl.approved) return { ok: false, error: 'A janela de 24 h do WhatsApp fechou e o template de aprovação ainda não foi aprovado pela Meta.' };
    const nome = callableFirstName(cf.participante_1, lead.name, lead.contact?.name) || 'cliente';
    const previewText = `${(tpl.body || '').replace(/\{\{1\}\}/g, nome)}\n\n[Sim, quero saber]  [Não tenho interesse]`;
    const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
    const r = await sendOutboundWhatsAppTemplate({ accountId: p.accountId, leadId: p.leadId, templateName: APPROVAL_TEMPLATE, language: 'pt_BR', bodyParams: [nome], previewText, userId: p.userId, io: p.io });
    if (!r.success) return { ok: false, error: (r as any).error || 'Falha ao enviar o template' };
    await prisma.lead.update({ where: { id: p.leadId }, data: { aiAutoReplyActive: true, customFields: { ...cf, _aprovTemplateAt: new Date().toISOString() } } });
  }
  const moved = moveStage ? await moveToAwaitingDocs(p) : null;
  // Sem as palavras "aprov"/"R$" de propósito: essa nota não pode virar fonte de condições do aviso de aprovação.
  await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `📣 Cliente avisado das opções de crédito (${preview.options} opç${preview.options === 1 ? 'ão' : 'ões'}) — ${preview.mode === 'text' ? 'texto enviado' : 'template enviado; o texto completo sai quando ele tocar em "Sim, quero saber"'}${docsSent ? '; lista de documentos enviada' : ''}${moved ? `; card movido para ${moved}` : ''}.` } });
  return { ok: true, mode: preview.mode, options: preview.options, docsSent, moved };
}

// ─── Aviso de "não aprovado" (Fabio 14/10) ───────────────────────────────────────────────────────────────
// Texto simples, com o motivo OBJETIVO (terreno / valor do imóvel abaixo do mínimo / saldo devedor / análise não aprovada) — nunca o detalhe
// interno do banco. Só 07h–21h (fora disso agenda), e só com a janela de 24 h do WhatsApp aberta (não existe template pra isso: sem janela,
// fica nota pra equipe chamar o cliente).
/** Fabio 15/10: "se já iniciou a conversa com o cliente não precisa ficar toda hora mandando 'Oi, Mauricio'" — a saudação só abre conversa (nada trocado nas últimas 12 h). */
export async function conversationActive(leadId: string, hours = 12): Promise<boolean> {
  return (await prisma.message.count({ where: { leadId, createdAt: { gte: new Date(Date.now() - hours * 3_600_000) } } })) > 0;
}
const REJECTION_MARK = 'não conseguimos aprovação';
const REJECTION_MARK_OLD = 'não conseguimos aprovar agora'; // texto antigo do aviso — ainda conta como "já avisado"
const REJECTION_TEXT = 'Oi! Tudo bem? Analisamos seu crédito junto às instituições parceiras, mas infelizmente não conseguimos aprovação para o valor solicitado no momento. Qualquer mudança na situação, estou à disposição para tentarmos novamente!';
/** Template aprovado da Meta pro aviso de reprovado (Fabio 14/10): é o que vale quando a janela de 24 h do WhatsApp está fechada. */
export const REJECTION_TEMPLATE = 'reprovacao';

// ─── Conferir a CONVERSA antes de avisar (Fabio 14/10: "a IA do CRM precisa verificar na conversa se já não foi encaminhado alguma negativa ou aprovação, pra não duplicar") ───
// Vale pra QUALQUER caminho (aviso automático, botão da tela, IA da conversa, agendado) e pra QUALQUER remetente (sistema, equipe pelo WhatsApp, IA, e-mail).
const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
const REJECTION_RX = [
  /n[ãa]o conseguimos aprova(ç[ãa]o|r)/i,
  /(infelizmente|lamento|sinto muito|n[ãa]o foi poss[ií]vel)[^.!?\n]{0,140}(reprov|negad|recusad|n[ãa]o (foi|ficou|est[aá]) aprovad|n[ãa]o aprovad|n[ãa]o conseguimos|n[ãa]o consegui)/i,
  /(cr[eé]dito|an[áa]lise|proposta|pedido|financiamento)[^.!?\n]{0,60}\b(foi|ficou|est[aá]|foram)\s+(reprovad|negad|recusad|n[ãa]o aprovad)/i,
];
export const isRejectionText = (t: string) => REJECTION_RX.some((rx) => rx.test(t));

/** O cliente já recebeu, na conversa, o aviso de que NÃO foi aprovado (dos últimos 14 dias)? Devolve a mensagem mais recente. */
export async function rejectionAlreadyInChat(leadId: string): Promise<{ at: Date } | null> {
  const msgs = await prisma.message.findMany({ where: { leadId, direction: 'OUTBOUND', createdAt: { gte: new Date(Date.now() - 14 * 86_400_000) }, NOT: { content: '' } }, orderBy: { createdAt: 'desc' }, take: 150, select: { content: true, createdAt: true } });
  const hit = msgs.find((m) => isRejectionText(m.content || ''));
  return hit ? { at: hit.createdAt } : null;
}

/** Cada opção do texto de aprovação (banco + valor + em nome de quem). */
export function approvalPairs(text: string): { inst: string; val: string; nome: string }[] {
  return flat(text).split('📋 Resumo da proposta:').slice(1).map((b) => ({
    inst: (b.match(/🏦 Instituição: (.+?)(?= 👤| 💰| ℹ️| 📅|$)/)?.[1] || '').trim(),
    val: (b.match(/💰 Valor (?:aprovado|líquido): (R\$ ?[\d.,]+)/)?.[1] || '').trim(),
    nome: (b.match(/👤 Aprovado no nome de: (.+?) \(/)?.[1] || '').trim(),
  })).filter((x) => x.inst && x.val);
}

/** TODAS as opções do aviso que ia sair (banco + valor + nome) já foram enviadas ao cliente numa mensagem de aprovação? (últimos 21 dias) */
export async function approvalAlreadyInChat(leadId: string, text: string): Promise<{ at: Date; preliminar: boolean } | null> {
  const pairs = approvalPairs(text);
  if (!pairs.length) return null;
  const msgs = await prisma.message.findMany({ where: { leadId, direction: 'OUTBOUND', createdAt: { gte: new Date(Date.now() - 21 * 86_400_000) }, content: { contains: 'Instituição:' } }, orderBy: { createdAt: 'desc' }, take: 60, select: { content: true, createdAt: true } });
  let at: Date | null = null;
  let preliminar = true; // todas as opções só foram ditas no aviso ANTECIPADO (resultado parcial)?
  for (const p of pairs) {
    const hit = msgs.find((m) => flat(m.content || '').split('📋 Resumo da proposta:').slice(1).some((b) => b.includes(p.inst) && b.includes(p.val) && (!p.nome || b.includes(p.nome))));
    if (!hit) return null;
    if (!(hit.content || '').includes(EARLY_MARK_PARTIAL)) preliminar = false;
    if (!at || hit.createdAt > at) at = hit.createdAt;
  }
  return at ? { at, preliminar } : null;
}

// ─── Aviso ANTECIPADO antes da janela de 24 h do WhatsApp fechar (Fabio 14/10) ───
// Banco lento (Creditas/Inter levam horas): antes da janela fechar o cliente recebe (a) o resumo da aprovação que já saiu + "aguardando outros bancos pra tentar taxa menor", ou
// (b) "análise em andamento", se todos ainda estão analisando. Uma vez por janela — e a mensagem pede uma resposta: quando o cliente responde, a janela de 24 h recomeça (conta da ÚLTIMA mensagem dele) e, se a análise seguir pendente, o aviso pode sair de novo na janela seguinte. O aviso FINAL depois continua saindo (só documentos/etapa, sem repetir o resumo).
export const EARLY_MARK_PARTIAL = '⏳ Já temos essa aprovação';
const EARLY_MARK_WAIT = 'análise de crédito está em andamento';
const EARLY_BEFORE_CLOSE_MS = 5 * 3_600_000; // começa a avisar quando faltam até 5 h pra janela fechar
const EARLY_DEAD_HOURS_LEAD_MS = 14 * 3_600_000; // janela que fecha fora das 07h–21h: avisa já no dia anterior (até 14 h antes), senão perde a chance

export async function sendEarlyStatusNotice(p: { accountId: string; leadId: string; variant: 'APPROVED_PARTIAL' | 'WAITING'; io?: any }): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true, name: true, customFields: true, contact: { select: { name: true } } } });
  if (!lead) return { ok: false, error: 'Card não encontrado' };
  const cf = (lead.customFields || {}) as Record<string, any>;
  const lastIn = await prisma.message.findFirst({ where: { leadId: p.leadId, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (!lastIn) return { ok: false, skipped: 'cliente nunca falou pelo WhatsApp' };
  const closeAt = lastIn.createdAt.getTime() + WINDOW_MS;
  const left = closeAt - Date.now();
  if (left <= 0) return { ok: false, skipped: 'janela já fechou' };
  if (!inNoticeWindow()) return { ok: false, skipped: 'fora do horário dos avisos' };
  const cedo = left <= EARLY_BEFORE_CLOSE_MS || (!inNoticeWindow(new Date(closeAt)) && left <= EARLY_DEAD_HOURS_LEAD_MS);
  if (!cedo) return { ok: false, skipped: 'ainda falta tempo pra janela fechar' };
  if (cf._earlyNoticeFor === lastIn.createdAt.toISOString()) return { ok: false, skipped: 'já avisado nesta janela' };
  const recente = await prisma.message.count({ where: { leadId: p.leadId, direction: 'OUTBOUND', createdAt: { gte: new Date(Date.now() - 60 * 60_000) } } });
  if (recente) return { ok: false, skipped: 'conversa recente (última hora)' };

  const nome = callableFirstName(cf.participante_1, lead.name, lead.contact?.name) || '';
  let text: string;
  if (p.variant === 'APPROVED_PARTIAL') {
    const preview = await previewApprovalNotice(p.leadId).catch(() => null);
    if (!preview || preview.warnings.length || preview.mode !== 'text') return { ok: false, skipped: 'aprovação sem números completos ainda' };
    if (await approvalAlreadyInChat(p.leadId, preview.text)) return { ok: false, skipped: 'a aprovação já está na conversa' };
    text = `${preview.text}\n\n${EARLY_MARK_PARTIAL}, mas ainda estamos aguardando o retorno de outros bancos pra tentar uma taxa de juros menor. Assim que sair o resultado, te aviso por aqui! Se puder, me responde essa mensagem pra gente manter a conversa aberta por aqui. 😉`;
  } else {
    const ja = await prisma.message.count({ where: { leadId: p.leadId, direction: 'OUTBOUND', createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) }, content: { contains: EARLY_MARK_WAIT } } });
    if (ja) return { ok: false, skipped: 'aviso de andamento já enviado' };
    const saudacao = (await conversationActive(p.leadId)) ? '' : `Oi${nome ? `, ${nome}` : ''}! `;
    text = `${saudacao}Passando pra te atualizar: a sua ${EARLY_MARK_WAIT}. Já enviamos a proposta aos bancos parceiros e estamos aguardando o retorno deles. Assim que sair o resultado, eu te aviso por aqui! Me responde essa mensagem só pra eu saber que chegou, tá? Qualquer dúvida, é só me chamar. 😊`;
  }
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId: p.accountId, leadId: p.leadId, content: text, io: p.io });
  if (!r.success) return { ok: false, error: (r as any).error || 'Falha ao enviar' };
  const fresh = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: p.leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _earlyNoticeFor: lastIn.createdAt.toISOString() } } });
  await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: p.variant === 'APPROVED_PARTIAL' ? '⏳ Aviso antecipado enviado antes da janela de 24 h fechar: já tem aprovação, aguardando os outros bancos pra tentar taxa menor.' : '⏳ Aviso antecipado enviado antes da janela de 24 h fechar: análise em andamento, aguardando o retorno dos bancos.' } }).catch(() => {});
  logActivity({ accountId: p.accountId, userId: null, userName: 'Análise automática', action: 'lead_edited', leadId: p.leadId, leadName: lead.name, summary: 'avisou o cliente (antes da janela fechar) que a análise segue em andamento' } as any);
  return { ok: true };
}

const fmtQuando = (d: Date) => d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

export async function buildRejectionText(leadId: string): Promise<{ text: string; reasons: string[] } | null> {
  if (await optionsFromAnalyses(leadId).catch(() => null)) return null; // tem opção aprovada: o aviso é o de aprovação
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true, contact: { select: { name: true } } } });
  if (!lead) return null;
  const rows = await prisma.creditAnalysis.findMany({ where: { leadId, dryRun: false, status: { in: ['FAILED', 'REJECTED', 'CHECK', 'SENT', 'INCOMPLETE'] } }, orderBy: { createdAt: 'desc' }, take: 40, select: { bank: true, status: true, detail: true } });
  const detail = rows.map((r) => r.detail || '').join(' ');
  const reasons: string[] = [];
  if (/terreno/i.test(detail)) reasons.push('o imóvel é um terreno (a maioria dos bancos não aceita)');
  if (/abaixo do m[ií]nimo/i.test(detail)) reasons.push('o valor do imóvel fica abaixo do mínimo exigido por alguns bancos');
  if (rows.some((r) => r.bank === 'CREDIMORAR' && /saldo devedor/i.test(r.detail || ''))) reasons.push('o imóvel ainda tem saldo devedor (um dos bancos não aceita)');
  if (rows.some((r) => r.status === 'REJECTED')) reasons.push(reasons.length ? 'os demais bancos não aprovaram a análise de crédito' : 'os bancos não aprovaram a análise de crédito');
  if (!reasons.length && rows.length) reasons.push('o pedido não atendeu às regras dos bancos parceiros');
  if (!reasons.length) return null;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const nome = callableFirstName(cf.participante_1, lead.name, lead.contact?.name) || 'tudo bem';
  const motivos = reasons.length > 1 ? `${reasons.slice(0, -1).join(', ')} e ${reasons[reasons.length - 1]}` : reasons[0];
  // Fabio 14/10: "a IA não precisa dar uma negativa e depois falar que tem jeito — sempre informar a negativa e mover o card pra Perdido e marcar reprovado".
  // O texto é o do template aprovado "reprovacao" (sem motivo detalhado e sem oferecer alternativa); os motivos objetivos ficam só na nota do card.
  const text = (await conversationActive(leadId)) ? REJECTION_TEXT.replace(/^Oi! Tudo bem\? /, '') : REJECTION_TEXT;
  return { text, reasons };
}

export async function sendRejectionNoticeNow(p: { accountId: string; leadId: string; userId?: string; io?: any; ignoreWindow?: boolean }): Promise<{ ok: boolean; already?: boolean; scheduled?: boolean; at?: string; via?: 'whatsapp' | 'email'; error?: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true, name: true, customFields: true } });
  if (!lead) return { ok: false, error: 'Card não encontrado' };
  const built = await buildRejectionText(p.leadId);
  if (!built) return { ok: false, error: 'Este card tem opção aprovada ou nenhum motivo claro de não aprovação.' };
  // Já avisado? Só barra se o aviso é MAIS NOVO que o último resultado ruim: o cliente que pede outro valor e volta reprovado de novo precisa saber (Fabio 14/10).
  const ultimoAviso = await rejectionAlreadyInChat(p.leadId);
  if (ultimoAviso) {
    const ultimoRuim = await prisma.creditAnalysis.findFirst({ where: { leadId: p.leadId, dryRun: false, status: { in: ['REJECTED', 'FAILED'] }, source: { not: 'AI_SIM' } }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } });
    if (!ultimoRuim || ultimoRuim.updatedAt.getTime() <= ultimoAviso.at.getTime()) return { ok: false, already: true, error: `O cliente já foi avisado da negativa na conversa em ${fmtQuando(ultimoAviso.at)} (nenhum resultado novo desde então) — não reenviei.` };
  }
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (!p.ignoreWindow && !inNoticeWindow()) {
    const at = nextNoticeStart();
    await prisma.lead.update({ where: { id: p.leadId }, data: { customFields: { ...cf, _noticeAt: at.toISOString(), _noticeSeq: Date.now(), _noticeBy: p.userId || null, _noticeKind: 'REJECTED' } } });
    const hora = at.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });
    await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `⏰ Aviso de "não aprovado" agendado para ${hora} (os avisos só saem das ${NOTICE_START_HOUR}h às ${NOTICE_END_HOUR}h).` } }).catch(() => {});
    return { ok: true, scheduled: true, at: at.toISOString() };
  }
  if (!(await whatsappWindowOpen(p.leadId))) {
    // Sem a janela de 24 h não há WhatsApp livre: vai o TEMPLATE aprovado "reprovacao" (Fabio 14/10: "tem template de reprovado"). Se ele falhar, o aviso
    // vai por e-mail (comercial@, mesmo caminho do follow-up) se o card tem e-mail; sem e-mail, fica nota pra equipe chamar o cliente.
    const tpl = await metaTemplate(p.accountId, REJECTION_TEMPLATE);
    if (tpl.approved && tpl.body) {
      const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
      const rt = await sendOutboundWhatsAppTemplate({ accountId: p.accountId, leadId: p.leadId, templateName: REJECTION_TEMPLATE, language: 'pt_BR', bodyParams: [], previewText: tpl.body, userId: p.userId, io: p.io });
      if (rt.success) {
        await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `📣 Cliente avisado por template (a janela de 24 h do WhatsApp estava fechada) que não foi aprovado (${built.reasons.join('; ')}).` } }).catch(() => {});
        logActivity({ accountId: p.accountId, userId: p.userId || null, userName: p.userId ? undefined : 'Análise automática', action: 'lead_edited', leadId: p.leadId, leadName: lead.name, summary: 'avisou por template que o cliente não foi aprovado' } as any);
        return { ok: true, via: 'whatsapp' };
      }
      console.warn(`[Aprovação] template "${REJECTION_TEMPLATE}" falhou pra ${lead.name}: ${(rt as any).error}`);
    }
    const full = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { contact: { select: { email: true } } } });
    const to = String(full?.contact?.email || cf.email_1 || '').trim();
    if (/^\S+@\S+\.\S+$/.test(to)) {
      const { sendFollowUpEmail } = require('./email-inbox.service') as typeof import('./email-inbox.service');
      const okMail = await sendFollowUpEmail({ accountId: p.accountId, leadId: p.leadId, to, text: built.text, subject: 'Sobre a sua análise de crédito — A&F Soluções Financeiras', io: p.io });
      if (okMail) {
        await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `📧 Cliente avisado por e-mail (a janela de 24 h do WhatsApp estava fechada) que não foi aprovado (${built.reasons.join('; ')}).` } }).catch(() => {});
        logActivity({ accountId: p.accountId, userId: p.userId || null, userName: p.userId ? undefined : 'Análise automática', action: 'lead_edited', leadId: p.leadId, leadName: lead.name, summary: 'avisou por e-mail que o cliente não foi aprovado' } as any);
        return { ok: true, via: 'email' };
      }
    }
    await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `⚠️ O aviso de "não aprovado" NÃO saiu: a janela de 24 h do WhatsApp fechou (não há template pra isso)${to ? ' e o e-mail falhou' : ' e o card não tem e-mail'}. Chame o cliente por ligação ou reabra a conversa.` } }).catch(() => {});
    return { ok: false, error: 'janela de 24 h fechada' };
  }
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId: p.accountId, leadId: p.leadId, content: built.text, userId: p.userId, io: p.io });
  if (!r.success) return { ok: false, error: (r as any).error || 'Falha ao enviar' };
  await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `📣 Cliente avisado que não foi aprovado (${built.reasons.join('; ')}).` } }).catch(() => {});
  logActivity({ accountId: p.accountId, userId: p.userId || null, userName: p.userId ? undefined : 'Análise automática', action: 'lead_edited', leadId: p.leadId, leadName: lead.name, summary: 'avisou o cliente que não foi aprovado' } as any);
  return { ok: true, via: 'whatsapp' };
}

/** Marca o card como REPROVADO e o tira do funil ativo (mesmo caminho do botão "Reprovado" da tela: status Perdido + rejectedAt + funil "Perdidos").
 *  Usado depois que o cliente foi avisado de que não foi aprovado (Fabio 14/10: "avise o cliente e tire eles de lá"). */
export async function markRejectedAndMove(p: { accountId: string; leadId: string; userId?: string; io?: any; motivo: string; /** não atende aos critérios dos bancos (nenhum banco chegou a reprovar): vira "Lead desqualificado" e NÃO conta como Reprovado */ disqualify?: boolean }): Promise<{ ok: boolean; error?: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true, name: true, status: true, pipeline: { select: { departmentId: true } } } });
  if (!lead) return { ok: false, error: 'Card não encontrado' };
  if (lead.status !== 'OPEN') return { ok: false, error: 'Card já não está aberto' };
  const { updateLead } = require('./lead.service') as typeof import('./lead.service');
  const { moveLeadToPerdidos } = require('./named-pipeline.service') as typeof import('./named-pipeline.service');
  // Reprovado = algum banco recusou (botão "Reprovado": status Perdido + rejectedAt). Desqualificado (Fabio 14/10: "quando não atende os critérios, coloca como
  // desqualificado") = nenhum banco reprovou, o lead não cumpre as regras (imóvel abaixo do mínimo, terreno, saldo devedor…): Perdido com motivo "Lead desqualificado — …",
  // sem rejectedAt (o painel de reprovados não conta).
  const motivo = p.disqualify ? `Lead desqualificado — ${p.motivo.replace(/^(Reprovado|Lead desqualificado)[^—]*—\s*/i, '')}`.slice(0, 280) : p.motivo;
  await updateLead(lead.id, p.accountId, { status: 'LOST', lostReason: motivo, ...(p.disqualify ? {} : { rejectedAt: new Date() }) }, p.io);
  await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: p.disqualify ? `🚫 Marcado como DESQUALIFICADO (não atende aos critérios dos bancos) — ${motivo}` : `❌ Marcado como REPROVADO (análise automática) — ${p.motivo}` } }).catch(() => {});
  await moveLeadToPerdidos({ accountId: p.accountId, leadId: lead.id, departmentId: lead.pipeline?.departmentId ?? null, byName: p.userId ? 'Usuário' : 'Análise automática', userId: p.userId || null, motivo, io: p.io });
  logActivity({ accountId: p.accountId, userId: p.userId || null, userName: p.userId ? undefined : 'Análise automática', action: 'lead_status_changed', leadId: lead.id, leadName: lead.name, summary: p.disqualify ? `marcou como "Desqualificado": ${motivo}` : `marcou como "Reprovado": ${p.motivo}` } as any);
  return { ok: true };
}

/** Manda os avisos que ficaram agendados (fora do horário), UM por rodada e na ordem em que foram agendados — a ordem Inter → Creditas → Santander
 *  é a de quem agendou. Só roda dentro das 07h–21h. */
let runningScheduled = false;
export async function processScheduledNotices(io: any): Promise<void> {
  if (!inNoticeWindow() || runningScheduled) return;
  runningScheduled = true;
  try {
    const ids = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "customFields"->>'_noticeAt' IS NOT NULL`;
    if (!ids.length) return;
    const leads = await prisma.lead.findMany({ where: { id: { in: ids.map((x) => x.id) } }, select: { id: true, accountId: true, name: true, status: true, customFields: true } });
    const due = leads
      .map((l) => ({ l, cf: (l.customFields || {}) as Record<string, any> }))
      .filter(({ cf }) => cf._noticeAt && new Date(cf._noticeAt).getTime() <= Date.now() && !cf._autoPaused)
      .sort((a, b) => Number(a.cf._noticeSeq || 0) - Number(b.cf._noticeSeq || 0));
    const first = due[0];
    if (!first) return;
    const { l, cf } = first;
    const limpa = { ...cf }; delete limpa._noticeAt; delete limpa._noticeSeq; delete limpa._noticeBy; delete limpa._noticeDocs; delete limpa._noticeMove; delete limpa._noticeKind; delete limpa._autoCloseAfterNotice;
    await prisma.lead.update({ where: { id: l.id }, data: { customFields: limpa } }); // limpa antes: se falhar, não repete em laço
    if (l.status !== 'OPEN') return;
    const r = cf._noticeKind === 'REJECTED'
      ? await sendRejectionNoticeNow({ accountId: l.accountId, leadId: l.id, userId: cf._noticeBy || undefined, io, ignoreWindow: true })
      : await sendApprovalNoticeNow({ accountId: l.accountId, leadId: l.id, userId: cf._noticeBy || undefined, io, sendDocs: cf._noticeDocs !== false, moveStage: cf._noticeMove !== false, ignoreWindow: true });
    console.log(`[Aprovação] aviso agendado de ${l.name}: ${r.ok ? 'enviado' : `não saiu (${r.error})`}`);
    if (r.ok && cf._noticeKind === 'REJECTED' && cf._autoCloseAfterNotice) {
      const built = await buildRejectionText(l.id).catch(() => null);
      await markRejectedAndMove({ accountId: l.accountId, leadId: l.id, io, disqualify: cf._autoCloseAfterNotice === 'DESQ', motivo: `Reprovado nos bancos${built?.reasons.length ? ' — ' + built.reasons.join('; ') : ''}`.slice(0, 280) }).catch((e: any) => console.error('[Aprovação] mover reprovado:', e?.message));
    }
    if (!r.ok) await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: r.already ? `ℹ️ Aviso agendado não reenviado: ${r.error}` : `⚠️ O aviso agendado ao cliente não saiu: ${r.error}` } }).catch(() => {});
  } catch (e: any) {
    console.error('[Aprovação] avisos agendados:', e?.message);
  } finally {
    runningScheduled = false;
  }
}
