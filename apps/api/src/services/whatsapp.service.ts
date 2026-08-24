import { PrismaClient } from '@prisma/client';
import { getOrCreateInboxPipeline } from './department.service';
import { generateAiAutoReply } from './ai-auto-reply.service';
import { normalizeClientName } from '../lib/text';
// maybeSalesBotStep/runAutomations/maybeMessageReceivedAutomations: require()
// tardio (dentro da função, não aqui em cima) — salesbot.service.ts e
// automation.service.ts importam de volta este arquivo (pra mandar
// mensagem), um import estático nos dois sentidos criaria dependência
// circular. Mesmo motivo documentado em baileys.service.ts pra manter os
// fluxos QR/API separados em vez de compartilhar um helper comum.

const prisma = new PrismaClient();

/**
 * Config da API Oficial. Um WhatsAppConfig por DEPARTAMENTO agora (não mais
 * por conta) — cada setor pode ter seu próprio número (ex: Financiamento
 * Habitacional e Consórcio).
 * - departmentId informado (setor de verdade): tenta achar a config EXATA
 *   desse setor; se esse setor ainda não tiver um número próprio (comum —
 *   nem toda conta configura um número por setor), cai pra config
 *   "genérica" ou a única que a conta tiver, em vez de simplesmente falhar.
 * - departmentId ausente/null: direto pra "genérica ou a única".
 */
export async function getWhatsAppConfig(accountId: string, departmentId?: string | null) {
  if (departmentId) {
    const exact = await prisma.whatsAppConfig.findFirst({ where: { accountId, departmentId } });
    if (exact) return exact;
  }
  return (
    (await prisma.whatsAppConfig.findFirst({ where: { accountId, departmentId: null } })) ||
    (await prisma.whatsAppConfig.findFirst({ where: { accountId } }))
  );
}

export async function saveWhatsAppConfig(accountId: string, departmentId: string | null, data: {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  active: boolean;
}) {
  // upsert() exigiria a chave composta accountId_departmentId, que o Prisma
  // não deixa usar com NULL — faz o "upsert" na mão via id.
  if (departmentId) {
    const existing = await prisma.whatsAppConfig.findFirst({ where: { accountId, departmentId } });
    if (existing) return prisma.whatsAppConfig.update({ where: { id: existing.id }, data });
    return prisma.whatsAppConfig.create({ data: { accountId, departmentId, ...data } });
  }
  // Sem setor escolhido no seletor: atualiza a config "genérica" se existir;
  // senão, se a conta já tiver QUALQUER config (ex: migrada pra um setor na
  // hora que os departamentos foram criados), atualiza essa mesma — evita
  // criar uma config duplicada só porque salvou sem trocar o seletor de setor.
  const generic = await prisma.whatsAppConfig.findFirst({ where: { accountId, departmentId: null } });
  if (generic) return prisma.whatsAppConfig.update({ where: { id: generic.id }, data });
  const anyExisting = await prisma.whatsAppConfig.findFirst({ where: { accountId } });
  if (anyExisting) return prisma.whatsAppConfig.update({ where: { id: anyExisting.id }, data });
  return prisma.whatsAppConfig.create({ data: { accountId, departmentId: null, ...data } });
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
export async function listMetaTemplates(accountId: string, departmentId?: string | null): Promise<any[]> {
  const config = await getWhatsAppConfig(accountId, departmentId);
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
}, departmentId?: string | null): Promise<any> {
  const config = await getWhatsAppConfig(accountId, departmentId);
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

/** Exclui um template já criado (aprovado, rejeitado ou pendente) na Meta —
 *  a Graph API apaga pelo NOME do template, não por id. Lança erro (Error)
 *  com mensagem pronta para mostrar em caso de falha. */
export async function deleteMetaTemplate(accountId: string, name: string, departmentId?: string | null): Promise<void> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config?.accessToken) throw new Error('Configure o Access Token primeiro (aba API Oficial).');
  if (!config.wabaId) throw new Error('Informe o WABA ID em "Ativar recebimento" primeiro.');

  const r = await fetch(
    `https://graph.facebook.com/v20.0/${config.wabaId}/message_templates?name=${encodeURIComponent(name)}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${config.accessToken}` } },
  );
  const j = await r.json() as any;
  if (!r.ok || j.error) {
    const code = j.error?.code ?? r.status;
    const msg = j.error?.error_user_msg || j.error?.message || 'Erro desconhecido';
    throw new Error(`${msg} (código: ${code})`);
  }
}

/** Garante DDI 55 e o 9º dígito do celular brasileiro (ex: 556184549012 → 5561984549012). */
/** Normaliza um telefone BR pra E.164 (com DDI 55) — inclui o 9º dígito
 *  quando falta (número móvel sem ele, ex.: "6182667819" → "556198266
 *  7819"): DDD + 8 dígitos locais começando em 6-9 é celular sem o 9º
 *  dígito (fixo começa em 2-5, não leva 9). Exportada porque tanto o envio
 *  quanto o cadastro de telefone (routes/leads.ts) precisam da MESMA regra
 *  — sem isso, o mesmo número gravado com/sem o 9 vira dois contatos
 *  diferentes pro sistema (já aconteceu: telefone_1 salvo sem essa
 *  normalização criou um Contact duplicado). */
export function normalizeBrazilianWhatsAppPhone(to: string): string {
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
  accountId: string,
  departmentId?: string | null,
  replyToWamid?: string | null
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  const config = await getWhatsAppConfig(accountId, departmentId);
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
        // Citação: a Meta só aceita responder a uma mensagem que também tenha
        // vindo/ido por este mesmo canal (id no formato "wamid...").
        ...(replyToWamid?.startsWith('wamid') ? { context: { message_id: replyToWamid } } : {}),
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

/** Envia um arquivo (imagem/vídeo/áudio/documento) pela API Oficial — a
 *  Graph API exige 2 passos: 1) sobe o binário pro endpoint de mídia
 *  (devolve um media_id), 2) manda a mensagem referenciando esse id. Antes
 *  desta função, envio de mídia SÓ existia pelo QR (Baileys) — mensagem de
 *  texto já respeitava o canal escolhido (QR ou API Oficial) há tempos, mas
 *  um anexo saía sempre pelo QR mesmo com "API Oficial" selecionado na
 *  conversa (achado real, reportado pelo usuário). */
export async function sendWhatsAppMedia(
  to: string,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  caption: string,
  accountId: string,
  departmentId?: string | null
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config) return { success: false, error: 'WhatsApp não configurado. Acesse Configurações → API Oficial e salve suas credenciais.' };
  if (!config.active) return { success: false, error: 'WhatsApp inativo. Acesse Configurações → API Oficial e ative a integração.' };

  const phone = normalizeBrazilianWhatsAppPhone(to);
  const mediaType = mimeType.startsWith('image/') ? 'image'
    : mimeType.startsWith('video/') ? 'video'
    : mimeType.startsWith('audio/') ? 'audio'
    : 'document';

  try {
    // 1) upload do binário — endpoint separado, devolve só um media_id.
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', new Blob([buffer], { type: mimeType }), fileName);
    const uploadRes = await fetch(`https://graph.facebook.com/v19.0/${config.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}` },
      body: form as any,
    });
    const uploadJson = await uploadRes.json() as { id?: string; error?: { message: string; code: number } };
    if (!uploadRes.ok || uploadJson.error || !uploadJson.id) {
      console.error(`[WhatsApp] Erro no upload de mídia para "${phone}":`, uploadJson.error);
      return { success: false, error: parseGraphError(uploadJson, uploadRes, phone) };
    }

    // 2) manda a mensagem de verdade, referenciando o media_id do passo 1.
    const mediaObj: Record<string, unknown> = { id: uploadJson.id };
    if (mediaType === 'document') mediaObj.filename = fileName;
    if (caption && mediaType !== 'audio') mediaObj.caption = caption; // áudio não aceita legenda na API

    const sendRes = await fetch(`https://graph.facebook.com/v19.0/${config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: phone, type: mediaType, [mediaType]: mediaObj }),
    });
    const sendJson = await sendRes.json() as { messages?: { id: string }[]; error?: { message: string; code: number } };
    if (!sendRes.ok || sendJson.error) {
      console.error(`[WhatsApp] Erro ao mandar mídia para "${phone}":`, sendJson.error);
      return { success: false, error: parseGraphError(sendJson, sendRes, phone) };
    }
    return { success: true, externalId: sendJson.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] Fetch error (mídia):', err);
    return { success: false, error: 'Falha na conexão com a API do WhatsApp' };
  }
}

/** Reage com um emoji a uma mensagem (nossa ou do cliente) — `emoji: ''`
 *  remove a reação. Só reage, não manda mensagem nova nenhuma. `wamid` é o
 *  id (com prefixo "wamid.") da mensagem alvo, sempre no formato que a Meta
 *  usa nesse canal. */
export async function sendWhatsAppReaction(
  to: string,
  wamid: string,
  emoji: string,
  accountId: string,
  departmentId?: string | null
): Promise<{ success: boolean; error?: string }> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config) return { success: false, error: 'WhatsApp não configurado.' };
  if (!config.active) return { success: false, error: 'WhatsApp inativo.' };

  const phone = normalizeBrazilianWhatsAppPhone(to);
  const url = `https://graph.facebook.com/v19.0/${config.phoneNumberId}/messages`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'reaction',
        reaction: { message_id: wamid, emoji },
      }),
    });
    const json = await res.json() as { error?: { message: string; code: number } };
    if (!res.ok || json.error) {
      console.error(`[WhatsApp] Erro ao reagir para "${phone}":`, json.error);
      return { success: false, error: parseGraphError(json, res, phone) };
    }
    return { success: true };
  } catch (err) {
    console.error('[WhatsApp] Fetch error (reação):', err);
    return { success: false, error: 'Falha na conexão com a API do WhatsApp' };
  }
}

/** Envia uma mensagem com até 3 botões de resposta rápida (interactive reply
 *  buttons) — usado pelo SalesBot (ex.: "Sim"/"Não" clicáveis). Diferente de
 *  template, NÃO precisa aprovação da Meta (é uma mensagem de texto comum
 *  com botões), mas só existe na API Oficial — não tem equivalente confiável
 *  no canal QR/Baileys (o WhatsApp descontinuou botões nativos por lá; quem
 *  chama por esse canal usa uma lista numerada no texto em vez disto). */
export async function sendWhatsAppButtonsMessage(
  to: string,
  body: string,
  buttons: string[],
  accountId: string,
  departmentId?: string | null
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  const config = await getWhatsAppConfig(accountId, departmentId);
  if (!config) return { success: false, error: 'WhatsApp não configurado. Acesse Configurações → API Oficial e salve suas credenciais.' };
  if (!config.active) return { success: false, error: 'WhatsApp inativo. Acesse Configurações → API Oficial e ative a integração.' };

  const phone = normalizeBrazilianWhatsAppPhone(to);
  const url = `https://graph.facebook.com/v19.0/${config.phoneNumberId}/messages`;
  // Meta permite no máximo 3 botões e 20 caracteres por título.
  const trimmedButtons = buttons.slice(0, 3);

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
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: {
            buttons: trimmedButtons.map((label, i) => ({
              type: 'reply',
              reply: { id: `salesbot_btn_${i}`, title: label.slice(0, 20) },
            })),
          },
        },
      }),
    });

    const json = await res.json() as {
      messages?: { id: string }[];
      error?: { message: string; code: number };
    };

    if (!res.ok || json.error) {
      console.error(`[WhatsApp] Send buttons error para "${phone}":`, json.error);
      return { success: false, error: parseGraphError(json, res, phone) };
    }

    return { success: true, externalId: json.messages?.[0]?.id };
  } catch (err) {
    console.error('[WhatsApp] Fetch error (buttons):', err);
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
  accountId: string,
  departmentId?: string | null
): Promise<{ success: boolean; externalId?: string; error?: string }> {
  const config = await getWhatsAppConfig(accountId, departmentId);
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

// Finds or creates the "Caixa de Entrada" pipeline for incoming WhatsApp leads.
// Sem departmentId: mantém o comportamento antigo (casa por vários nomes
// legados, pipeline "genérica"/compartilhada — conta que só tem uma linha de
// negócio). Com departmentId: cai no funil "Caixa de Entrada" DAQUELE setor
// (cria um novo se ainda não existir), separado dos outros setores.
export async function getOrCreateWhatsAppPipeline(accountId: string, departmentId?: string | null) {
  if (departmentId) {
    return getOrCreateInboxPipeline(accountId, departmentId);
  }

  // Try to find existing pipeline named "Caixa de Entrada" (or legacy names)
  let pipeline = await prisma.pipeline.findFirst({
    where: {
      accountId,
      departmentId: null,
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

export async function processIncomingWhatsApp(body: any, accountId: string, io: any, departmentId?: string | null) {
  try {
    const config = await getWhatsAppConfig(accountId, departmentId);
    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.length) return;

    for (const msg of value.messages) {
      const mediaInfo = getCloudApiMediaInfo(msg);
      // Clique em botão de resposta rápida (ex.: Sim/Não do SalesBot) — antes
      // disto, uma resposta assim era descartada inteira (nem virava Message),
      // por não ser nem "text" nem mídia suportada.
      const buttonReplyTitle: string | undefined = msg.type === 'interactive'
        ? (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title)
        : undefined;

      // Reação (emoji) do cliente numa mensagem existente — não vira Message
      // nova, só atualiza a mensagem alvo. Precisa vir ANTES do filtro de
      // descarte abaixo (reaction não é texto/botão/mídia, cairia fora sem isso).
      if (msg.type === 'reaction') {
        const targetWamid = msg.reaction?.message_id as string | undefined;
        const emoji = (msg.reaction?.emoji as string | undefined) || '';
        if (targetWamid) {
          try {
            const existing = await prisma.message.findFirst({
              where: { externalId: targetWamid, lead: { accountId } },
              select: { id: true, leadId: true, reactions: true },
            });
            if (existing) {
              const current = (Array.isArray(existing.reactions) ? existing.reactions : []) as { emoji: string; fromMe: boolean; at: string }[];
              const withoutReactor = current.filter((r) => r.fromMe); // reação do cliente: sempre fromMe:false
              const next = emoji ? [...withoutReactor, { emoji, fromMe: false, at: new Date().toISOString() }] : withoutReactor;
              await prisma.message.update({ where: { id: existing.id }, data: { reactions: next as any } });
              io.to(`lead:${existing.leadId}`).emit('message_reaction', { id: existing.id, reactions: next });
            }
          } catch (err) {
            console.error('[WhatsApp] Erro ao processar reação recebida:', err);
          }
        }
        continue;
      }

      // Processa texto, clique em botão, OU mídia suportada (imagem/áudio/
      // vídeo/documento/sticker). Ignora location, contacts, etc.
      if (msg.type !== 'text' && !buttonReplyTitle && !mediaInfo) continue;

      const from = msg.from as string; // e.g. "5561999990001"
      const text = mediaInfo
        ? `📎 ${mediaInfo.fileName}${mediaInfo.caption ? ` — ${mediaInfo.caption}` : ''}`
        : buttonReplyTitle || (msg.text?.body as string) || '';
      const externalId = msg.id as string;
      const profileName = normalizeClientName(value.contacts?.[0]?.profile?.name || `+${from}`);
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
        // Get dedicated WhatsApp pipeline (do setor deste número/config, se houver)
        const pipeline = await getOrCreateWhatsAppPipeline(accountId, departmentId);
        const admin =
          (departmentId && await prisma.user.findFirst({ where: { accountId, departmentIds: { has: departmentId } }, orderBy: { createdAt: 'asc' } })) ||
          (await prisma.user.findFirst({ where: { accountId }, orderBy: { createdAt: 'asc' } }));

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
        const { runAutomations } = require('./automation.service') as typeof import('./automation.service');
        runAutomations({ accountId, trigger: 'NEW_LEAD', leadId: lead.id, io }).catch(() => {});
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

      // Gatilho automático (Templates → "Disparar automaticamente") e
      // assistente de IA (Inbox → botão de IA na conversa) — só para texto de
      // verdade, não mídia. Template tem prioridade sobre a resposta de IA.
      if ((msg.type === 'text' || buttonReplyTitle) && text) {
        // SalesBot tem prioridade — se uma resposta continua um fluxo em
        // andamento (ou dispara um novo por palavra-chave), template/IA não
        // entram em cima da mesma mensagem (mesma regra de exclusividade que
        // já existe entre template e IA logo abaixo).
        const { maybeSalesBotStep } = require('./salesbot.service') as typeof import('./salesbot.service');
        const botHandled = await maybeSalesBotStep(accountId, leadId, text, io);
        if (!botHandled) {
          const templateDisparou = await maybeAutoReplyCloudApi(accountId, leadId, text, from, io, departmentId);
          if (!templateDisparou) {
            const { maybeMessageReceivedAutomations } = require('./automation.service') as typeof import('./automation.service');
            const automationHandled = await maybeMessageReceivedAutomations(accountId, leadId, text, io);
            if (!automationHandled) {
              await maybeAiAutoReplyCloudApi(accountId, leadId, text, from, io, departmentId);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('[WhatsApp] Process incoming error:', err);
  }
}

/** Verifica se algum template com gatilho automático ativo bate com o início
 *  da mensagem recebida e, se achar, envia o corpo dele como resposta pela
 *  API Oficial. Implementado aqui (não em message.service) de propósito, pra
 *  não criar import circular. Retorna true se disparou. */
async function maybeAutoReplyCloudApi(accountId: string, leadId: string, incomingText: string, phone: string, io: any, departmentId?: string | null): Promise<boolean> {
  try {
    const norm = incomingText.trim().toLowerCase();
    if (!norm) return false;
    // Só considera gatilhos do MESMO setor do número que recebeu (ou
    // "compartilhados", sem setor) — evita um gatilho de Consórcio disparar
    // numa conversa de Financiamento, por exemplo.
    const templates = await prisma.messageTemplate.findMany({
      where: {
        accountId,
        triggerActive: true,
        ...(departmentId ? { OR: [{ departmentId }, { departmentId: null }] } : {}),
      },
    });
    const match = templates.find((t: any) => t.triggerText && norm.startsWith(String(t.triggerText).trim().toLowerCase()));
    if (!match) return false;

    const alreadySent = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', content: match.body } });
    if (alreadySent) return false;

    const result = await sendWhatsAppMessage(phone, match.body, accountId, departmentId);
    if (!result.success) {
      console.error(`[WhatsApp] Gatilho automático "${match.name}" falhou ao enviar:`, result.error);
      return false;
    }
    const sent = await prisma.message.create({
      data: { content: match.body, direction: 'OUTBOUND', channel: 'WHATSAPP', leadId, read: true, externalId: result.externalId, status: 'SENT' },
    });
    if (io) io.to(`lead:${leadId}`).emit('new_message', sent);
    console.log(`[WhatsApp] Gatilho automático "${match.name}" disparado para lead ${leadId}`);
    return true;
  } catch (err) {
    console.error('[WhatsApp] Erro no gatilho automático:', err);
    return false;
  }
}

/** Assistente de IA respondendo o cliente sozinho (Inbox → botão de IA na
 *  conversa, Lead.aiAutoReplyActive) — só entra se o gatilho de template
 *  acima não disparou pra essa mensagem. Toda resposta enviada vira uma
 *  Note no card, pra equipe acompanhar/poder desligar se algo sair errado. */
async function maybeAiAutoReplyCloudApi(accountId: string, leadId: string, incomingText: string, phone: string, io: any, departmentId?: string | null): Promise<void> {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { aiAutoReplyActive: true } });
    if (!lead?.aiAutoReplyActive) return;

    const genResult = await generateAiAutoReply(accountId, leadId, incomingText);
    if (!genResult) return;
    const { reply, handoff } = genResult;

    const result = await sendWhatsAppMessage(phone, reply, accountId, departmentId);
    if (!result.success) {
      console.error('[WhatsApp] Resposta de IA falhou ao enviar:', result.error);
      return;
    }
    const sent = await prisma.message.create({
      data: { content: reply, direction: 'OUTBOUND', channel: 'WHATSAPP', leadId, read: true, externalId: result.externalId, status: 'SENT' },
    });
    if (io) io.to(`lead:${leadId}`).emit('new_message', sent);
    await prisma.note.create({ data: { leadId, content: `Resposta automática da IA: "${reply}"`, type: 'COMMENT' } }).catch(() => {});
    console.log(`[WhatsApp] Resposta de IA enviada automaticamente para lead ${leadId}`);

    if (handoff) await handleAiHandoffCloudApi(leadId, io);
  } catch (err) {
    console.error('[WhatsApp] Erro na resposta automática de IA:', err);
  }
}

/** Cliente pediu atendimento humano (ou saiu do escopo do setor) — desliga a
 *  IA nessa conversa sozinha e avisa o colaborador responsável (som + toast).
 *  Duplicado de baileys.service.ts de propósito (não import), pra não criar
 *  dependência circular nesse arquivo crítico. */
async function handleAiHandoffCloudApi(leadId: string, io: any) {
  try {
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { aiAutoReplyActive: false },
      select: { id: true, name: true, userId: true },
    });
    await prisma.note.create({ data: { leadId, content: 'Atendimento automático encerrado — cliente pediu atendimento humano (ou pergunta fora do escopo deste chat). Repassado para a equipe.', type: 'COMMENT' } }).catch(() => {});
    if (io) {
      io.to(`lead:${leadId}`).emit('lead_ai_toggled', { leadId, active: false });
      if (lead.userId) io.to(`user_${lead.userId}`).emit('ai_handoff', { leadId, leadName: lead.name });
    }
  } catch (err) {
    console.error('[WhatsApp] Erro ao processar handoff da IA:', err);
  }
}
