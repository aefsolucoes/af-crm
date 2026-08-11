import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { processIncomingWhatsApp, processWhatsAppStatus } from '../services/whatsapp.service';

const router = Router();
const prisma = new PrismaClient();

// ─── Meta Lead Ads ────────────────────────────────────────────────────────────
// Canal desativado a pedido do usuário (2026-08-10) — a tela de configuração
// foi removida e este webhook agora é um "no-op" (responde 200/403 sem
// processar nada), como trava extra além da config já estar inativa no banco.

// GET /api/webhooks/meta-leads — Verificação do webhook pela Meta (desativado)
router.get('/meta-leads', async (_req: Request, res: Response) => {
  res.status(403).end();
});

// POST /api/webhooks/meta-leads — Recebe novo lead de formulário (desativado)
router.post('/meta-leads', async (_req: Request, res: Response) => {
  // Meta exige resposta 200 imediata; canal desativado, então não processa nada.
  // Lógica original (criar contato/lead a partir do formulário) preservada no
  // histórico do git — buscar o commit anterior a esta mudança se precisar
  // reativar um dia.
  res.status(200).end();
});

// WhatsApp Cloud API webhook — verification
router.get('/whatsapp', async (req: Request, res: Response) => {
  const mode      = req.query['hub.mode']         as string | undefined;
  const token     = req.query['hub.verify_token'] as string | undefined;
  const challenge = req.query['hub.challenge']    as string | undefined;

  console.log(`[WhatsApp] Webhook verify — mode=${mode} token=${token} challenge=${challenge}`);

  if (mode !== 'subscribe' || !token || !challenge) {
    console.warn('[WhatsApp] Verificação inválida: parâmetros ausentes');
    return res.status(403).end();
  }

  // 1) Fallback: check against env var (works even before DB is set up)
  const envToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (envToken && token === envToken) {
    console.log('[WhatsApp] Webhook verificado via env var!');
    return res.status(200).send(challenge);
  }

  // 2) DB lookup — find any account config that has this verify token
  try {
    const config = await prisma.whatsAppConfig.findFirst({
      where: { verifyToken: token },
    });

    if (config) {
      console.log(`[WhatsApp] Webhook verificado via DB! accountId=${config.accountId}`);
      return res.status(200).send(challenge);
    }
  } catch (err) {
    console.error('[WhatsApp] Erro ao buscar config no DB:', err);
  }

  console.warn(`[WhatsApp] Token não encontrado: "${token}"`);
  return res.status(403).end();
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

    // Processa status updates (delivered/read) — não precisa de config de conta
    await processWhatsAppStatus(body, io);

    // Processa mensagens recebidas
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
