import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

// GET /api/push/vapid-public-key — chave pública (não é segredo, mas fica
// atrás do authMiddleware por consistência com o resto da API).
router.get('/vapid-public-key', (_req: AuthRequest, res: Response) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) return res.json({ publicKey: null });
  res.json({ publicKey });
});

const subscribeSchema = z.object({
  endpoint: z.string().min(1),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().optional(),
});

// POST /api/push/subscribe — upsert por endpoint (1 subscription por
// instalação do PWA; um usuário pode ter várias, uma por aparelho).
router.post('/subscribe', validate(subscribeSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { endpoint, keys, userAgent } = req.body as z.infer<typeof subscribeSchema>;
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: { endpoint, p256dh: keys.p256dh, auth: keys.auth, userAgent, userId: req.user!.id },
      update: { p256dh: keys.p256dh, auth: keys.auth, userAgent, userId: req.user!.id },
    });
    res.status(201).json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar inscrição de push' });
  }
});

const unsubscribeSchema = z.object({
  endpoint: z.string().min(1),
});

// DELETE /api/push/subscribe — usuário desativou push (ou trocou de dispositivo).
router.delete('/subscribe', validate(unsubscribeSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { endpoint } = req.body as z.infer<typeof unsubscribeSchema>;
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: req.user!.id } });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Erro ao remover inscrição de push' });
  }
});

export default router;
