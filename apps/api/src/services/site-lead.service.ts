import { PrismaClient } from '@prisma/client';
import { normalizeBrazilianWhatsAppPhone } from './whatsapp.service';
import { normalizeClientName } from '../lib/text';
import { logActivity } from './activity.service';
import { parseMoneyOrNumber } from './campaign-detection.service';

const prisma = new PrismaClient();

/**
 * Lead capturado por um formulário do SITE (fora do CRM) — campanha do Meta
 * Ads leva o cliente pro site, ele preenche nome/telefone/e-mail/valores
 * antes de simular, e o site chama POST /api/webhooks/site-lead (autenticado
 * por Account.leadIntakeApiKey) com esses dados. Aqui o lead já nasce no
 * funil/etapa certos, e dispara a automação FORM_SUBMITTED (ex.: mandar um
 * template de boas-vindas).
 */

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function norm(s: string): string {
  return stripAccents(s).toLowerCase().trim();
}

/** Núcleo do telefone (últimos 8 dígitos) — mesmo critério de routes/import.ts. */
function phoneCore(digits: string): string | null {
  const core = digits.length > 8 ? digits.slice(-8) : digits;
  return core.length >= 8 ? core : null;
}

export interface SiteLeadInput {
  name: string;
  phone: string;
  email?: string;
  /** Nome EXATO do Department de destino (ex.: "Home Equity"). */
  department: string;
  /** Campos extras do formulário — mesmas chaves que o resto do CRM já lê
   *  (ex.: valor_imovel, valor_credito) quando possível, pra aparecer nos
   *  lugares certos da tela em vez de ficar órfão. */
  customFields?: Record<string, unknown>;
}

export type SiteLeadResult =
  | { ok: true; leadId: string; created: boolean }
  | { ok: false; status: number; error: string };

export async function createLeadFromSiteForm(
  accountId: string,
  input: SiteLeadInput,
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } }
): Promise<SiteLeadResult> {
  const name = input.name?.trim();
  const rawPhone = input.phone?.trim();
  const departmentName = input.department?.trim();
  if (!name) return { ok: false, status: 400, error: 'name é obrigatório' };
  if (!rawPhone) return { ok: false, status: 400, error: 'phone é obrigatório' };
  if (!departmentName) return { ok: false, status: 400, error: 'department é obrigatório' };

  const e164 = normalizeBrazilianWhatsAppPhone(rawPhone);
  const formattedPhone = `+${e164}`;
  const core = phoneCore(e164);

  // Resolve setor → funil → etapa de Prospecção — mesma regra usada pelo
  // roteamento de campanha vindo do WhatsApp (campaign-detection.service.ts):
  // não fixa o NOME do funil, só exige alguma etapa com "prospec" no nome.
  const dept = await prisma.department.findFirst({
    where: { accountId, name: { equals: departmentName, mode: 'insensitive' } },
    select: { id: true },
  });
  if (!dept) return { ok: false, status: 422, error: `Setor "${departmentName}" não existe nesta conta.` };

  const pipelines = await prisma.pipeline.findMany({
    where: { accountId, departmentId: dept.id },
    include: { stages: { orderBy: { order: 'asc' } } },
  });
  let target: { pipelineId: string; stageId: string } | null = null;
  for (const p of pipelines) {
    const stage = p.stages.find((st) => norm(st.name).includes('prospec'));
    if (stage) { target = { pipelineId: p.id, stageId: stage.id }; break; }
  }
  if (!target) return { ok: false, status: 422, error: `Nenhum funil do setor "${departmentName}" tem etapa de Prospecção.` };

  const admin =
    (await prisma.user.findFirst({ where: { accountId, departmentIds: { has: dept.id } }, orderBy: { createdAt: 'asc' } })) ||
    (await prisma.user.findFirst({ where: { accountId }, orderBy: { createdAt: 'asc' } }));
  if (!admin) return { ok: false, status: 500, error: 'Nenhum usuário encontrado nesta conta.' };

  // Acha ou cria o Contact por telefone (últimos 8 dígitos — mesmo critério
  // de dedupe já usado na importação e no "find lead" da IA).
  let contact = core
    ? await prisma.contact.findFirst({ where: { accountId, OR: [{ whatsappPhone: e164 }, { phone: { contains: core } }] } })
    : null;

  const displayName = normalizeClientName(name);
  const email = input.email?.trim() || undefined;

  if (!contact) {
    contact = await prisma.contact.create({
      data: { accountId, name: displayName, phone: formattedPhone, whatsappPhone: e164, email },
    });
  } else {
    const patch: Record<string, unknown> = {};
    if (!contact.whatsappPhone) patch.whatsappPhone = e164;
    if (!contact.phone) patch.phone = formattedPhone;
    if (!contact.email && email) patch.email = email;
    if (Object.keys(patch).length) await prisma.contact.update({ where: { id: contact.id }, data: patch });
  }

  // Campos NUMBER do card (prisma/seed.ts, tab "Financiamento") — aceita o
  // valor formatado como o formulário do site já produz naturalmente ("R$
  // 100.000,00", "R$ 100 mil", "50000") e normaliza pra número puro, mesma
  // regra já usada no roteamento de campanha por WhatsApp. Poupa quem
  // implementa o lado do site de ter que converter isso antes de mandar.
  const NUMBER_FIELD_KEYS = new Set([
    'valor_avaliacao', 'valor_imovel', 'valor_credito', 'valor_entrada',
    'primeira_parcela', 'ultima_parcela', 'renda_1', 'renda_2',
    'credito_consorcio', 'parcela_consorcio', 'prazo_consorcio',
  ]);

  const extraFields: Record<string, string> = {};
  if (input.customFields) {
    for (const [k, v] of Object.entries(input.customFields)) {
      if (v === undefined || v === null || v === '') continue;
      const raw = String(v);
      const parsed = NUMBER_FIELD_KEYS.has(k) ? parseMoneyOrNumber(raw) : raw;
      if (parsed !== null && parsed !== '') extraFields[k] = parsed;
    }
  }
  const customFields = {
    participante_1: displayName,
    telefone_1: formattedPhone,
    ...(email ? { email_1: email } : {}),
    ...extraFields,
  };

  // Contato já tem lead? Não duplica o card — só atualiza os campos (mesmo
  // espírito do fluxo de WhatsApp: só nasce lead NOVO na 1ª vez).
  const existingLead = await prisma.lead.findFirst({ where: { accountId, contactId: contact.id }, orderBy: { updatedAt: 'desc' } });
  if (existingLead) {
    await prisma.lead.update({
      where: { id: existingLead.id },
      data: { customFields: { ...((existingLead.customFields as any) || {}), ...customFields } },
    });
    return { ok: true, leadId: existingLead.id, created: false };
  }

  const lead = await prisma.lead.create({
    data: {
      name: displayName,
      accountId,
      pipelineId: target.pipelineId,
      stageId: target.stageId,
      userId: admin.id,
      contactId: contact.id,
      status: 'OPEN',
      tags: ['Site', 'Campanha'],
      customFields: customFields as any,
    },
  });

  logActivity({
    accountId, userId: null, userName: 'Site', action: 'lead_created',
    leadId: lead.id, leadName: lead.name, summary: 'chegou pelo formulário do site',
  });

  // Lazy require (não estático) — mesmo motivo documentado em
  // whatsapp.service.ts: evita dependência circular com automation.service.ts.
  const { runAutomations } = require('./automation.service') as typeof import('./automation.service');
  runAutomations({ accountId, trigger: 'FORM_SUBMITTED', leadId: lead.id, io }).catch(() => {});

  if (io) io.to(`account_${accountId}`).emit('new_notification', { leadId: lead.id });

  return { ok: true, leadId: lead.id, created: true };
}
