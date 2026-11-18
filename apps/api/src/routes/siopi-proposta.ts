import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { requirePermission } from '../middleware/permission';
import { pedirPropostaSiopi, proximaPropostaSiopi, reportPropostaSiopi, pedirComplementarSiopi } from '../services/siopi-proposta.service';

// Proposta da contratação da CAIXA no SIOPI (Fabio 16/11 e 18/11) — usada pela extensão "SIOPI (A&F)".
const router = Router();
router.use(authMiddleware);

router.get('/fila', async (req: AuthRequest, res: Response) => {
  try { res.json((await proximaPropostaSiopi(req.user!.accountId)) || null); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro na fila da proposta' }); }
});

router.get('/:leadId', async (req: AuthRequest, res: Response) => {
  const l = await prisma.lead.findFirst({ where: { id: req.params.leadId, accountId: req.user!.accountId }, select: { customFields: true } });
  if (!l) return res.status(404).json({ error: 'Lead não encontrado' });
  res.json(((l.customFields || {}) as any)._siopiProposta || null);
});

router.post('/:leadId/pedir', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  const erro = await pedirPropostaSiopi(req.user!.accountId, req.params.leadId, quem, req.user!.id).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});

router.post('/:leadId/complementar', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  const b = req.body || {};
  const erro = await pedirComplementarSiopi(req.user!.accountId, req.params.leadId, quem, { primeiraAquisicao: b.primeiraAquisicao === 'S' || b.primeiraAquisicao === 'N' ? b.primeiraAquisicao : undefined, agendamento: b.agendamento, financiamento: Number(b.financiamento) || undefined, compraVenda: Number(b.compraVenda) || undefined, salvar: b.salvar === true, natoDigital: b.natoDigital === 'S' || b.natoDigital === 'N' ? b.natoDigital : undefined, situacoes: Array.isArray(b.situacoes) ? b.situacoes : undefined, agencia: b.agencia ? String(b.agencia) : undefined }).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});

router.post('/:leadId/report', async (req: AuthRequest, res: Response) => {
  try { await reportPropostaSiopi(req.user!.accountId, req.params.leadId, req.body || {}); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

export default router;
