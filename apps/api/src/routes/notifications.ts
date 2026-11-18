import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { listUserNotifications, markUserNotificationsRead } from '../services/notification.service';

// Sineta de notificações (Fabio 18/11): os avisos do CRM que apareceram na tela por uns segundos — cada um vê só os seus.
const router = Router();
router.use(authMiddleware);

// GET /api/notifications?limit=&cursor=
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { limit, cursor } = req.query as Record<string, string | undefined>;
    res.json(await listUserNotifications(req.user!.id, { limit: limit ? parseInt(limit, 10) || undefined : undefined, cursor: cursor || undefined }));
  } catch {
    res.status(500).json({ error: 'Erro ao buscar as notificações' });
  }
});

// POST /api/notifications/read  { id? | leadId? | all? }
router.post('/read', async (req: AuthRequest, res: Response) => {
  try {
    const { id, leadId, all } = (req.body || {}) as { id?: string; leadId?: string; all?: boolean };
    res.json(await markUserNotificationsRead(req.user!.id, {
      id: typeof id === 'string' ? id : undefined,
      leadId: typeof leadId === 'string' ? leadId : undefined,
      all: all === true,
    }));
  } catch {
    res.status(500).json({ error: 'Erro ao marcar como lida' });
  }
});

export default router;
