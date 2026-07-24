import { PrismaClient, Direction, Channel } from '@prisma/client';
import { sendWhatsAppMessage } from './whatsapp.service';
import { sendBaileysMessage, isNumberConnected, getConnectedNumberIds } from './baileys.service';

const prisma = new PrismaClient();

export async function getMessages(leadId: string) {
  return prisma.message.findMany({
    where: { leadId },
    orderBy: { createdAt: 'asc' },
    include: {
      attachments: {
        select: { id: true, fileName: true, mimeType: true, driveFileId: true },
      },
    },
  });
}

export async function createMessage(data: {
  content: string;
  direction: Direction;
  channel: Channel;
  leadId: string;
  whatsappNumberId?: string;
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
  let usedNumberId: string | null = null;

  const connectedNumbers = getConnectedNumberIds(accountId);
  const useQR = via === 'qr' ? true : via === 'api' ? false : connectedNumbers.length > 0;

  if (useQR) {
    // Roteamento: responde pelo mesmo número que recebeu (lead.whatsappNumberId);
    // se esse número não estiver conectado, usa o primeiro número conectado.
    const preferred = lead.whatsappNumberId && isNumberConnected(lead.whatsappNumberId)
      ? lead.whatsappNumberId
      : connectedNumbers[0];

    if (!preferred) {
      return { success: false, error: 'Nenhum WhatsApp conectado via QR Code. Conecte em Configurações → QR Code ou envie pela API oficial.' };
    }
    usedNumberId = preferred;
    // Retorna o id da mensagem enviada; guardamos como externalId para
    // deduplicar o eco fromMe que o Baileys emite em messages.upsert.
    const sentId = await sendBaileysMessage(phone, content, preferred);
    if (!sentId) status = 'FAILED';
    else externalId = sentId;

    // Se a conversa ainda não estava vinculada a um número, vincula agora
    if (!lead.whatsappNumberId) {
      await prisma.lead.update({ where: { id: leadId }, data: { whatsappNumberId: preferred } }).catch(() => {});
    }
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
    whatsappNumberId: usedNumberId ?? undefined,
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
      whatsappNumber: { select: { id: true, label: true, phone: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
      _count: {
        select: { messages: { where: { read: false, direction: 'INBOUND' } } },
      },
    },
  });
  // Ordena pela data da ÚLTIMA MENSAGEM (não pelo updatedAt do lead, que muda
  // quando se edita dados/estágio). Assim a conversa que recebeu/enviou msg mais
  // recente fica no topo.
  return leads.sort((a, b) => {
    const ta = a.messages[0]?.createdAt?.getTime() ?? a.updatedAt.getTime();
    const tb = b.messages[0]?.createdAt?.getTime() ?? b.updatedAt.getTime();
    return tb - ta;
  });
}

/** Busca um anexo (com bytes) garantindo que pertence à conta. */
export async function getAttachment(id: string, accountId: string) {
  const att = await prisma.messageAttachment.findUnique({ where: { id } });
  if (!att) return null;
  const lead = await prisma.lead.findFirst({ where: { id: att.leadId, accountId }, select: { id: true } });
  if (!lead) return null;
  return att;
}

/** Marca como lidas todas as mensagens recebidas (INBOUND) de um lead. */
export async function markConversationRead(leadId: string, accountId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true } });
  if (!lead) return { updated: 0 };
  const res = await prisma.message.updateMany({
    where: { leadId, direction: 'INBOUND', read: false },
    data: { read: true },
  });
  return { updated: res.count };
}
