import { PrismaClient, Direction, Channel } from '@prisma/client';
import { sendWhatsAppMessage } from './whatsapp.service';
import { sendBaileysMessage, getQRStatus } from './baileys.service';

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
  externalId?: string;
  status?: string;
}) {
  return prisma.message.create({ data: data as any });
}

/**
 * Envia uma mensagem WhatsApp de saída para o lead (via QR/Baileys se conectado,
 * senão via API oficial da Meta), grava o registro e emite os eventos de socket —
 * mesma lógica usada tanto pelo envio manual (Inbox) quanto pelo agente de IA.
 */
export async function sendOutboundWhatsApp(params: {
  accountId: string;
  leadId: string;
  content: string;
  /** Canal preferido: 'qr' (conexão via QR Code) ou 'api' (API oficial da Meta). Sem valor: QR se conectado, senão API. */
  via?: 'qr' | 'api';
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
}): Promise<{ success: true; message: Awaited<ReturnType<typeof createMessage>> } | { success: false; error: string }> {
  const { accountId, leadId, content, via, io } = params;

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: { contact: true },
  });
  if (!lead) return { success: false, error: 'Lead não encontrado' };

  const phone = lead.contact?.whatsappPhone || lead.contact?.phone;
  if (!phone) return { success: false, error: 'Contato sem número de telefone cadastrado' };

  let externalId: string | undefined;
  let status: 'SENT' | 'FAILED' = 'SENT';

  const qrStatus = getQRStatus(accountId);
  const useQR = via === 'qr' ? true : via === 'api' ? false : qrStatus.status === 'connected';

  if (useQR) {
    if (qrStatus.status !== 'connected') {
      return { success: false, error: 'WhatsApp via QR Code não está conectado. Conecte em Configurações → QR Code ou envie pela API oficial.' };
    }
    const sent = await sendBaileysMessage(phone, content, accountId);
    if (!sent) status = 'FAILED';
  } else {
    const result = await sendWhatsAppMessage(phone, content, accountId);
    if (result.success) {
      externalId = result.externalId;
    } else {
      return { success: false, error: result.error || 'Falha ao enviar mensagem WhatsApp' };
    }
  }

  const message = await createMessage({
    content,
    direction: 'OUTBOUND',
    channel: 'WHATSAPP',
    leadId,
    externalId,
    status,
  });

  if (io) {
    io.to(`lead:${leadId}`).emit('new_message', message);
    io.to(`account_${accountId}`).emit('new_notification', { leadId, message });
  }

  return { success: true, message };
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
