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

// ─── Templates do WhatsApp (Meta) ────────────────────────────────────────────
// Templates precisam ser aprovados pela Meta antes de poder enviar mensagem
// fora da janela de 24h de atendimento. Usam o WABA ID salvo em WhatsAppConfig.
// Compartilhado entre a tela de Configurações (settings.ts) e o assistente de
// IA (ai.ts) — a lógica de chamar a Graph API mora só aqui.

/** Nome técnico do template exigido pela Meta: minúsculo, só letras/números/_. */
export function slugifyTemplateName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 512);
  return slug || 'template';
}

export type TemplateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';

/** Lista os templates da conta na Meta, com status de aprovação. Lança erro
 *  (Error) com mensagem pronta para mostrar ao usuário/colaborador em caso de
 *  falha (WABA/token não configurado, erro da Graph API etc). */
export async function listMetaTemplates(accountId: string): Promise<any[]> {
  const config = await getWhatsAppConfig(accountId);
  if (!config?.accessToken) throw new Error('Configure o Access Token primeiro (aba API Oficial).');
  if (!config.wabaId) throw new Error('Informe o WABA ID em "Ativar recebimento" primeiro.');

  const r = await fetch(
    `https://graph.facebook.com/v20.0/${config.wabaId}/message_templates?fields=name,status,category,language,components,rejected_reason&limit=100`,
    { headers: { Authorization: `Bearer ${config.accessToken}` } },
  );
  const j = await r.json() as any;
  if (!r.ok || j.error) {
    const code = j.error?.code ?? r.status;
    const msg = j.error?.error_user_msg || j.error?.message || 'Erro desconhecido';
    throw new Error(`${msg} (código: ${code})`);
  }
  return j.data || [];
}

/** Envia um novo template para aprovação da Meta. Lança erro (Error) com
 *  mensagem pronta para mostrar em caso de falha. */
export async function createMetaTemplate(accountId: string, params: {
  name: string;
  category: TemplateCategory;
  language?: string;
  body?: string;
  footer?: string;
  /** Só usado em AUTHENTICATION: minutos até o código expirar (padrão 10). */
  codeExpirationMinutes?: number;
}): Promise<any> {
  const config = await getWhatsAppConfig(accountId);
  if (!config?.accessToken) throw new Error('Configure o Access Token primeiro (aba API Oficial).');
  if (!config.wabaId) throw new Error('Informe o WABA ID em "Ativar recebimento" primeiro.');

  const { name, category, language = 'pt_BR', body, footer, codeExpirationMinutes } = params;

  let components: Record<string, unknown>[];
  if (category === 'AUTHENTICATION') {
    // Autenticação: a Meta gera o texto do código sozinha — o componente BODY
    // não pode ter "text" (é rejeitado com código 100). Só dá pra configurar a
    // recomendação de segurança, a expiração do código e o botão de copiar.
    components = [
      { type: 'BODY', add_security_recommendation: true },
      { type: 'FOOTER', code_expiration_minutes: codeExpirationMinutes ?? 10 },
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
    ];
  } else {
    if (!body?.trim()) throw new Error('Corpo da mensagem é obrigatório para esta categoria.');
    components = [{ type: 'BODY', text: body.trim() }];
    if (footer?.trim()) components.push({ type: 'FOOTER', text: footer.trim() });
  }

  const r = await fetch(`https://graph.facebook.com/v20.0/${config.wabaId}/message_templates`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: slugifyTemplateName(name), category, language, components }),
  });
  const j = await r.json() as any;
  if (!r.ok || j.error) {
    const code = j.error?.code ?? r.status;
    const msg = j.error?.error_user_msg || j.error?.message || 'Erro desconhecido';
    throw new Error(`${msg} (código: ${code})`);
  }
  return j;
}

/** Garante DDI 55 e o 9º dígito do celular brasileiro (ex: 556184549012 → 5561984549012). */
function normalizeBrazilianWhatsAppPhone(to: string): string {
  let phone = to.replace(/\D/g, '');

  if (phone.length === 10 || phone.length === 11) {
    phone = `55${phone}`;
  }

  if (phone.length === 12 && phone.startsWith('55')) {
    const local = phone.slice(4); // 8 dígitos locais (ex: 84549012)
    const first = parseInt(local[0], 10);
    if (first >= 6 && first <= 9) {
      phone = phone.slice(0, 4) + '9' + local; // 5561 + 9 + 84549012
    }
  }

  return phone;
}

/** Interpreta o erro da Graph API num formato consistente. */
function parseGraphError(json: { error?: { message: string; code: number } }, res: Response, phone: string): string {
  const errMsg  = json.error?.message || 'Erro desconhecido';
  const errCode = json.error?.code ?? res.status;
  if (errCode === 190) {
    return `Token de acesso inválido ou expirado. Acesse Configurações → API Oficial e gere um novo token. (código: 190)`;
  }
  return `${errMsg} (código: ${errCode}, número: ${phone})`;
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

  const phone = normalizeBrazilianWhatsAppPhone(to);
  console.log(`[WA Send] to="${to}" → phone="${phone}" (${phone.length} digits) phoneNumberId="${config.phoneNumberId}"`);
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
      console.error(`[WhatsApp] Send error para "${phone}":`, json.error);
      return { success: false, error: parseGraphError(json, res, phone) };
    }

    return { success: true, externalId: json.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] Fetch error:', err);
    return { success: false, error: 'Falha na conexão com a API do WhatsApp' };
  }
}

/** Envia uma mensagem de TEMPLATE (aprovado pela Meta) — único jeito de reabrir
 *  conversa fora da janela de 24h de atendimento gratuito. */
export async function sendWhatsAppTemplateMessage(
  to: string,
  templateName: string,
  language: string,
  bodyParams: string[],
  accountId: string
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  const config = await getWhatsAppConfig(accountId);
  if (!config) {
    return { success: false, error: 'WhatsApp não configurado. Acesse Configurações → API Oficial e salve suas credenciais.' };
  }
  if (!config.active) {
    return { success: false, error: 'WhatsApp inativo. Acesse Configurações → API Oficial e ative a integração.' };
  }

  const phone = normalizeBrazilianWhatsAppPhone(to);
  const url = `https://graph.facebook.com/v19.0/${config.phoneNumberId}/messages`;
  const components = bodyParams.length > 0
    ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
    : [];

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
        type: 'template',
        template: { name: templateName, language: { code: language }, components },
      }),
    });

    const json = await res.json() as {
      messages?: { id: string }[];
      error?: { message: string; code: number };
    };

    if (!res.ok || json.error) {
      console.error(`[WhatsApp] Template send error para "${phone}":`, json.error);
      return { success: false, error: parseGraphError(json, res, phone) };
    }

    return { success: true, externalId: json.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] Template fetch error:', err);
    return { success: false, error: 'Falha na conexão com a API do WhatsApp' };
  }
}

// Finds or creates the "Caixa de Entrada" pipeline for incoming WhatsApp leads
export async function getOrCreateWhatsAppPipeline(accountId: string) {
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

// Processa callbacks de status (sent → delivered → read)
export async function processWhatsAppStatus(body: any, io: any) {
  try {
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        const statuses = change?.value?.statuses;
        if (!statuses?.length) continue;

        for (const s of statuses) {
          const externalId = s.id as string;             // wamid.XXX
          const rawStatus  = (s.status as string || '').toUpperCase(); // sent/delivered/read

          // Mapeia para enum do banco
          const statusMap: Record<string, string> = {
            SENT:      'SENT',
            DELIVERED: 'DELIVERED',
            READ:      'READ',
            FAILED:    'FAILED',
          };
          const newStatus = statusMap[rawStatus];
          if (!newStatus || !externalId) continue;

          // Quando falha, a Meta manda o motivo em s.errors — sem guardar isso,
          // a mensagem só aparecia "falhou" sem nenhuma explicação do porquê.
          let statusError: string | null = null;
          if (newStatus === 'FAILED' && Array.isArray(s.errors) && s.errors.length > 0) {
            const e = s.errors[0];
            const details = e?.error_data?.details;
            statusError = [e?.title || e?.message, details].filter(Boolean).join(' — ');
            if (e?.code) statusError = `${statusError} (código: ${e.code})`;
            console.error(`[WA Status] Falha ao entregar ${externalId}:`, JSON.stringify(s.errors));
          }

          // Atualiza mensagem pelo externalId
          const updated = await prisma.message.updateMany({
            where: { externalId },
            data:  { status: newStatus as any, ...(statusError ? { statusError } : {}) },
          });

          if (updated.count > 0) {
            console.log(`[WA Status] ${externalId} → ${newStatus}${statusError ? ` (${statusError})` : ''}`);
            // Busca a mensagem para emitir via socket
            const msg = await prisma.message.findFirst({ where: { externalId } });
            if (msg && io) {
              io.to(`lead:${msg.leadId}`).emit('message_status', {
                id: msg.id,
                status: newStatus,
                statusError: msg.statusError,
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[WA Status] Erro:', err);
  }
}

/** Extrai metadados de uma mídia recebida pela Cloud API (image/audio/video/document/sticker).
 *  Retorna null para texto e para tipos sem mídia (location, contacts, reaction, etc.). */
function getCloudApiMediaInfo(msg: any): { mediaId: string; fileName: string; mimeType: string; caption?: string } | null {
  const node = msg?.[msg?.type];
  const mediaId = node?.id;
  if (!mediaId) return null;
  // O WhatsApp às vezes manda "audio/ogg; codecs=opus" — guardamos só o mime base.
  const mimeType = (node.mime_type || 'application/octet-stream').split(';')[0].trim();
  let fileName: string;
  switch (msg.type) {
    case 'image':    fileName = `foto-${Date.now()}.${mimeType.includes('png') ? 'png' : 'jpg'}`; break;
    case 'video':    fileName = `video-${Date.now()}.${mimeType.includes('3gpp') ? '3gp' : 'mp4'}`; break;
    case 'audio':    fileName = `audio-${Date.now()}.${mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('ogg') ? 'ogg' : 'm4a'}`; break;
    case 'sticker':  fileName = `sticker-${Date.now()}.webp`; break;
    case 'document': fileName = node.filename || `documento-${Date.now()}`; break;
    default: return null;
  }
  return { mediaId, fileName, mimeType, caption: node.caption };
}

/** Baixa a mídia da Cloud API: 1) resolve a URL temporária pelo media-id, 2) baixa os bytes.
 *  Os dois passos exigem o token. Retorna null (sem derrubar o recebimento) se algo falhar. */
async function downloadCloudApiMedia(mediaId: string, token: string): Promise<Buffer | null> {
  try {
    const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const meta = await metaRes.json() as { url?: string; error?: { message?: string } };
    if (!meta.url) {
      console.error('[WA Media] sem URL para media', mediaId, meta.error?.message);
      return null;
    }
    const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!fileRes.ok) {
      console.error('[WA Media] download falhou:', fileRes.status);
      return null;
    }
    return Buffer.from(await fileRes.arrayBuffer());
  } catch (err) {
    console.error('[WA Media] erro ao baixar:', (err as any)?.message);
    return null;
  }
}

export async function processIncomingWhatsApp(body: any, accountId: string, io: any) {
  try {
    const config = await getWhatsAppConfig(accountId);
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.length) return;

    for (const msg of value.messages) {
      const mediaInfo = getCloudApiMediaInfo(msg);
      // Processa texto OU mídia suportada (imagem/áudio/vídeo/documento/sticker).
      // Ignora location, contacts, reaction, etc.
      if (msg.type !== 'text' && !mediaInfo) continue;

      const from = msg.from as string; // e.g. "5561999990001"
      const text = mediaInfo
        ? `📎 ${mediaInfo.fileName}${mediaInfo.caption ? ` — ${mediaInfo.caption}` : ''}`
        : (msg.text?.body as string) || '';
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

      // ── Baixa a mídia, se houver (não bloqueia o texto se falhar) ────────
      let mediaBuffer: Buffer | null = null;
      if (mediaInfo && config?.accessToken) {
        mediaBuffer = await downloadCloudApiMedia(mediaInfo.mediaId, config.accessToken);
      }

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
          ...(mediaBuffer && mediaInfo ? {
            attachments: {
              create: { leadId, fileName: mediaInfo.fileName, mimeType: mediaInfo.mimeType, data: mediaBuffer },
            },
          } : {}),
        },
        include: { attachments: true },
      });

      // Mídia fica no CRM (banco) — o upload pro Drive agora é só sob-demanda.

      // ── Emit via Socket.io ──────────────────────────────────────────────
      if (io) {
        // Para quem está com o lead aberto (atualiza o chat em tempo real)
        io.to(`lead:${leadId}`).emit('new_message', message);
        // Para o dashboard inteiro — evento SEPARADO só para som/badge (sem duplicar mensagem)
        io.to(`account_${accountId}`).emit('new_notification', { leadId, message });
      }
    }
  } catch (err) {
    console.error('[WhatsApp] Process incoming error:', err);
  }
}
