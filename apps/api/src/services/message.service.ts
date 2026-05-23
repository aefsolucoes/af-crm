import { PrismaClient, Direction, Channel } from '@prisma/client';

const prisma = new PrismaClient();

export async function getMessages(leadId: string) {
  return prisma.message.findMany({
    where: { leadId },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createMessage(data: {
  content: string;
  direction: Direction;
  channel: Channel;
  leadId: string;
}) {
  return prisma.message.create({ data });
}

export async function markMessagesRead(leadId: string) {
  return prisma.message.updateMany({
    where: { leadId, read: false, direction: Direction.INBOUND },
    data: { read: true },
  });
}

export async function getConversations(accountId: string) {
  const leads = await prisma.lead.findMany({
    where: { accountId, messages: { some: {} } },
    include: {
      contact: true,
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      _count: {
        select: { messages: { where: { read: false, direction: 'INBOUND' } } },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return leads;
}
