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

/** Só dígitos, e garante DDI 55 (Brasil) para números locais */
function normalizeBRPhone(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.length <= 11 && !digits.startsWith('55')) digits = '55' + digits;
  return digits;
}

/** Formata para exibição no card: (61) 99999-9999 */
function formatPhoneDisplay(digits: string): string {
  const d = digits.startsWith('55') ? digits.slice(2) : digits;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `+${digits}`;
}

/**
 * Encontra (ou cria) um lead a partir de um número de telefone.
 * Preenche os campos do card (participante_1 + telefone_1) para que o
 * telefone apareça no detalhe do lead. Retorna o leadId ou null se não
 * houver funil/usuário configurado.
 */
export async function findOrCreateLeadByPhone(
  accountId: string,
  rawPhone: string,
  name?: string
): Promise<{ leadId: string; created: boolean } | null> {
  const phone = normalizeBRPhone(rawPhone);
  const last8 = phone.slice(-8);

  let contact = await prisma.contact.findFirst({
    where: { accountId, OR: [{ whatsappPhone: phone }, { phone: { contains: last8 } }] },
    include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
  });

  const displayName = name?.trim() || formatPhoneDisplay(phone);

  if (!contact) {
    contact = await prisma.contact.create({
      data: { name: displayName, whatsappPhone: phone, phone: `+${phone}`, accountId },
      include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
    });
  } else if (!contact.whatsappPhone) {
    await prisma.contact.update({ where: { id: contact.id }, data: { whatsappPhone: phone } });
  }

  const existing = (contact as any).leads?.[0];
  if (existing) return { leadId: existing.id, created: false };

  const pipeline = await prisma.pipeline.findFirst({
    where: { accountId },
    include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
  });
  const admin = await prisma.user.findFirst({ where: { accountId } });
  if (!pipeline?.stages.length || !admin) return null;

  const lead = await prisma.lead.create({
    data: {
      name: contact.name,
      accountId,
      pipelineId: pipeline.id,
      stageId: pipeline.stages[0].id,
      userId: admin.id,
      contactId: contact.id,
      status: 'OPEN',
      customFields: {
        participante_1: contact.name,
        telefone_1: formatPhoneDisplay(phone),
      } as any,
    },
  });
  return { leadId: lead.id, created: true };
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
