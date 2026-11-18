import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { requirePermission } from '../middleware/permission';
import { pedirLaudoCaixa, proximoLaudoCaixa, gravarLaudoCaixa } from '../services/laudo-caixa.service';

// Laudo da vistoria da CAIXA no SIOPI (Fabio 18/11) — usado pela extensão "SIOPI (A&F)".
const router = Router();
router.use(authMiddleware);

router.get('/fila', async (req: AuthRequest, res: Response) => {
  try { res.json((await proximoLaudoCaixa(req.user!.accountId)) || null); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro na fila do laudo' }); }
});
router.get('/:leadId', async (req: AuthRequest, res: Response) => {
  const l = await prisma.lead.findFirst({ where: { id: req.params.leadId, accountId: req.user!.accountId }, select: { customFields: true } });
  if (!l) return res.status(404).json({ error: 'Lead não encontrado' });
  res.json(((l.customFields || {}) as any)._laudoCaixa || null);
});
router.post('/:leadId/pedir', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  const erro = await pedirLaudoCaixa(req.user!.accountId, req.params.leadId, quem).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});
router.post('/:leadId/report', async (req: AuthRequest, res: Response) => {
  try { await gravarLaudoCaixa(req.user!.accountId, req.params.leadId, req.body || {}); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

export default router;
