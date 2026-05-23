import { Router, Request, Response } from 'express';

const router = Router();

// WhatsApp Cloud API webhook
router.get('/whatsapp', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

router.post('/whatsapp', (req: Request, res: Response) => {
  // TODO: parse and persist incoming WhatsApp messages
  console.log('[WhatsApp webhook]', JSON.stringify(req.body, null, 2));
  res.status(200).end();
});

// Instagram Graph API webhook
router.get('/instagram', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

router.post('/instagram', (req: Request, res: Response) => {
  // TODO: parse and persist incoming Instagram messages
  console.log('[Instagram webhook]', JSON.stringify(req.body, null, 2));
  res.status(200).end();
});

// Telegram Bot webhook
router.post('/telegram', (req: Request, res: Response) => {
  // TODO: parse and persist incoming Telegram messages
  console.log('[Telegram webhook]', JSON.stringify(req.body, null, 2));
  res.status(200).end();
});

export default router;
