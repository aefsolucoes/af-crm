import { PrismaClient, EmailMessage } from '@prisma/client';
import { normalizeBrazilianWhatsAppPhone } from './whatsapp.service';
import { normalizeClientName } from '../lib/text';
import { logActivity } from './activity.service';
import { parseMoneyOrNumber } from './campaign-detection.service';

/**
 * Proposta preenchida no SITE chega por e-mail no comercial@ (FormSubmit:
 * "🏠 Proposta Manual — ..." / "🏠 Nova Proposta — ..."). Pedido do Fabio
 * (2026-09-26): mesmo que o cliente não termine mandando pelo WhatsApp, os
 * valores têm que aparecer no CRM. Aqui a proposta:
 *  - acha o card do cliente (celular → CPF → e-mail) ou cria um em Pré-Análise;
 *  - entra na conversa do card com TODOS os campos;
 *  - preenche o card (proposta nova: com os valores dela; e-mail antigo,
 *    reprocessado: só campos vazios, pra não desfazer o que a equipe corrigiu);
 *  - proposta nova leva o card pra Pré-Análise (mesmas automações da etapa).
 */

const prisma = new PrismaClient();
type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/** Remetentes de formulário do site — nunca são "o cliente" (não entram na
 *  regra de lembrar remetente da caixa de e-mail). */
export const SITE_FORM_SENDERS = new Set(['submissions@formsubmit.co', 'notify@web3forms.com']);

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Rótulo do e-mail (normalizado) → campo do card. */
const FIELD_MAP: { labels: string[]; key: string; kind: 'text' | 'number' | 'date' }[] = [
  { labels: ['nome completo', 'nome'], key: 'participante_1', kind: 'text' },
  { labels: ['cpf'], key: 'cpf_1', kind: 'text' },
  { labels: ['data nascimento', 'nascimento', 'data de nascimento'], key: 'nascimento_1', kind: 'date' },
  { labels: ['e-mail', 'email'], key: 'email_1', kind: 'text' },
  { labels: ['celular', 'whatsapp', 'telefone'], key: 'telefone_1', kind: 'text' },
  { labels: ['renda bruta'], key: 'renda_1', kind: 'number' },
  { labels: ['perfil de renda'], key: 'vinculo_1', kind: 'text' },
  { labels: ['valor do imovel (garantia)', 'valor do imovel', 'valor de compra e venda'], key: 'valor_imovel', kind: 'number' },
  { labels: ['credito desejado', 'valor financiado'], key: 'valor_credito', kind: 'number' },
  { labels: ['valor de entrada', 'entrada / fgts', 'entrada'], key: 'valor_entrada', kind: 'number' },
  { labels: ['prazo'], key: 'prazo_financ', kind: 'text' },
  { labels: ['1ª parcela estimada', '1a parcela estimada'], key: 'primeira_parcela', kind: 'number' },
];

export function parseFormPairs(html: string): [string, string][] {
  const clean = (x: string) => x.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return [...html.matchAll(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi)]
    .map((m) => [clean(m[1]), clean(m[2])] as [string, string])
    .filter(([k, v]) => k && v && norm(k) !== 'name');
}

function productOf(pairs: [string, string][], subject: string): { department: string; label: string } | null {
  const produto = norm(pairs.find(([k]) => norm(k) === 'produto')?.[1] || subject);
  if (/garantia|home equity/.test(produto)) return { department: 'Home Equity', label: 'Crédito com Garantia de Imóvel' };
  if (/financiamento/.test(produto)) return { department: 'Financiamento Habitacional', label: 'Financiamento Habitacional' };
  return null;
}

function cardFields(pairs: [string, string][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [label, value] of pairs) {
    const l = norm(label);
    const f = FIELD_MAP.find((m) => m.labels.includes(l));
    if (!f || out[f.key]) continue;
    if (f.key === 'prazo_financ' && !/\d/.test(value)) continue; // "Prazo: anos" (em branco no site)
    const parsed = f.kind === 'number' ? parseMoneyOrNumber(value) : value;
    if (parsed !== null && parsed !== '') out[f.key] = String(parsed);
  }
  return out;
}

export async function findLead(accountId: string, phone: string, cpf: string, email: string) {
  const core = phone.replace(/\D/g, '').slice(-8);
  if (core.length === 8) {
    const byPhone = await prisma.lead.findMany({
      where: { accountId, isGroup: false, contact: { OR: [{ whatsappPhone: { endsWith: core } }, { phone: { contains: core.slice(-4) } }] } },
      orderBy: [{ archived: 'asc' }, { updatedAt: 'desc' }],
      select: { id: true, contact: { select: { whatsappPhone: true, phone: true } } },
      take: 20,
    });
    const hit = byPhone.find((l) => (l.contact?.whatsappPhone || '').endsWith(core) || (l.contact?.phone || '').replace(/\D/g, '').endsWith(core));
    if (hit) return hit.id;
  }
  const cpfDigits = cpf.replace(/\D/g, '');
  if (cpfDigits.length === 11) {
    const cands = await prisma.lead.findMany({
      where: { accountId, isGroup: false, customFields: { path: ['cpf_1'], string_contains: cpfDigits.slice(0, 3) } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, customFields: true },
    });
    const hit = cands.find((c) => String((c.customFields as any)?.cpf_1 || '').replace(/\D/g, '') === cpfDigits);
    if (hit) return hit.id;
  }
  if (email) {
    const hit = await prisma.lead.findFirst({
      where: { accountId, isGroup: false, contact: { email: { equals: email, mode: 'insensitive' } } },
      orderBy: { updatedAt: 'desc' }, select: { id: true },
    });
    if (hit) return hit.id;
  }
  return null;
}

/** Card novo direto na Pré-Análise do setor (a proposta já está completa). */
async function createLeadInPreAnalysis(accountId: string, department: string, name: string, phone: string, email: string) {
  const dept = await prisma.department.findFirst({ where: { accountId, name: { equals: department, mode: 'insensitive' } }, select: { id: true } });
  if (!dept) return null;
  const pipelines = await prisma.pipeline.findMany({ where: { accountId, departmentId: dept.id }, include: { stages: { orderBy: { order: 'asc' } } } });
  const pipe = pipelines.find((p) => p.name === 'Vendas') || pipelines[0];
  const stage = pipe?.stages.find((st) => norm(st.name).includes('pre-analise') && !/aprovad/.test(norm(st.name)));
  if (!pipe || !stage) return null;
  const owner = (await prisma.user.findFirst({ where: { accountId, departmentIds: { has: dept.id } }, orderBy: { createdAt: 'asc' } }))
    || (await prisma.user.findFirst({ where: { accountId }, orderBy: { createdAt: 'asc' } }));
  if (!owner) return null;

  const e164 = phone ? normalizeBrazilianWhatsAppPhone(phone) : null;
  const displayName = normalizeClientName(name || email || 'Cliente do site');
  let contact = e164 ? await prisma.contact.findFirst({ where: { accountId, whatsappPhone: e164 } }) : null;
  if (!contact) {
    contact = await prisma.contact.create({ data: { accountId, name: displayName, phone: phone || null, whatsappPhone: e164, email: email || null } });
  }
  const lead = await prisma.lead.create({
    data: { name: displayName, accountId, pipelineId: pipe.id, stageId: stage.id, userId: owner.id, contactId: contact.id, status: 'OPEN', tags: ['Site', 'Proposta'] },
  });
  return { leadId: lead.id, stageId: stage.id };
}

/**
 * Processa um e-mail de proposta do site. `fresh` = acabou de chegar (não é
 * reprocessamento de e-mail antigo): aí move pra Pré-Análise, dispara as
 * automações e avisa a equipe. Devolve o card, ou null se não for proposta.
 */
export async function handleSiteProposalEmail(accountId: string, email: EmailMessage, io: Io, fresh: boolean): Promise<string | null> {
  if (!email.fromAddress || !SITE_FORM_SENDERS.has(email.fromAddress.toLowerCase())) return null;
  if (!/^🏠|proposta/i.test(email.subject || '')) return null; // "🔔 Lead (sem proposta)" o webhook do site já trata
  const pairs = parseFormPairs(email.htmlBody || '');
  const product = productOf(pairs, email.subject || '');
  if (!pairs.length || !product) return null;

  const get = (...labels: string[]) => pairs.find(([k]) => labels.includes(norm(k)))?.[1] || '';
  const name = get('nome completo', 'nome');
  const phone = get('celular', 'whatsapp', 'telefone');
  const cpf = get('cpf');
  const clientEmail = get('e-mail', 'email').toLowerCase();

  let leadId = await findLead(accountId, phone, cpf, clientEmail);
  let created: { leadId: string; stageId: string } | null = null;
  if (!leadId) {
    created = await createLeadInPreAnalysis(accountId, product.department, name, phone, clientEmail);
    leadId = created?.leadId || null;
  }
  if (!leadId) return null;

  // Preenche o card.
  const fields = cardFields(pairs);
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true, contactId: true, contact: { select: { email: true } } } });
  const current = ((lead?.customFields as Record<string, unknown>) || {});
  const merged = fresh || created
    ? { ...current, ...fields }
    : { ...fields, ...Object.fromEntries(Object.entries(current).filter(([, v]) => v !== null && v !== undefined && v !== '')) };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: merged as any } });
  if (lead?.contactId && clientEmail && !lead.contact?.email) {
    await prisma.contact.update({ where: { id: lead.contactId }, data: { email: clientEmail } }).catch(() => {});
  }

  // Proposta inteira na conversa do card.
  await prisma.emailMessage.update({ where: { id: email.id }, data: { leadId } });
  const already = email.messageId
    ? await prisma.message.findFirst({ where: { leadId, channel: 'EMAIL', externalId: email.messageId }, select: { id: true } })
    : null;
  if (!already) {
    const body = pairs.filter(([k]) => norm(k) !== 'produto').map(([k, v]) => `${k}: ${v}`).join('\n');
    const message = await prisma.message.create({
      data: {
        content: `📋 Proposta preenchida no site — ${product.label}\n\n${body}`,
        direction: 'INBOUND', channel: 'EMAIL', leadId, externalId: email.messageId || undefined, status: 'SENT',
        read: !fresh, createdAt: email.date,
      },
      include: { sentBy: { select: { id: true, name: true } } },
    });
    if (fresh && io) {
      io.to(`lead:${leadId}`).emit('new_message', message);
      io.to(`account_${accountId}`).emit('new_notification', { leadId, message });
    }
  }

  logActivity({
    accountId, userId: null, userName: 'Formulário do site', action: created ? 'lead_created' : 'lead_edited', leadId, leadName: lead?.name,
    summary: created ? `proposta do site (${product.label}) chegou por e-mail — card criado em Pré-Análise` : `proposta do site (${product.label}) chegou por e-mail e preencheu o card`,
  });

  if (fresh) {
    const { runAutomations } = require('./automation.service') as typeof import('./automation.service');
    let movedStageId = created?.stageId || null;
    if (!created) {
      // Mesma regra do formulário pelo WhatsApp: só avança quem está antes da
      // Pré-Análise, no mesmo setor.
      const { advanceLeadOnProposalForm } = require('./campaign-detection.service') as typeof import('./campaign-detection.service');
      const marker = product.department === 'Home Equity' ? 'Proposta de Crédito com Garantia de Imóvel' : 'Proposta de Financiamento Habitacional';
      const moved = await advanceLeadOnProposalForm(accountId, leadId, `${marker}\nCPF: ${cpf || '-'}`).catch(() => null);
      movedStageId = moved?.stageId || null;
    }
    if (movedStageId) runAutomations({ accountId, trigger: 'STAGE_CHANGE', leadId, io: io as any, context: { newStageId: movedStageId } }).catch(() => {});
    if (io && created) io.to(`account_${accountId}`).emit('site_lead_created', { leadId, leadName: lead?.name, department: product.department });
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `📋 Proposta do site — ${lead?.name || 'cliente'}`, body: product.label, leadId }).catch(() => {});
  }
  console.log(`[Proposta e-mail] ${email.subject} → card ${leadId}${created ? ' (criado)' : ''}${fresh ? ' (nova)' : ''}`);
  return leadId;
}
