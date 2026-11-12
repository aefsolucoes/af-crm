import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { requirePermission } from '../middleware/permission';
import { pedirSimulacaoCaixa, proximaSimulacaoCaixa, codigoSimulacao, gravarSimulacaoCaixa } from '../services/simulacao-caixa.service';

// Simulação no simulador da CAIXA (Fabio 12/11) — pedido do card + fila da extensão "SIOPI (A&F)" + código de verificação que chega no WhatsApp da API.
const router = Router();
router.use(authMiddleware);

router.get('/fila', async (req: AuthRequest, res: Response) => {
  try { res.json(await proximaSimulacaoCaixa(req.user!.accountId)); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro na fila da simulação CAIXA' }); }
});
// Código de verificação (a extensão pergunta com o horário em que clicou em avançar).
router.get('/codigo', async (req: AuthRequest, res: Response) => {
  const desde = new Date(String(req.query.desde || ''));
  if (Number.isNaN(desde.getTime())) return res.status(400).json({ error: 'desde inválido' });
  try { res.json(await codigoSimulacao(req.user!.accountId, desde)); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});
router.post('/:leadId/pedir', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try {
    const nome = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
    const r = await pedirSimulacaoCaixa(req.user!.accountId, req.params.leadId, { id: req.user!.id, nome });
    if ('erro' in r) return res.status(400).json({ error: r.erro });
    res.json({ ok: true, mensagem: r.mensagem });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});
router.post('/:leadId/report', async (req: AuthRequest, res: Response) => {
  if (!req.body?.etapa) return res.status(400).json({ error: 'etapa obrigatória' });
  try { await gravarSimulacaoCaixa(req.user!.accountId, req.params.leadId, req.body, req.app.get('io')); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

export default router;
