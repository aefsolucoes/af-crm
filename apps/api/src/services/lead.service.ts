import { PrismaClient, LeadStatus } from '@prisma/client';

const prisma = new PrismaClient();

export async function getLeads(accountId: string, pipelineId?: string, stageId?: string) {
  return prisma.lead.findMany({
    where: {
      accountId,
      ...(pipelineId && { pipelineId }),
      ...(stageId && { stageId }),
    },
    include: {
      stage: true,
      user: { select: { id: true, name: true, email: true } },
      contact: true,
      company: true,
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
      tasks: { include: { user: { select: { id: true, name: true } } }, orderBy: { dueAt: 'asc' } },
      notes: { orderBy: { createdAt: 'desc' } },
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
}) {
  return prisma.lead.create({ data, include: { stage: true, user: { select: { id: true, name: true } } } });
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

export async function deleteLead(id: string, accountId: string) {
  return prisma.lead.delete({ where: { id } });
}
