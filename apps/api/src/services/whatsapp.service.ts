import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function getWhatsAppConfig(accountId: string) {
  return prisma.whatsAppConfig.findUnique({ where: { accountId } });
}

export async function saveWhatsAppConfig(accountId: string, data: {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  active: boolean;
}) {
  return prisma.whatsAppConfig.upsert({
    where: { accountId },
    create: { accountId, ...data },
    update: data,
  });
}

export async function sendWhatsAppMessage(
  to: string,
  message: string,
  accountId: string
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  const config = await getWhatsAppConfig(accountId);
  console.log(`[WA Send] accountId=${accountId} config exists=${!!config} active=${config?.active} phoneNumberId=${config?.phoneNumberId}`);

  if (!config) {
    return { success: false, error: 'WhatsApp não configurado. Acesse Configurações → API Oficial e salve suas credenciais.' };
  }
  if (!config.active) {
    return { success: false, error: 'WhatsApp inativo. Acesse Configurações → API Oficial e ative a integração.' };
  }

  const phone = to.replace(/\D/g, '');
  const url = `https://graph.facebook.com/v19.0/${config.phoneNumberId}/messages`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: message },
      }),
    });

    const json = await res.json() as {
      messages?: { id: string }[];
      error?: { message: string; code: number };
    };

    if (!res.ok || json.error) {
      console.error('[WhatsApp] Send error:', json.error);
      return { success: false, error: json.error?.message || 'Erro desconhecido' };
    }

    return { success: true, externalId: json.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] Fetch error:', err);
    return { success: false, error: 'Falha na conexão com a API do WhatsApp' };
  }
}

export async function processIncomingWhatsApp(body: any, accountId: string, io: any) {
  try {
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.length) return;

    for (const msg of value.messages) {
      if (msg.type !== 'text') continue;

      const from = msg.from as string; // e.g. "5511999990001"
      const text = msg.text?.body as string;
      const externalId = msg.id as string;

      // Find contact by whatsappPhone or phone
      let contact = await prisma.contact.findFirst({
        where: {
          accountId,
          OR: [
            { whatsappPhone: from },
            { phone: { contains: from.slice(-8) } },
          ],
        },
        include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
      });

      // Auto-create contact if not found
      if (!contact) {
        const profileName = value.contacts?.[0]?.profile?.name || `+${from}`;
        contact = await prisma.contact.create({
          data: {
            name: profileName,
            whatsappPhone: from,
            phone: `+${from}`,
            accountId,
          },
          include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
        });
      }

      // Update whatsappPhone if missing
      if (!contact.whatsappPhone) {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { whatsappPhone: from },
        });
      }

      // Find or create lead for this contact
      let leadId: string;
      if (contact.leads.length > 0) {
        leadId = contact.leads[0].id;
      } else {
        // Need pipeline and stage
        const pipeline = await prisma.pipeline.findFirst({
          where: { accountId },
          include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
        });
        const admin = await prisma.user.findFirst({ where: { accountId } });

        if (!pipeline || !pipeline.stages.length || !admin) return;

        const lead = await prisma.lead.create({
          data: {
            name: contact.name,
            accountId,
            pipelineId: pipeline.id,
            stageId: pipeline.stages[0].id,
            userId: admin.id,
            contactId: contact.id,
            status: 'OPEN',
          },
        });
        leadId = lead.id;
      }

      // Avoid duplicate messages
      const existing = await prisma.message.findFirst({ where: { externalId } });
      if (existing) continue;

      // Save message
      const message = await prisma.message.create({
        data: {
          content: text,
          direction: 'INBOUND',
          channel: 'WHATSAPP',
          leadId,
          read: false,
          externalId,
          status: 'DELIVERED',
        },
      });

      // Emit via Socket.io
      if (io) {
        io.to(`lead:${leadId}`).emit('new_message', message);
        io.emit('new_conversation', { leadId });
      }
    }
  } catch (err) {
    console.error('[WhatsApp] Process incoming error:', err);
  }
}
