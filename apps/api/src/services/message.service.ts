import { PrismaClient, Direction, Channel } from '@prisma/client';
import { sendWhatsAppMessage, sendWhatsAppTemplateMessage, sendWhatsAppButtonsMessage, sendWhatsAppCtaUrlMessage, sendWhatsAppReaction, sendWhatsAppMedia } from './whatsapp.service';
import { downloadDriveFile } from './google.service';
import { normalizeClientName } from '../lib/text';

const prisma = new PrismaClient();

/** Telefone "puro" (E.164, sem sufixo @lid/@s.whatsapp.net/@g.us) — a API
 *  Oficial da Meta exige isso e rejeita qualquer outra coisa com "Message
 *  Undeliverable" (código 131026). Contatos que só têm um @lid (herdados do
 *  extinto canal QR/Baileys) não têm telefone de verdade pra API conseguir
 *  mandar — precisam do telefone cadastrado manualmente no card. */
function plainPhone(contact?: { phone?: string | null; whatsappPhone?: string | null } | null): string | undefined {
  const wp = contact?.whatsappPhone?.trim();
  if (wp && !wp.includes('@')) return wp;
  const p = contact?.phone?.trim();
  return p && !p.includes('@') ? p : undefined;
}

/**
 * Mensagens de uma conversa. Confere que o lead é da conta e (se o usuário
 * for de setor(es) específico(s)) de algum deles — senão devolve null, como
 * se a conversa não existisse pra quem está pedindo.
 */
export async function getMessages(leadId: string, accountId: string, scopeDepartmentIds: string[] = [], scopeNumberIds: string[] | null = null) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: { pipeline: { select: { departmentId: true } } },
  });
  if (!lead) return null;
  if (scopeDepartmentIds.length && lead.pipeline.departmentId && !scopeDepartmentIds.includes(lead.pipeline.departmentId)) return null;

  // Mesma restrição por número do getConversations() (lista), aplicada aqui
  // também — senão dava pra abrir uma conversa fora do escopo direto pelo
  // link (leadId), sem passar pela lista filtrada.
  if (scopeNumberIds) {
    const whatsappMsgs = await prisma.message.findMany({
      where: { leadId, channel: 'WHATSAPP' },
      select: { whatsappNumberId: true },
      take: 50,
    });
    if (whatsappMsgs.length > 0) {
      const usedApi = whatsappMsgs.some((m) => !m.whatsappNumberId);
      const usedNumbers = whatsappMsgs.map((m) => m.whatsappNumberId).filter((v): v is string => !!v);
      const allowed = usedNumbers.some((id) => scopeNumberIds.includes(id)) || (usedApi && scopeNumberIds.includes('API'));
      if (!allowed) return null;
    }
  }

  return prisma.message.findMany({
    where: { leadId },
    orderBy: { createdAt: 'asc' },
    include: {
      attachments: {
        select: { id: true, fileName: true, mimeType: true, driveFileId: true },
      },
      // Nome de quem enviou (só nas mensagens enviadas pela Inbox do CRM).
      sentBy: { select: { id: true, name: true } },
    },
  });
}

export async function createMessage(data: {
  content: string;
  direction: Direction;
  channel: Channel;
  leadId: string;
  whatsappNumberId?: string;
  sentByUserId?: string;
  externalId?: string;
  status?: string;
  replyToExternalId?: string;
  replyToContent?: string;
  replyToSender?: string;
}) {
  return prisma.message.create({
    data: data as any,
    include: { sentBy: { select: { id: true, name: true } } },
  });
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
 * Resolve um funil/estágio de destino para o accountId. Aceita id do estágio
 * (preferido — já define o funil) ou id do funil (usa o 1º estágio dele).
 * Retorna null se os ids não pertencerem à conta / não existirem.
 */
export async function resolveStageTarget(
  accountId: string,
  pipelineId?: string,
  stageId?: string
): Promise<{ pipelineId: string; stageId: string } | null> {
  if (stageId) {
    const stage = await prisma.stage.findFirst({ where: { id: stageId, pipeline: { accountId } } });
    if (stage) return { pipelineId: stage.pipelineId, stageId: stage.id };
  }
  if (pipelineId) {
    const pipeline = await prisma.pipeline.findFirst({
      where: { id: pipelineId, accountId },
      include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
    });
    if (pipeline?.stages.length) return { pipelineId: pipeline.id, stageId: pipeline.stages[0].id };
  }
  return null;
}

/**
 * Encontra (ou cria) um lead a partir de um número de telefone.
 * Preenche os campos do card (participante_1 + telefone_1) para que o
 * telefone apareça no detalhe do lead. Retorna o leadId ou null se não
 * houver funil/usuário configurado.
 * Se `target` (funil/estágio já resolvido) for informado, cria o card nesse
 * estágio — e, se o lead já existir, move-o para lá.
 */
export async function findOrCreateLeadByPhone(
  accountId: string,
  rawPhone: string,
  name?: string,
  target?: { pipelineId: string; stageId: string }
): Promise<{ leadId: string; created: boolean } | null> {
  const phone = normalizeBRPhone(rawPhone);
  const last8 = phone.slice(-8);

  let contact = await prisma.contact.findFirst({
    where: { accountId, OR: [{ whatsappPhone: phone }, { phone: { contains: last8 } }] },
    include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
  });

  const displayName = normalizeClientName(name?.trim() || formatPhoneDisplay(phone));

  if (!contact) {
    contact = await prisma.contact.create({
      data: { name: displayName, whatsappPhone: phone, phone: `+${phone}`, accountId },
      include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
    });
  } else if (!contact.whatsappPhone) {
    await prisma.contact.update({ where: { id: contact.id }, data: { whatsappPhone: phone } });
  }

  const existing = (contact as any).leads?.[0];
  if (existing) {
    // Lead já existe: se pediram um funil/estágio específico, move o card para lá.
    if (target) {
      await prisma.lead.update({
        where: { id: existing.id },
        data: { pipelineId: target.pipelineId, stageId: target.stageId },
      }).catch(() => {});
    }
    return { leadId: existing.id, created: false };
  }

  // Destino do card: o funil/estágio pedido (target) ou o 1º estágio do 1º funil.
  let pipelineId = target?.pipelineId;
  let stageId = target?.stageId;
  if (!pipelineId || !stageId) {
    const pipeline = await prisma.pipeline.findFirst({
      where: { accountId },
      include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
    });
    if (!pipeline?.stages.length) return null;
    pipelineId = pipeline.id;
    stageId = pipeline.stages[0].id;
  }
  const admin = await prisma.user.findFirst({ where: { accountId } });
  if (!admin) return null;

  const lead = await prisma.lead.create({
    data: {
      name: contact.name,
      accountId,
      pipelineId,
      stageId,
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
 * Envia uma mensagem WhatsApp de saída para o lead pela API Oficial da Meta,
 * grava o registro e emite os eventos de socket — mesma lógica usada tanto
 * pelo envio manual (Inbox) quanto pelo agente de IA e o SalesBot.
 */
export async function sendOutboundWhatsApp(params: {
  accountId: string;
  leadId: string;
  content: string;
  /** Usuário do CRM que está enviando (para carimbar "enviado por" na mensagem). */
  userId?: string;
  /** Resposta com citação (como no WhatsApp): id/remetente/conteúdo da mensagem
   *  original, "congelados" no momento do envio — não é uma relação de verdade. */
  replyToExternalId?: string;
  replyToFromMe?: boolean;
  replyToContent?: string;
  replyToSender?: string;
  /** Botões de resposta rápida (ex.: ["Sim","Não"], máx. 3) — usado pelo
   *  SalesBot e pelas Respostas rápidas com botão. Nunca junto com `ctaButton`
   *  — a API do WhatsApp só aceita um tipo por mensagem avulsa. */
  buttons?: string[];
  /** Botão único de link (Respostas rápidas com botão "URL"). */
  ctaButton?: { text: string; url: string };
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
}): Promise<{ success: true; message: Awaited<ReturnType<typeof createMessage>> } | { success: false; error: string; code?: string }> {
  const { accountId, leadId, content, userId, replyToExternalId, replyToContent, replyToSender, buttons, ctaButton, io } = params;

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: { contact: true, pipeline: { select: { departmentId: true } } },
  });
  if (!lead) return { success: false, error: 'Lead não encontrado' };

  // A API Oficial exige um número de verdade — @lid (só existia por Baileys/QR) não serve.
  const cloudPhone = plainPhone(lead.contact);
  if (!cloudPhone) {
    return { success: false, code: 'NO_REAL_PHONE', error: 'Este contato só tem um identificador do WhatsApp (@lid), sem telefone de verdade cadastrado — a API Oficial não consegue enviar. Cadastre o telefone no card.' };
  }

  let externalId: string | undefined;
  // O que fica gravado na Inbox como o texto da mensagem — igual a `content`,
  // exceto quando há botões: eles são um elemento à parte na API Oficial,
  // então anexamos só como registro legível do que foi oferecido.
  let savedContent = content;

  const result = buttons?.length
    ? await sendWhatsAppButtonsMessage(cloudPhone, content, buttons, accountId, lead.pipeline.departmentId)
    : ctaButton
    ? await sendWhatsAppCtaUrlMessage(cloudPhone, content, ctaButton.text, ctaButton.url, accountId, lead.pipeline.departmentId)
    : await sendWhatsAppMessage(cloudPhone, content, accountId, lead.pipeline.departmentId, replyToExternalId);
  if (result.success) {
    externalId = result.externalId;
    if (buttons?.length) savedContent = `${content}\n\n${buttons.map((b) => `[${b}]`).join('  ')}`;
    else if (ctaButton) savedContent = `${content}\n\n[${ctaButton.text} → ${ctaButton.url}]`;
  } else {
    return { success: false, error: result.error || 'Falha ao enviar mensagem WhatsApp' };
  }

  const message = await createMessage({
    content: savedContent,
    direction: 'OUTBOUND',
    channel: 'WHATSAPP',
    leadId,
    sentByUserId: userId,
    externalId,
    status: 'SENT',
    replyToExternalId: replyToExternalId || undefined,
    replyToContent: replyToContent || undefined,
    replyToSender: replyToSender || undefined,
  });

  if (io) {
    io.to(`lead:${leadId}`).emit('new_message', message);
    io.to(`account_${accountId}`).emit('new_notification', { leadId, message });
  }

  return { success: true, message };
}

/** Envia uma mensagem de TEMPLATE aprovado pela Meta (API oficial) — funciona
 *  mesmo fora da janela de 24h de atendimento gratuito, ao contrário do texto
 *  livre. Só disponível pela API (templates não existem no WhatsApp pessoal/QR). */
export async function sendOutboundWhatsAppTemplate(params: {
  accountId: string;
  leadId: string;
  templateName: string;
  language: string;
  bodyParams: string[];
  /** Texto final (com as variáveis já preenchidas), para exibir na conversa. */
  previewText: string;
  userId?: string;
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
}): Promise<{ success: true; message: Awaited<ReturnType<typeof createMessage>> } | { success: false; error: string; code?: string }> {
  const { accountId, leadId, templateName, language, bodyParams, previewText, userId, io } = params;

  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, include: { contact: true, pipeline: { select: { departmentId: true } } } });
  if (!lead) return { success: false, error: 'Lead não encontrado' };

  // Template só vai pela API Oficial — precisa de telefone de verdade, não @lid.
  const phone = plainPhone(lead.contact);
  if (!phone) return { success: false, code: 'NO_REAL_PHONE', error: 'Este contato só tem um identificador do WhatsApp (@lid), sem telefone de verdade cadastrado — a API Oficial não consegue enviar. Cadastre o telefone no card.' };

  const result = await sendWhatsAppTemplateMessage(phone, templateName, language, bodyParams, accountId, lead.pipeline.departmentId);
  if (!result.success) return { success: false, error: result.error || 'Falha ao enviar template' };

  const message = await createMessage({
    content: previewText,
    direction: 'OUTBOUND',
    channel: 'WHATSAPP',
    leadId,
    sentByUserId: userId,
    externalId: result.externalId,
    status: 'SENT',
  });

  if (io) {
    io.to(`lead:${leadId}`).emit('new_message', message);
    io.to(`account_${accountId}`).emit('new_notification', { leadId, message });
  }

  return { success: true, message };
}

/** Envia um documento/imagem/vídeo/áudio pelo WhatsApp (API Oficial) e salva
 *  na conversa com o anexo. */
export async function sendOutboundMedia(params: {
  accountId: string;
  leadId: string;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  caption?: string;
  /** Usuário do CRM que está enviando (para carimbar "enviado por"). */
  userId?: string;
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
}): Promise<{ success: true; message: any } | { success: false; error: string; code?: string }> {
  const { accountId, leadId, buffer, fileName, mimeType, caption, userId, io } = params;

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: { contact: true, pipeline: { select: { departmentId: true } } },
  });
  if (!lead) return { success: false, error: 'Lead não encontrado' };

  const cloudPhone = plainPhone(lead.contact);
  if (!cloudPhone) {
    return { success: false, code: 'NO_REAL_PHONE', error: 'Este contato só tem um identificador do WhatsApp (@lid), sem telefone de verdade cadastrado — a API Oficial não consegue enviar. Cadastre o telefone no card.' };
  }

  const result = await sendWhatsAppMedia(cloudPhone, buffer, fileName, mimeType, caption || '', accountId, lead.pipeline.departmentId);
  if (!result.success) return { success: false, error: result.error || 'Falha ao enviar o arquivo pelo WhatsApp.' };
  const externalId = result.externalId;

  const content = `📎 ${fileName}${caption ? ` — ${caption}` : ''}`;
  const message = await prisma.message.create({
    data: {
      content, direction: 'OUTBOUND', channel: 'WHATSAPP', leadId,
      sentByUserId: userId ?? null, read: true, externalId, status: 'SENT',
      attachments: { create: { leadId, fileName, mimeType, data: buffer } },
    },
    include: {
      attachments: { select: { id: true, fileName: true, mimeType: true, driveFileId: true } },
      sentBy: { select: { id: true, name: true } },
    },
  });

  if (io) {
    io.to(`lead:${leadId}`).emit('new_message', message);
    io.to(`account_${accountId}`).emit('new_notification', { leadId, message });
  }

  // Anexo sobe pro Drive na hora e os bytes saem do banco. Sem isso o Postgres
  // enchia (incidentes de 2026-08-05 e 2026-08-26 — disco 100%, CRM fora do ar).
  // Fire-and-forget: falha/Drive desconectado não pode atrapalhar o envio (a
  // mensagem JÁ saiu pro cliente neste ponto) — nesse caso os bytes ficam no
  // banco mesmo, e o arquivamento periódico pega depois. A rota do anexo já
  // sabe servir do Drive quando `data` está vazio.
  for (const att of message.attachments || []) {
    const { autoUploadAttachmentToDrive } = require('./google.service') as typeof import('./google.service');
    autoUploadAttachmentToDrive(accountId, leadId, att.id).catch((err: any) =>
      console.error('[Drive] Auto-upload do anexo falhou:', err?.message));
  }

  return { success: true, message };
}

/** Encaminha uma mensagem (texto ou anexo) para OUTRA conversa/lead — reenvia
 *  de verdade pelo WhatsApp (não é só copiar no banco) e marca de onde veio,
 *  para aparecer com a etiqueta "Encaminhada de X" na conversa de destino. */
export async function forwardMessage(params: {
  accountId: string;
  messageId: string;
  toLeadId: string;
  userId?: string;
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
}): Promise<{ success: true; message: any } | { success: false; error: string }> {
  const { accountId, messageId, toLeadId, userId, io } = params;

  const source = await prisma.message.findUnique({
    where: { id: messageId },
    include: { attachments: true, lead: { select: { id: true, accountId: true, name: true } } },
  });
  if (!source || source.lead.accountId !== accountId) return { success: false, error: 'Mensagem não encontrada' };
  if (source.leadId === toLeadId) return { success: false, error: 'Escolha uma conversa diferente da atual' };

  const toLead = await prisma.lead.findFirst({ where: { id: toLeadId, accountId } });
  if (!toLead) return { success: false, error: 'Conversa de destino não encontrada' };

  let result: { success: true; message: any } | { success: false; error: string };

  const att = source.attachments[0];
  if (att) {
    let buffer: Buffer | null = null;
    try {
      buffer = att.data
        ? Buffer.from(att.data)
        : att.driveFileId
        ? await downloadDriveFile(accountId, att.driveFileId, att.mimeType)
        : null;
    } catch (err: any) {
      return { success: false, error: `Falha ao baixar o anexo original: ${err?.message || 'erro desconhecido'}` };
    }
    if (!buffer) return { success: false, error: 'Não foi possível recuperar o arquivo desta mensagem.' };
    const caption = source.content.includes(' — ') ? source.content.split(' — ').slice(1).join(' — ') : undefined;
    result = await sendOutboundMedia({ accountId, leadId: toLeadId, buffer, fileName: att.fileName, mimeType: att.mimeType, caption, userId, io });
  } else {
    result = await sendOutboundWhatsApp({ accountId, leadId: toLeadId, content: source.content, userId, io });
  }

  if (!result.success) return result;

  const patched = await prisma.message.update({
    where: { id: result.message.id },
    data: { forwardedFromLeadId: source.leadId, forwardedFromLeadName: source.lead.name },
    include: {
      attachments: { select: { id: true, fileName: true, mimeType: true, driveFileId: true } },
      sentBy: { select: { id: true, name: true } },
    },
  });

  // Nota: sendOutbound*/sendOutboundMedia já emitiram "new_message" (antes de
  // gravarmos forwardedFromLeadId); o front dedupa por id, então não reemitimos
  // aqui. Quem estiver com a conversa de destino aberta na hora vê a mensagem
  // no ato — só a etiqueta "Encaminhada de X" aparece ao reabrir/recarregar.

  return { success: true, message: patched };
}

type MessageActionIO = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
type MessageActionResult = { success: true; message: any } | { success: false; error: string };

/** "Apagar pra mim" (local, sempre) — a API Oficial não dá acesso a "apagar
 *  pra todos" de verdade (o WhatsApp de verdade também não deixa forçar
 *  apagar do celular de quem recebeu). */
export async function deleteMessage(params: { accountId: string; messageId: string; io?: MessageActionIO }): Promise<MessageActionResult> {
  const { accountId, messageId, io } = params;
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: { lead: { select: { id: true, accountId: true, contact: true } } },
  });
  if (!msg || msg.lead.accountId !== accountId) return { success: false, error: 'Mensagem não encontrada' };
  if (msg.deleted) return { success: true, message: msg };

  const updated = await prisma.message.update({ where: { id: messageId }, data: { deleted: true, deletedAt: new Date() } });
  if (io) io.to(`lead:${msg.leadId}`).emit('message_deleted', { id: messageId });
  return { success: true, message: updated };
}

/** Reage (ou remove a própria reação, emoji='') a uma mensagem — minha ou do
 *  cliente. Sempre grava local; a chamada de verdade pro WhatsApp é melhor
 *  esforço (não falha a operação toda se a API recusar). */
export async function reactToMessage(params: { accountId: string; messageId: string; emoji: string; io?: MessageActionIO }): Promise<MessageActionResult> {
  const { accountId, messageId, emoji, io } = params;
  const msg = await prisma.message.findUnique({
    where: { id: messageId },
    include: { lead: { select: { id: true, accountId: true, contact: true, pipeline: { select: { departmentId: true } } } } },
  });
  if (!msg || msg.lead.accountId !== accountId) return { success: false, error: 'Mensagem não encontrada' };
  if (!msg.externalId) return { success: false, error: 'Essa mensagem não pode receber reação.' };

  const phone = msg.lead.contact?.whatsappPhone || msg.lead.contact?.phone;
  if (phone) {
    const outcome = await sendWhatsAppReaction(phone, msg.externalId, emoji, accountId, msg.lead.pipeline?.departmentId ?? null);
    if (!outcome.success) console.warn(`[Messages] Reagir via API Oficial falhou: ${outcome.error}`);
  }

  const current = (Array.isArray(msg.reactions) ? msg.reactions : []) as { emoji: string; fromMe: boolean; at: string }[];
  const withoutMine = current.filter((r) => !r.fromMe);
  const next = emoji ? [...withoutMine, { emoji, fromMe: true, at: new Date().toISOString() }] : withoutMine;
  const updated = await prisma.message.update({ where: { id: messageId }, data: { reactions: next as any } });
  if (io) io.to(`lead:${msg.leadId}`).emit('message_reaction', { id: messageId, reactions: next });
  return { success: true, message: updated };
}

/** Fixar/Favoritar — só local, o WhatsApp de verdade também não sincroniza
 *  isso via API (é estado do app/cliente, não da conversa em si). */
export async function setMessagePinned(params: { accountId: string; messageId: string; pinned: boolean; io?: MessageActionIO }): Promise<MessageActionResult> {
  const { accountId, messageId, pinned, io } = params;
  const msg = await prisma.message.findUnique({ where: { id: messageId }, include: { lead: { select: { accountId: true } } } });
  if (!msg || msg.lead.accountId !== accountId) return { success: false, error: 'Mensagem não encontrada' };
  const updated = await prisma.message.update({ where: { id: messageId }, data: { pinned, pinnedAt: pinned ? new Date() : null } });
  if (io) io.to(`lead:${msg.leadId}`).emit('message_pinned', { id: messageId, pinned });
  return { success: true, message: updated };
}

export async function setMessageStarred(params: { accountId: string; messageId: string; starred: boolean; io?: MessageActionIO }): Promise<MessageActionResult> {
  const { accountId, messageId, starred, io } = params;
  const msg = await prisma.message.findUnique({ where: { id: messageId }, include: { lead: { select: { accountId: true } } } });
  if (!msg || msg.lead.accountId !== accountId) return { success: false, error: 'Mensagem não encontrada' };
  const updated = await prisma.message.update({ where: { id: messageId }, data: { starred } });
  if (io) io.to(`lead:${msg.leadId}`).emit('message_starred', { id: messageId, starred });
  return { success: true, message: updated };
}

export async function markMessagesRead(leadId: string) {
  return prisma.message.updateMany({
    where: { leadId, read: false, direction: Direction.INBOUND },
    data: { read: true },
  });
}

/** Números (WhatsAppNumber.id) + o pseudo-valor "API" que o usuário logado
 *  pode enxergar na Inbox — null = sem restrição (ADMIN, ou ninguém marcou
 *  nada pra esse usuário ainda em Usuários; mesma filosofia de
 *  getScopeDepartmentIds). Busca sempre fresca no banco (nunca vem do JWT) —
 *  mesmo motivo do fix de papel/setor: mudar isso pra alguém já logado
 *  precisa valer rápido, não só depois de relogar. */
export async function getScopeNumberIds(accountId: string, userId: string, role: string): Promise<string[] | null> {
  if (role === 'ADMIN') return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { whatsAppNumberIds: true } });
  if (!user || user.whatsAppNumberIds.length === 0) return null;
  return user.whatsAppNumberIds;
}

export async function getConversations(accountId: string, scopeDepartmentIds: string[] = [], scopeNumberIds: string[] | null = null) {
  const leads = await prisma.lead.findMany({
    where: {
      accountId,
      messages: { some: {} },
      // Esconde Status/Stories (status@broadcast) — não são conversas de verdade.
      // Escrito como OR positivo (em vez de NOT+endsWith) de propósito: NOT sobre
      // um campo opcional (whatsappPhone) quando o valor é NULL vira NULL em SQL
      // de 3 valores (nem true nem false), e o Postgres EXCLUI a linha do WHERE —
      // isso sumia da lista qualquer lead cujo contato não tivesse whatsappPhone
      // preenchido (ex.: contato criado manualmente, só com telefone comum).
      OR: [
        { contactId: null },
        { contact: { whatsappPhone: null } },
        { contact: { NOT: { whatsappPhone: { endsWith: '@broadcast' } } } },
      ],
      // Mesmo critério do Funil: a conversa "pertence" ao setor do FUNIL do
      // lead (que casa com o setor do número de WhatsApp, quando veio de lá).
      ...(scopeDepartmentIds.length ? { pipeline: { OR: [{ departmentId: { in: scopeDepartmentIds } }, { departmentId: null }] } } : {}),
    },
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
  // Todo número de WhatsApp (ou API Oficial, quando whatsappNumberId é null)
  // que JÁ mandou/recebeu alguma mensagem de cada lead — não só o "último
  // usado" (lead.whatsappNumberId, que é sobrescrito toda vez que o cliente
  // fala por um número diferente, ver comentário em getOrCreateLeadForPhone).
  // Sem isso, a aba de um número "esquecia" o cliente assim que ele mandava
  // UMA mensagem por outro número — a conversa não sumia de verdade, só a
  // etiqueta de qual número mudava (bug real reportado: "as conversas do
  // 3606 sumiram"). GROUP BY em vez de trazer toda mensagem — só as
  // combinações distintas (leadId, whatsappNumberId). Sem filtrar
  // whatsappNumberId != null de propósito: uma linha com null identifica
  // "esse lead já falou pela API Oficial" — usado pro scopeNumberIds abaixo.
  const numberUsage = await prisma.message.groupBy({
    by: ['leadId', 'whatsappNumberId'],
    where: { lead: { accountId }, channel: 'WHATSAPP' },
  });
  const usedNumbersByLead = new Map<string, string[]>();
  const usedApiOficialLeads = new Set<string>();
  for (const row of numberUsage) {
    if (row.whatsappNumberId) {
      const list = usedNumbersByLead.get(row.leadId);
      if (list) list.push(row.whatsappNumberId);
      else usedNumbersByLead.set(row.leadId, [row.whatsappNumberId]);
    } else {
      usedApiOficialLeads.add(row.leadId);
    }
  }

  const withUsage = leads.map((lead) => ({ ...lead, usedNumberIds: usedNumbersByLead.get(lead.id) || [] }));

  // Restrição por número (Usuários → "Números de WhatsApp que ele enxerga"):
  // um lead que nunca usou WhatsApp (Instagram/Telegram/Webchat/e-mail) passa
  // direto — a restrição é só sobre canais de WhatsApp, não esconde o resto.
  const scoped = scopeNumberIds
    ? withUsage.filter((lead) => {
        const used = usedNumbersByLead.get(lead.id) || [];
        const usedApi = usedApiOficialLeads.has(lead.id);
        if (used.length === 0 && !usedApi) return true;
        return used.some((id) => scopeNumberIds.includes(id)) || (usedApi && scopeNumberIds.includes('API'));
      })
    : withUsage;

  // Ordena pela data da ÚLTIMA MENSAGEM (não pelo updatedAt do lead, que muda
  // quando se edita dados/estágio). Assim a conversa que recebeu/enviou msg mais
  // recente fica no topo.
  return scoped.sort((a, b) => {
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
