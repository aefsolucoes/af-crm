import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { automationMetrics } from '../services/automation-metrics.service';

/** Painel "Medição da automação" — só administrador. Só leitura. */
const router = Router();
router.use(authMiddleware);

router.get('/', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só administradores veem a medição da automação' });
  try { res.json(await automationMetrics(req.user!.accountId, Number(req.query.days) || 14)); }
  catch (err: any) { console.error('[Medição]', err?.message); res.status(500).json({ error: 'Erro ao calcular a medição' }); }
});

export default router;
