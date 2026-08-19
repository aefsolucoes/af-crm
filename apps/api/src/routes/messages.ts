import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { loadPerms } from '../middleware/permission';
import { validate } from '../middleware/validate';
import { getMessages, createMessage, getConversations, sendOutboundWhatsApp, sendOutboundWhatsAppTemplate, markConversationRead, getAttachment, sendOutboundMedia, forwardMessage, findOrCreateLeadByPhone } from '../services/message.service';
import { downloadDriveFile } from '../services/google.service';
import { getScopeDepartmentId } from '../services/department.service';

const router = Router();
router.use(authMiddleware);

const messageSchema = z.object({
  content: z.string().min(1),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  channel: z.enum(['WHATSAPP', 'INSTAGRAM', 'TELEGRAM', 'WEBCHAT', 'EMAIL']),
  leadId: z.string(),
  via: z.enum(['qr', 'api']).optional(),
  fromNumberId: z.string().optional(),
  // Resposta com citação (como no WhatsApp) — id/remetente/conteúdo da
  // mensagem original, escolhida pelo usuário na Inbox.
  replyToExternalId: z.string().optional(),
  replyToFromMe: z.boolean().optional(),
  replyToContent: z.string().optional(),
  replyToSender: z.string().optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  const { leadId } = req.query;
  const scopeDepartmentId = await getScopeDepartmentId(req.user!.accountId, req.user!.id, req.user!.role);
  if (leadId) {
    try {
      const messages = await getMessages(leadId as string, req.user!.accountId, scopeDepartmentId);
      if (messages === null) { res.status(404).json({ error: 'Conversa não encontrada' }); return; }
      res.json(messages);
    } catch {
      res.status(500).json({ error: 'Erro ao buscar mensagens' });
    }
  } else {
    try {
      const conversations = await getConversations(req.user!.accountId, scopeDepartmentId);
      res.json(conversations);
    } catch {
      res.status(500).json({ error: 'Erro ao buscar conversas' });
    }
  }
});

// Serve os bytes de um anexo (imagem/documento) recebido no WhatsApp
router.get('/attachment/:id', async (req: AuthRequest, res: Response) => {
  try {
    const att = await getAttachment(req.params.id, req.user!.accountId);
    if (!att) return res.status(404).json({ error: 'Anexo não encontrado' });
    const isImage = att.mimeType.startsWith('image/');

    // Bytes ainda no banco → serve direto.
    if (att.data) {
      res.setHeader('Content-Type', att.mimeType);
      res.setHeader('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${encodeURIComponent(att.fileName)}"`);
      return res.send(Buffer.from(att.data as any));
    }

    // Já arquivado no Drive → busca de volta e serve (miniatura inline / download).
    if (att.driveFileId) {
      try {
        const buf = await downloadDriveFile(req.user!.accountId, att.driveFileId, att.mimeType);
        res.setHeader('Content-Type', att.mimeType);
        res.setHeader('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${encodeURIComponent(att.fileName)}"`);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        return res.send(buf);
      } catch (err) {
        console.error('[Attachment] Falha ao baixar do Drive:', (err as any)?.message);
        return res.status(410).json({ error: 'Arquivo no Google Drive', driveFileId: att.driveFileId });
      }
    }

    return res.status(410).json({ error: 'Arquivo indisponível', driveFileId: att.driveFileId });
  } catch {
    res.status(500).json({ error: 'Erro ao carregar anexo' });
  }
});

// Envia um documento/imagem pelo WhatsApp (base64). Limite de corpo elevado só aqui.
router.post('/send-media', async (req: AuthRequest, res: Response) => {
  const { leadId, fileName, mimeType, dataBase64, caption } = req.body as {
    leadId?: string; fileName?: string; mimeType?: string; dataBase64?: string; caption?: string;
  };
  if (!leadId || !fileName || !mimeType || !dataBase64) {
    return res.status(400).json({ error: 'leadId, fileName, mimeType e dataBase64 são obrigatórios' });
  }
  try {
    const perms = await loadPerms(req);
    if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para enviar mensagens.' });
    const buffer = Buffer.from(dataBase64, 'base64');
    if (buffer.length > 25 * 1024 * 1024) {
      return res.status(413).json({ error: 'Arquivo muito grande (máx. 25 MB)' });
    }
    const io = req.app.get('io');
    const result = await sendOutboundMedia({
      accountId: req.user!.accountId, leadId, buffer, fileName, mimeType, caption, userId: req.user!.id, io,
    });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.status(201).json(result.message);
  } catch {
    res.status(500).json({ error: 'Erro ao enviar o arquivo' });
  }
});

// Envia um template aprovado pela Meta (API oficial) — único jeito de reabrir
// conversa fora da janela de 24h de atendimento gratuito.
router.post('/send-template', async (req: AuthRequest, res: Response) => {
  const { leadId, templateName, language, bodyParams, previewText } = req.body as {
    leadId?: string; templateName?: string; language?: string; bodyParams?: string[]; previewText?: string;
  };
  if (!leadId || !templateName || !previewText) {
    return res.status(400).json({ error: 'leadId, templateName e previewText são obrigatórios' });
  }
  try {
    const perms = await loadPerms(req);
    if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para enviar mensagens.' });
    const io = req.app.get('io');
    const result = await sendOutboundWhatsAppTemplate({
      accountId: req.user!.accountId, leadId, templateName, language: language || 'pt_BR',
      bodyParams: Array.isArray(bodyParams) ? bodyParams.map(String) : [], previewText, userId: req.user!.id, io,
    });
    if (!result.success) return res.status(400).json({ error: result.error, code: (result as any).code });
    res.status(201).json(result.message);
  } catch {
    res.status(500).json({ error: 'Erro ao enviar o template' });
  }
});

// Encaminha uma mensagem (texto ou anexo) para outra conversa/lead — reenvia
// de verdade pelo WhatsApp da conversa de destino.
router.post('/:id/forward', async (req: AuthRequest, res: Response) => {
  const { toLeadId } = req.body as { toLeadId?: string };
  if (!toLeadId) return res.status(400).json({ error: 'toLeadId é obrigatório' });
  try {
    const perms = await loadPerms(req);
    if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para enviar mensagens.' });
    const io = req.app.get('io');
    const result = await forwardMessage({
      accountId: req.user!.accountId, messageId: req.params.id, toLeadId, userId: req.user!.id, io,
    });
    if (!result.success) return res.status(400).json({ error: result.error });
    res.status(201).json(result.message);
  } catch {
    res.status(500).json({ error: 'Erro ao encaminhar a mensagem' });
  }
});

// Resolve um contato compartilhado no WhatsApp (nome + telefone extraídos do
// cartão) pro botão "Conversar"/"Criar lead" na mensagem — acha o lead se já
// existir (pelo telefone) ou cria um novo, sem precisar digitar nada.
router.post('/contact-card/resolve', async (req: AuthRequest, res: Response) => {
  const { name, phone } = req.body as { name?: string; phone?: string };
  if (!phone?.trim()) return res.status(400).json({ error: 'phone é obrigatório' });
  try {
    const perms = await loadPerms(req);
    if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para criar leads pela Inbox.' });
    const result = await findOrCreateLeadByPhone(req.user!.accountId, phone, name);
    if (!result) return res.status(400).json({ error: 'Não foi possível criar o lead (funil/usuário não configurado)' });
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Erro ao resolver o contato' });
  }
});

// Marca as mensagens recebidas de um lead como lidas (some o contador de não lidas)
router.post('/read', async (req: AuthRequest, res: Response) => {
  const leadId = (req.body?.leadId || req.query.leadId) as string | undefined;
  if (!leadId) return res.status(400).json({ error: 'leadId é obrigatório' });
  try {
    const result = await markConversationRead(leadId, req.user!.accountId);
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Erro ao marcar como lida' });
  }
});

router.post('/', validate(messageSchema), async (req: AuthRequest, res: Response) => {
  try {
    // Enviar mensagem exige permissão "responder no Inbox".
    if (req.body.direction === 'OUTBOUND') {
      const perms = await loadPerms(req);
      if (!perms.inbox_reply) return res.status(403).json({ error: 'Você não tem permissão para enviar mensagens.' });
    }
    // If sending OUTBOUND via WhatsApp, use the shared send helper
    if (req.body.direction === 'OUTBOUND' && req.body.channel === 'WHATSAPP') {
      const io = req.app.get('io');
      const result = await sendOutboundWhatsApp({
        accountId: req.user!.accountId,
        leadId: req.body.leadId,
        content: req.body.content,
        via: req.body.via,
        fromNumberId: req.body.fromNumberId,
        userId: req.user!.id,
        replyToExternalId: req.body.replyToExternalId,
        replyToFromMe: req.body.replyToFromMe,
        replyToContent: req.body.replyToContent,
        replyToSender: req.body.replyToSender,
        io,
      });
      if (!result.success) {
        return res.status(400).json({ error: result.error, code: (result as any).code });
      }
      return res.status(201).json(result.message);
    }

    const message = await createMessage(req.body);

    const io = req.app.get('io');
    if (io) {
      io.to(`lead:${message.leadId}`).emit('new_message', message);
      io.to(`account_${req.user!.accountId}`).emit('new_notification', { leadId: message.leadId, message });
    }

    res.status(201).json(message);
  } catch {
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
});

export default router;
