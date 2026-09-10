import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { listActivity } from '../services/activity.service';

const router = Router();
router.use(authMiddleware);

// GET /api/activity?limit=&cursor=&leadId=&userId=&action=
// Feed do que a equipe fez (mexeu em card, respondeu cliente…). Qualquer
// colaborador logado vê o feed da conta — é uma ferramenta de transparência.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { limit, cursor, leadId, userId, action } = req.query as Record<string, string | undefined>;
    const result = await listActivity(req.user!.accountId, {
      limit: limit ? parseInt(limit, 10) || undefined : undefined,
      cursor: cursor || undefined,
      leadId: leadId || undefined,
      userId: userId || undefined,
      action: action || undefined,
    });
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar o registro de atividade' });
  }
});

export default router;
