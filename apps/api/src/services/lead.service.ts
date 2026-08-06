import { PrismaClient, LeadStatus } from '@prisma/client';

const prisma = new PrismaClient();

export async function getLeads(accountId: string, pipelineId?: string, stageId?: string, archived = false, isAdmin = true) {
  return prisma.lead.findMany({
    where: {
      accountId,
      // Grupos do WhatsApp não são cards de venda — ficam só na Inbox, não no Funil.
      isGroup: false,
      // Só admin enxerga arquivados e leads ganhos (WON); demais nunca.
      archived: isAdmin ? archived : false,
      ...(pipelineId && { pipelineId }),
      ...(stageId && { stageId }),
      ...(isAdmin ? {} : { status: { not: LeadStatus.WON } }),
    },
    include: {
      stage: true,
      user: { select: { id: true, name: true, email: true } },
      contact: true,
      company: true,
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      _count: { select: { messages: { where: { read: false, direction: 'INBOUND' } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getLeadById(id: string, accountId: string) {
  return prisma.lead.findFirst({
    where: { id, accountId },
    include: {
      stage: true,
      pipeline: { include: { stages: { orderBy: { order: 'asc' } } } },
      user: { select: { id: true, name: true, email: true } },
      contact: true,
      company: true,
      whatsappNumber: { select: { id: true, label: true, phone: true } },
      tasks: { include: { user: { select: { id: true, name: true } } }, orderBy: { dueAt: 'asc' } },
      notes: { orderBy: { createdAt: 'desc' }, include: { user: { select: { id: true, name: true } } } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
}

export async function createLead(data: {
  name: string;
  value?: number;
  pipelineId: string;
  stageId: string;
  userId: string;
  contactId?: string;
  companyId?: string;
  tags?: string[];
  accountId: string;
  customFields?: Record<string, unknown>;
}) {
  const { customFields, ...rest } = data;
  return prisma.lead.create({
    data: { ...rest, ...(customFields ? { customFields: customFields as any } : {}) },
    include: { stage: true, user: { select: { id: true, name: true } } },
  });
}

export async function updateLead(id: string, accountId: string, data: Partial<{
  name: string;
  value: number;
  status: LeadStatus;
  userId: string;
  contactId: string;
  companyId: string;
  tags: string[];
  customFields: Record<string, unknown>;
  isGroup: boolean;
}>) {
  return prisma.lead.update({ where: { id }, data: data as any });
}

export async function updateLeadStage(id: string, accountId: string, stageId: string) {
  return prisma.lead.update({
    where: { id },
    data: { stageId },
    include: { stage: true },
  });
}

/**
 * Correção do incidente 2026-08 (conversas separadas por número): junta de
 * volta os cards que se duplicaram só porque o mesmo contato falou por dois
 * números diferentes. Une TODOS os leads (não-grupo) de um mesmo contactId
 * num único card — mantém o que tem mais mensagens, move mensagens/tarefas/
 * notas dos demais para ele, mescla campos e valor, e apaga os duplicados.
 */
export async function mergeLeadsBySameContact(accountId: string): Promise<{ merged: number; groups: number }> {
  const leads = await prisma.lead.findMany({
    where: { accountId, isGroup: false, contactId: { not: null } },
    include: { _count: { select: { messages: true } } },
  });

  const byContact = new Map<string, typeof leads>();
  for (const l of leads) {
    if (!l.contactId) continue;
    if (!byContact.has(l.contactId)) byContact.set(l.contactId, [] as any);
    byContact.get(l.contactId)!.push(l);
  }

  let merged = 0;
  let groups = 0;
  for (const [, group] of byContact) {
    if (group.length < 2) continue;
    groups++;

    // Mantém o card com mais mensagens (desempate: mais recente).
    const sorted = [...group].sort((a, b) =>
      (b._count.messages - a._count.messages) || (b.updatedAt.getTime() - a.updatedAt.getTime()));
    const keep = sorted[0];
    const rest = sorted.slice(1);

    for (const source of rest) {
      const mergedCF = { ...((source.customFields as any) || {}), ...((keep.customFields as any) || {}) };
      const mergedValue = Math.max(keep.value || 0, source.value || 0) || undefined;
      try {
        await prisma.$transaction([
          prisma.message.updateMany({ where: { leadId: source.id }, data: { leadId: keep.id } }),
          prisma.task.updateMany({ where: { leadId: source.id }, data: { leadId: keep.id } }),
          prisma.note.updateMany({ where: { leadId: source.id }, data: { leadId: keep.id } }),
          prisma.lead.update({ where: { id: keep.id }, data: { customFields: mergedCF as any, value: mergedValue } }),
          prisma.note.create({
            data: {
              leadId: keep.id,
              content: `Card unificado automaticamente com "${source.name}" (conversa que havia se separado por número de WhatsApp).`,
              type: 'DATA_EDIT',
            },
          }),
          prisma.lead.delete({ where: { id: source.id } }),
        ]);
        merged++;
      } catch (err) {
        console.error('[Merge automático] Falhou para', source.id, err);
      }
    }
  }

  return { merged, groups };
}

export async function deleteLead(id: string, accountId: string) {
  return prisma.lead.delete({ where: { id } });
}
