import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { listSupervision, actOnSupervision, buildWeeklySupervision, chatOnSupervision, supervisionTts } from '../services/supervision.service';

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
  try { res.json(await buildWeeklySupervision(req.user!.accountId, { force: true, notify: false, refazerComEmail: req.body?.refazerComEmail === true })); } catch (err) { fail(res, err, 'Erro ao gerar', 500); }
});
// Voz natural (ElevenLabs) — devolve mp3; sem crédito = 503 (a tela usa a voz do navegador).
router.post('/tts', async (req: AuthRequest, res: Response) => {
  try { const audio = await supervisionTts(String(req.body?.text || '')); res.setHeader('Content-Type', 'audio/mpeg'); res.send(audio); }
  catch (err: any) { res.status(err?.status || 500).json({ error: err?.message || 'Erro na voz' }); }
});
// Conversa por voz sobre o card (a fala vira texto no navegador). Não envia nada ao cliente.
router.post('/:id/chat', async (req: AuthRequest, res: Response) => {
  const b = req.body || {};
  try { res.json(await chatOnSupervision(req.user!.accountId, req.params.id, Array.isArray(b.history) ? b.history : [], String(b.fala || ''), String(b.rascunho || ''))); } catch (err) { fail(res, err, 'Erro na conversa'); }
});
router.post('/:id/:acao', async (req: AuthRequest, res: Response) => {
  const mapa: Record<string, 'SEND' | 'TEMPLATE' | 'SKIP' | 'DONE' | 'REOPEN'> = { send: 'SEND', template: 'TEMPLATE', skip: 'SKIP', done: 'DONE', reopen: 'REOPEN' };
  const acao = mapa[req.params.acao];
  if (!acao) return res.status(404).json({ error: 'Ação inválida' });
  try { res.json(await actOnSupervision(req.user!.accountId, req.user!.id, req.params.id, acao, req.body?.text, (req as any).app.get('io'))); } catch (err) { fail(res, err, 'Erro'); }
});

export default router;
