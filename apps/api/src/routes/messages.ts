import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { getMessages, createMessage, getConversations } from '../services/message.service';
import { sendWhatsAppMessage } from '../services/whatsapp.service';
import { sendBaileysMessage, getQRStatus } from '../services/baileys.service';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
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
    let externalId: string | undefined;
    let status: 'SENT' | 'FAILED' = 'SENT';

    // If sending OUTBOUND via WhatsApp, call the API
    if (req.body.direction === 'OUTBOUND' && req.body.channel === 'WHATSAPP') {
      const lead = await prisma.lead.findUnique({
        where: { id: req.body.leadId },
        include: { contact: true },
      });

      const phone = lead?.contact?.whatsappPhone || lead?.contact?.phone;
      console.log(`[Send] leadId=${req.body.leadId} phone=${phone} contact=${JSON.stringify(lead?.contact)}`);

      if (!phone) {
        return res.status(400).json({ error: 'Contato sem número de telefone cadastrado' });
      }

      // Try QR (Baileys) first, then fall back to Cloud API
      const qrStatus = getQRStatus(req.user!.accountId);
      if (qrStatus.status === 'connected') {
        const sent = await sendBaileysMessage(phone, req.body.content, req.user!.accountId);
        if (!sent) status = 'FAILED';
      } else {
        const result = await sendWhatsAppMessage(phone, req.body.content, req.user!.accountId);
        console.log(`[Send] WhatsApp result:`, result);
        if (result.success) {
          externalId = result.externalId;
        } else {
          console.warn('[WhatsApp] Mensagem não enviada:', result.error);
          // Return error to frontend so user sees what went wrong
          return res.status(400).json({ error: result.error || 'Falha ao enviar mensagem WhatsApp' });
        }
      }
    }

    const message = await createMessage({ ...req.body, externalId, status });

    const io = req.app.get('io');
    if (io) {
      io.to(`lead:${message.leadId}`).emit('new_message', message);
    }

    res.status(201).json(message);
  } catch {
    res.status(500).json({ error: 'Erro ao enviar mensagem' });
  }
});

export default router;
