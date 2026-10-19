import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { automationMetrics } from '../services/automation-metrics.service';
import { getAiCostSettings, setAiCostSettings } from '../services/ai-cost-setting.service';

/** Painel "Medição da automação" — só administrador. Só leitura. */
const router = Router();
router.use(authMiddleware);

router.get('/', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só administradores veem a medição da automação' });
  try { res.json(await automationMetrics(req.user!.accountId, Number(req.query.days) || 14)); }
  catch (err: any) { console.error('[Medição]', err?.message); res.status(500).json({ error: 'Erro ao calcular a medição' }); }
});

// Chaves de economia da IA (Base enxuta / sugestão no Haiku): ligar e desligar vale na hora.
router.put('/ai-cost', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só administradores mexem nas chaves de economia da IA' });
  try {
    const patch: { kbLean?: boolean; suggestHaiku?: boolean } = {};
    if (typeof req.body?.kbLean === 'boolean') patch.kbLean = req.body.kbLean;
    if (typeof req.body?.suggestHaiku === 'boolean') patch.suggestHaiku = req.body.suggestHaiku;
    res.json(await setAiCostSettings(req.user!.accountId, patch, req.user!.id));
  } catch (err: any) { console.error('[Medição] chaves de economia:', err?.message); res.status(500).json({ error: 'Erro ao salvar a chave' }); }
});

router.get('/ai-cost', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só administradores' });
  res.json(await getAiCostSettings(req.user!.accountId));
});

export default router;
