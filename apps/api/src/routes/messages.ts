import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { loadPerms } from '../middleware/permission';
import { validate } from '../middleware/validate';
import { getMessages, createMessage, getConversations, sendOutboundWhatsApp, markConversationRead, getAttachment, sendOutboundMedia } from '../services/message.service';

const router = Router();
router.use(authMiddleware);

const messageSchema = z.object({
  content: z.string().min(1),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  channel: z.enum(['WHATSAPP', 'INSTAGRAM', 'TELEGRAM', 'WEBCHAT', 'EMAIL']),
  leadId: z.string(),
  via: z.enum(['qr', 'api']).optional(),
  fromNumberId: z.string().optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  const { leadId } = req.query;
  if (leadId) {
    try {
      const messages = await getMessages(leadId as string);
      res.json(messages);
    } catch {
      res.status(500).json({ error: 'Erro ao buscar mensagens' });
    }
  } else {
    try {
      const conversations = await getConversations(req.user!.accountId);
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
    if (!att.data) {
      // Já foi movido para o Drive (bytes limpos do banco)
      return res.status(410).json({ error: 'Arquivo movido para o Google Drive', driveFileId: att.driveFileId });
    }
    const isImage = att.mimeType.startsWith('image/');
    res.setHeader('Content-Type', att.mimeType);
    res.setHeader('Content-Disposition', `${isImage ? 'inline' : 'attachment'}; filename="${encodeURIComponent(att.fileName)}"`);
    res.send(Buffer.from(att.data as any));
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
        io,
      });
      if (!result.success) {
        return res.status(400).json({ error: result.error });
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
