import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { getWhatsAppConfig, saveWhatsAppConfig } from '../services/whatsapp.service';

const router = Router();
router.use(authMiddleware);

const whatsappSchema = z.object({
  phoneNumberId: z.string().min(1),
  accessToken: z.string().min(1),
  verifyToken: z.string().min(6),
  active: z.boolean(),
});

// GET /api/settings/whatsapp
router.get('/whatsapp', async (req: AuthRequest, res: Response) => {
  try {
    const config = await getWhatsAppConfig(req.user!.accountId);
    if (!config) return res.json(null);

    // Mask token for security
    res.json({
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken.slice(0, 8) + '••••••••••••••••',
      verifyToken: config.verifyToken,
      active: config.active,
      webhookUrl: `${process.env.PUBLIC_API_URL || 'https://af-crm-production.up.railway.app'}/api/webhooks/whatsapp`,
    });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar configurações' });
  }
});

// POST /api/settings/whatsapp
router.post('/whatsapp', validate(whatsappSchema), async (req: AuthRequest, res: Response) => {
  try {
    const config = await saveWhatsAppConfig(req.user!.accountId, req.body);
    res.json({ success: true, active: config.active });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar configurações' });
  }
});

export default router;
