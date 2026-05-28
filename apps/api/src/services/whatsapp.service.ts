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

// Finds or creates the "Caixa de Entrada" pipeline for incoming WhatsApp leads
async function getOrCreateWhatsAppPipeline(accountId: string) {
  // Try to find existing pipeline named "Caixa de Entrada" (or legacy names)
  let pipeline = await prisma.pipeline.findFirst({
    where: {
      accountId,
      OR: [
        { name: { contains: 'Caixa de Entrada', mode: 'insensitive' } },
        { name: { contains: 'WhatsApp',          mode: 'insensitive' } },
        { name: { contains: 'Mensagens',          mode: 'insensitive' } },
        { name: { contains: 'Inbox',              mode: 'insensitive' } },
      ],
    },
    include: { stages: { orderBy: { order: 'asc' } } },
  });

  // Create it if not found
  if (!pipeline) {
    pipeline = await prisma.pipeline.create({
      data: {
        name: 'Caixa de Entrada',
        accountId,
        stages: {
          create: [
            {
              name: 'Leads de Entrada',
              order: 0,
              color: '#25D366',
              // description field if schema supports it, otherwise ignored
            },
          ],
        },
      },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    console.log(`[WhatsApp] Pipeline "Caixa de Entrada" criado para accountId=${accountId}`);
  }

  return pipeline;
}

// Format phone for display: "5561999990000" → "(61) 99999-0000"
function formatPhoneDisplay(raw: string): string {
  const d = raw.replace(/\D/g, '');
  // Remove country code 55 if present
  const local = d.startsWith('55') && d.length >= 12 ? d.slice(2) : d;
  if (local.length === 11) return `(${local.slice(0,2)}) ${local.slice(2,7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0,2)}) ${local.slice(2,6)}-${local.slice(6)}`;
  return `+${raw}`;
}

export async function processIncomingWhatsApp(body: any, accountId: string, io: any) {
  try {
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.length) return;

    for (const msg of value.messages) {
      if (msg.type !== 'text') continue;

      const from = msg.from as string; // e.g. "5561999990001"
      const text = msg.text?.body as string;
      const externalId = msg.id as string;
      const profileName = value.contacts?.[0]?.profile?.name || `+${from}`;
      const formattedPhone = formatPhoneDisplay(from);

      console.log(`[WhatsApp] Incoming from=${from} name="${profileName}"`);

      // ── Find or create contact ──────────────────────────────────────────
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

      if (!contact) {
        contact = await prisma.contact.create({
          data: {
            name: profileName,
            whatsappPhone: from,
            phone: formattedPhone,
            accountId,
          },
          include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
        });
        console.log(`[WhatsApp] Contato criado: ${contact.id} — ${profileName}`);
      } else if (!contact.whatsappPhone) {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { whatsappPhone: from, phone: contact.phone || formattedPhone },
        });
      }

      // ── Find or create lead ─────────────────────────────────────────────
      let leadId: string;

      if (contact.leads.length > 0) {
        // Existing lead — update customFields if telefone_1 is missing
        const existingLead = contact.leads[0];
        const cf = (existingLead as any).customFields as Record<string, string> | null;
        if (!cf?.telefone_1) {
          await prisma.lead.update({
            where: { id: existingLead.id },
            data: {
              customFields: {
                ...((cf as any) || {}),
                participante_1: cf?.participante_1 || profileName,
                telefone_1: formattedPhone,
              } as any,
            },
          });
        }
        leadId = existingLead.id;
      } else {
        // Get dedicated WhatsApp pipeline
        const pipeline = await getOrCreateWhatsAppPipeline(accountId);
        const admin = await prisma.user.findFirst({
          where: { accountId },
          orderBy: { createdAt: 'asc' },
        });

        if (!pipeline.stages.length || !admin) {
          console.error('[WhatsApp] Pipeline sem estágios ou sem usuário admin');
          return;
        }

        const lead = await prisma.lead.create({
          data: {
            name: profileName,
            accountId,
            pipelineId: pipeline.id,
            stageId: pipeline.stages[0].id,
            userId: admin.id,
            contactId: contact.id,
            status: 'OPEN',
            tags: ['WhatsApp'],
            // Auto-fill participant fields
            customFields: {
              participante_1: profileName,
              telefone_1: formattedPhone,
            } as any,
          },
        });
        leadId = lead.id;
        console.log(`[WhatsApp] Lead criado: ${lead.id} — ${profileName} (${formattedPhone})`);
      }

      // ── Avoid duplicate messages ────────────────────────────────────────
      const existing = await prisma.message.findFirst({ where: { externalId } });
      if (existing) continue;

      // ── Save message ────────────────────────────────────────────────────
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

      // ── Emit via Socket.io ──────────────────────────────────────────────
      if (io) {
        io.to(`lead:${leadId}`).emit('new_message', message);
        io.to(`account_${accountId}`).emit('new_conversation', { leadId });
      }
    }
  } catch (err) {
    console.error('[WhatsApp] Process incoming error:', err);
  }
}
