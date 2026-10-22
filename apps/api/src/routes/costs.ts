import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { costsOverview, createEntry, updateEntry, deleteEntry, setRate, currentMonth, validMonth } from '../services/costs.service';

/** Painel de custos — só administrador (Fabio 22/10). */
const router = Router();
router.use(authMiddleware);
router.use((req: AuthRequest, res: Response, next) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só administradores veem os custos' });
  next();
});

const fail = (res: Response, err: any, fallback: string, status = 500) => {
  console.error('[Custos]', err?.message);
  res.status(status).json({ error: status === 400 ? String(err?.message || fallback) : fallback });
};

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const month = validMonth(req.query.month) ? String(req.query.month) : currentMonth();
    res.json(await costsOverview(req.user!.accountId, month, Number(req.query.months) || 6));
  } catch (err) { fail(res, err, 'Erro ao calcular os custos'); }
});

router.post('/entries', async (req: AuthRequest, res: Response) => {
  try { res.status(201).json(await createEntry(req.user!.accountId, req.user!.id, req.body || {})); } catch (err) { fail(res, err, 'Erro ao salvar o lançamento', 400); }
});
router.put('/entries/:id', async (req: AuthRequest, res: Response) => {
  try { res.json(await updateEntry(req.user!.accountId, String(req.params.id), req.body || {})); } catch (err) { fail(res, err, 'Erro ao salvar o lançamento', 400); }
});
router.delete('/entries/:id', async (req: AuthRequest, res: Response) => {
  try { await deleteEntry(req.user!.accountId, String(req.params.id)); res.json({ ok: true }); } catch (err) { fail(res, err, 'Erro ao apagar o lançamento', 400); }
});

// Cotação do dólar: número = fixa; null = automática (cotação do dia).
router.put('/settings', async (req: AuthRequest, res: Response) => {
  try {
    const v = req.body?.usdBrl;
    await setRate(req.user!.accountId, v === null || v === '' || v === undefined ? null : Number(v));
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Erro ao salvar a cotação', 400); }
});

export default router;
