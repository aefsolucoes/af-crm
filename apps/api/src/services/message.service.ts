import { PrismaClient, Direction, Channel } from '@prisma/client';
import { sendWhatsAppMessage, sendWhatsAppTemplateMessage } from './whatsapp.service';
import { sendBaileysMessage, sendBaileysMedia, isNumberConnected, getConnectedNumberIds } from './baileys.service';
import { downloadDriveFile } from './google.service';

const prisma = new PrismaClient();

/** Telefone "puro" (E.164, sem sufixo @lid/@s.whatsapp.net/@g.us) — a API
 *  Oficial da Meta exige isso e rejeita qualquer outra coisa com "Message
 *  Undeliverable" (código 131026). O Baileys (QR) é diferente: ele aceita —
 *  e às vezes PRECISA — do JID @lid direto (toWhatsAppJid trata isso de
 *  propósito), então essa função NÃO deve ser usada nos envios via QR. */
function plainPhone(contact?: { phone?: string | null; whatsappPhone?: string | null } | null): string | undefined {
  const wp = contact?.whatsappPhone?.trim();
  if (wp && !wp.includes('@')) return wp;
  const p = contact?.phone?.trim();
  return p && !p.includes('@') ? p : undefined;
}

/**
 * Mensagens de uma conversa. Confere que o lead é da conta e (se o usuário
 * for de um setor específico) do MESMO setor — senão devolve null, como se
 * a conversa não existisse pra quem está pedindo.
 */
export async function getMessages(leadId: string, accountId: string, scopeDepartmentId?: string | null) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: { pipeline: { select: { departmentId: true } } },
  });
  if (!lead) return null;
  if (scopeDepartmentId && lead.pipeline.departmentId && lead.pipeline.departmentId !== scopeDepartmentId) return null;

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

/** Números de WhatsApp conectados via QR (id + apelido + telefone) para a conta. */
export async function listConnectedWhatsAppNumbers(accountId: string) {
  const ids = getConnectedNumberIds(accountId);
  if (ids.length === 0) return [];
  const rows = await prisma.whatsAppNumber.findMany({ where: { accountId, id: { in: ids } } });
  return rows.map((n) => ({ id: n.id, label: n.label, phone: n.phone }));
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
  /** Canal preferido: 'qr' (conexão via QR Code) ou 'api' (API oficial da Meta).
   *  Sem valor: usa o canal por onde o cliente já falou com a gente (última
   *  mensagem recebida); sem histórico ainda, QR se conectado, senão API. */
  via?: 'qr' | 'api';
  /** Número (WhatsAppNumber.id) do qual enviar via QR. Se ausente, usa o número da conversa ou o primeiro conectado. */
  fromNumberId?: string;
  /** Usuário do CRM que está enviando (para carimbar "enviado por" na mensagem). */
  userId?: string;
  /** Resposta com citação (como no WhatsApp): id/remetente/conteúdo da mensagem
   *  original, "congelados" no momento do envio — não é uma relação de verdade. */
  replyToExternalId?: string;
  replyToFromMe?: boolean;
  replyToContent?: string;
  replyToSender?: string;
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
}): Promise<{ success: true; message: Awaited<ReturnType<typeof createMessage>> } | { success: false; error: string }> {
  const { accountId, leadId, content, via, fromNumberId, userId, replyToExternalId, replyToFromMe, replyToContent, replyToSender, io } = params;

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: { contact: true, pipeline: { select: { departmentId: true } } },
  });
  if (!lead) return { success: false, error: 'Lead não encontrado' };

  const phone = lead.contact?.whatsappPhone || lead.contact?.phone;
  if (!phone) return { success: false, error: 'Contato sem número de telefone cadastrado' };

  let externalId: string | undefined;
  let usedNumberId: string | null = null;

  const connectedNumbers = getConnectedNumberIds(accountId);

  // Quando ninguém escolheu o canal explicitamente (via/fromNumberId), decide
  // pelo canal "natural" da conversa — de onde o CLIENTE fala com a gente —
  // em vez de simplesmente preferir QR sempre que algum número estiver
  // conectado. Isso evita responder pelo número/canal errado (ex: lead que
  // chegou por um anúncio Clique-para-WhatsApp na API Oficial recebendo a
  // resposta pelo QR pessoal). Olha a última mensagem RECEBIDA (não as que já
  // enviamos — essas podem já estar "erradas" por causa desse mesmo bug em
  // envios anteriores): se veio com id "wamid" é API Oficial; se veio com um
  // whatsappNumberId é aquele número QR.
  let inferredVia: 'qr' | 'api' | null = null;
  let inferredNumberId: string | null = null;
  if (via === undefined && !fromNumberId) {
    const lastInbound = await prisma.message.findFirst({
      where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP' },
      orderBy: { createdAt: 'desc' },
    });
    if (lastInbound?.externalId?.startsWith('wamid')) inferredVia = 'api';
    else if (lastInbound?.whatsappNumberId) { inferredVia = 'qr'; inferredNumberId = lastInbound.whatsappNumberId; }
  }

  const useQR = via === 'qr' ? true
    : via === 'api' ? false
    : inferredVia === 'api' ? false
    : inferredVia === 'qr' ? true
    : (!!fromNumberId || connectedNumbers.length > 0);

  if (useQR) {
    // Se o colaborador escolheu um número específico (fromNumberId), envia por ele
    // — desde que esteja conectado. Senão, prefere o número por onde o cliente
    // JÁ falou com a gente (inferredNumberId), depois o último usado nesta
    // conversa (lead.whatsappNumberId), depois o primeiro conectado. Um cliente
    // pode falar pelos dois números sem duplicar o card — cada mensagem guarda o
    // SEU próprio número (para o "via {número}"), mas a conversa é uma só.
    let preferred: string | undefined;
    if (fromNumberId) {
      if (!connectedNumbers.includes(fromNumberId)) {
        return { success: false, error: 'O número de WhatsApp escolhido não está conectado. Verifique em Configurações → QR Code ou escolha outro.' };
      }
      preferred = fromNumberId;
    } else if (inferredNumberId && connectedNumbers.includes(inferredNumberId)) {
      preferred = inferredNumberId;
    } else if (lead.whatsappNumberId && isNumberConnected(lead.whatsappNumberId)) {
      preferred = lead.whatsappNumberId;
    } else {
      preferred = connectedNumbers[0];
    }

    if (!preferred) {
      return { success: false, error: 'Nenhum WhatsApp conectado via QR Code. Conecte em Configurações → QR Code ou envie pela API oficial.' };
    }
    usedNumberId = preferred;
    // Retorna o id da mensagem enviada; guardamos como externalId para
    // deduplicar o eco fromMe que o Baileys emite em messages.upsert.
    // Se o envio falhar, NÃO gravamos a mensagem nem reportamos sucesso —
    // senão o agente/inbox diria "enviada" para algo que não saiu.
    // Citação só faz sentido quando a mensagem original também veio/foi pelo
    // Baileys (id "wamid" é da API Oficial — o Baileys não sabe citar isso).
    const quoted =
      replyToExternalId && !replyToExternalId.startsWith('wamid')
        ? { externalId: replyToExternalId, fromMe: !!replyToFromMe }
        : undefined;
    const outcome = await sendBaileysMessage(phone, content, preferred, quoted);
    if ('failed' in outcome) {
      const error =
        outcome.failed === 'no_whatsapp'
          ? `O número ${formatPhoneDisplay(phone)} não tem WhatsApp (ou está em formato inválido). A mensagem NÃO foi enviada.`
          : outcome.failed === 'not_connected'
          ? 'O WhatsApp (QR Code) foi desconectado. Reconecte em Configurações → QR Code e tente novamente.'
          : 'Não foi possível enviar a mensagem pelo WhatsApp. Tente novamente.';
      return { success: false, error };
    }
    externalId = outcome.id;

    // Mantém o "número atual" da conversa acompanhando o último usado (é só a
    // sugestão padrão da tela — não impede responder por outro número depois).
    if (lead.whatsappNumberId !== preferred) {
      await prisma.lead.update({ where: { id: leadId }, data: { whatsappNumberId: preferred } }).catch(() => {});
    }
  } else {
    // API Oficial exige um número de verdade — o "phone" acima pode ser um
    // @lid (válido só pro QR/Baileys), então resolve de novo aqui.
    const cloudPhone = plainPhone(lead.contact);
    if (!cloudPhone) {
      return { success: false, error: 'Este contato só tem um identificador do WhatsApp (@lid), sem telefone de verdade cadastrado — a API Oficial não consegue enviar. Cadastre o telefone no card ou envie pelo QR Code.' };
    }
    const result = await sendWhatsAppMessage(cloudPhone, content, accountId, lead.pipeline.departmentId, replyToExternalId);
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
}): Promise<{ success: true; message: Awaited<ReturnType<typeof createMessage>> } | { success: false; error: string }> {
  const { accountId, leadId, templateName, language, bodyParams, previewText, userId, io } = params;

  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, include: { contact: true, pipeline: { select: { departmentId: true } } } });
  if (!lead) return { success: false, error: 'Lead não encontrado' };

  // Template só vai pela API Oficial — precisa de telefone de verdade, não @lid.
  const phone = plainPhone(lead.contact);
  if (!phone) return { success: false, error: 'Este contato só tem um identificador do WhatsApp (@lid), sem telefone de verdade cadastrado — a API Oficial não consegue enviar. Cadastre o telefone no card.' };

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

/** Envia um documento/imagem pelo WhatsApp (QR) e salva na conversa com o anexo. */
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
}): Promise<{ success: true; message: any } | { success: false; error: string }> {
  const { accountId, leadId, buffer, fileName, mimeType, caption, userId, io } = params;

  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, include: { contact: true } });
  if (!lead) return { success: false, error: 'Lead não encontrado' };
  const phone = lead.contact?.whatsappPhone || lead.contact?.phone;
  if (!phone) return { success: false, error: 'Contato sem número cadastrado' };

  const connectedNumbers = getConnectedNumberIds(accountId);
  const preferred = lead.whatsappNumberId && isNumberConnected(lead.whatsappNumberId)
    ? lead.whatsappNumberId
    : connectedNumbers[0];
  if (!preferred) return { success: false, error: 'Nenhum WhatsApp conectado via QR Code.' };

  const sentId = await sendBaileysMedia(phone, buffer, fileName, mimeType, caption || '', preferred);
  if (!sentId) return { success: false, error: 'Falha ao enviar o arquivo pelo WhatsApp.' };

  if (!lead.whatsappNumberId) {
    await prisma.lead.update({ where: { id: leadId }, data: { whatsappNumberId: preferred } }).catch(() => {});
  }

  const content = `📎 ${fileName}${caption ? ` — ${caption}` : ''}`;
  const message = await prisma.message.create({
    data: {
      content, direction: 'OUTBOUND', channel: 'WHATSAPP', leadId,
      whatsappNumberId: preferred, sentByUserId: userId ?? null, read: true, externalId: sentId, status: 'SENT',
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

  // Mídia fica no CRM (banco) — o upload pro Drive agora é só sob-demanda.

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

export async function markMessagesRead(leadId: string) {
  return prisma.message.updateMany({
    where: { leadId, read: false, direction: Direction.INBOUND },
    data: { read: true },
  });
}

export async function getConversations(accountId: string, scopeDepartmentId?: string | null) {
  const leads = await prisma.lead.findMany({
    where: {
      accountId,
      messages: { some: {} },
      // Esconde Status/Stories (status@broadcast) — não são conversas de verdade.
      NOT: { contact: { whatsappPhone: { endsWith: '@broadcast' } } },
      // Mesmo critério do Funil: a conversa "pertence" ao setor do FUNIL do
      // lead (que casa com o setor do número de WhatsApp, quando veio de lá).
      ...(scopeDepartmentId ? { pipeline: { OR: [{ departmentId: scopeDepartmentId }, { departmentId: null }] } } : {}),
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
