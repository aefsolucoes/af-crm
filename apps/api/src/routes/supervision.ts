import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { listSupervision, actOnSupervision, buildWeeklySupervision } from '../services/supervision.service';

/** Supervisão de sexta — ver supervision.service.ts. Só administrador. */
const router = Router();
router.use(authMiddleware);
router.use((req: AuthRequest, res: Response, next) => (req.user?.role === 'ADMIN' ? next() : res.status(403).json({ error: 'Só administrador' })));

const fail = (res: Response, err: any, fallback: string, code = 400) => res.status(code).json({ error: err?.message || fallback });

router.get('/', async (req: AuthRequest, res: Response) => {
  try { res.json(await listSupervision(req.user!.accountId, typeof req.query.week === 'string' ? req.query.week : undefined)); } catch (err) { fail(res, err, 'Erro ao carregar', 500); }
});
// Gera a lista desta semana agora (sem esperar a sexta) — completa só os cards que ainda não têm item.
router.post('/generate', async (req: AuthRequest, res: Response) => {
  try { res.json(await buildWeeklySupervision(req.user!.accountId, { force: true, notify: false })); } catch (err) { fail(res, err, 'Erro ao gerar', 500); }
});
router.post('/:id/:acao', async (req: AuthRequest, res: Response) => {
  const mapa: Record<string, 'SEND' | 'SKIP' | 'DONE' | 'REOPEN'> = { send: 'SEND', skip: 'SKIP', done: 'DONE', reopen: 'REOPEN' };
  const acao = mapa[req.params.acao];
  if (!acao) return res.status(404).json({ error: 'Ação inválida' });
  try { res.json(await actOnSupervision(req.user!.accountId, req.user!.id, req.params.id, acao, req.body?.text, (req as any).app.get('io'))); } catch (err) { fail(res, err, 'Erro'); }
});

export default router;
