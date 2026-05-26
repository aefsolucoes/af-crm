import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { processIncomingWhatsApp } from '../services/whatsapp.service';

const router = Router();
const prisma = new PrismaClient();

// WhatsApp Cloud API webhook — verification
router.get('/whatsapp', async (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Find account config that matches this verify token
  const config = await prisma.whatsAppConfig.findFirst({
    where: { verifyToken: token as string },
  });

  if (mode === 'subscribe' && config) {
    console.log('[WhatsApp] Webhook verificado!');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

// WhatsApp Cloud API webhook — receive messages
router.post('/whatsapp', async (req: Request, res: Response) => {
  // Always respond 200 immediately (Meta requires it)
  res.status(200).end();

  try {
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account') return;

    // Find which account this phone belongs to
    const phoneNumberId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    const config = await prisma.whatsAppConfig.findFirst({
      where: { phoneNumberId },
    });

    if (!config) {
      console.warn('[WhatsApp] Nenhuma conta encontrada para phoneNumberId:', phoneNumberId);
      return;
    }

    const io = (req as any).app.get('io');
    await processIncomingWhatsApp(body, config.accountId, io);
  } catch (err) {
    console.error('[WhatsApp] Webhook POST error:', err);
  }
});

// Instagram Graph API webhook
router.get('/instagram', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

router.post('/instagram', (req: Request, res: Response) => {
  console.log('[Instagram webhook]', JSON.stringify(req.body, null, 2));
  res.status(200).end();
});

// Telegram Bot webhook
router.post('/telegram', (req: Request, res: Response) => {
  console.log('[Telegram webhook]', JSON.stringify(req.body, null, 2));
  res.status(200).end();
});

export default router;
