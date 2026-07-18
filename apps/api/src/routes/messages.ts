import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { getMessages, createMessage, getConversations, sendOutboundWhatsApp } from '../services/message.service';

const router = Router();
router.use(authMiddleware);

const messageSchema = z.object({
  content: z.string().min(1),
  direction: z.enum(['INBOUND', 'OUTBOUND']),
  channel: z.enum(['WHATSAPP', 'INSTAGRAM', 'TELEGRAM', 'WEBCHAT', 'EMAIL']),
  leadId: z.string(),
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

router.post('/', validate(messageSchema), async (req: AuthRequest, res: Response) => {
  try {
    // If sending OUTBOUND via WhatsApp, use the shared send helper
    if (req.body.direction === 'OUTBOUND' && req.body.channel === 'WHATSAPP') {
      const io = req.app.get('io');
      const result = await sendOutboundWhatsApp({
        accountId: req.user!.accountId,
        leadId: req.body.leadId,
        content: req.body.content,
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
