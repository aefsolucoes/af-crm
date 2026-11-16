import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

// Botão "Custas" da conversa (Fabio 16/11): estimativa de ITBI + registro do Financiamento Habitacional, com a mensagem pronta pro campo de texto (a equipe revisa e envia).
// A pesquisa leva 1–2 min (passa do tempo do proxy): o POST começa e devolve na hora; a tela consulta GET /fh/:leadId/resultado.
const jobs = new Map<string, { status: 'RODANDO' | 'PRONTO' | 'ERRO'; em: number; mensagem?: string; erro?: string }>();
router.post('/fh/:leadId', async (req: AuthRequest, res: Response) => {
  try {
    const leadId = req.params.leadId;
    const atual = jobs.get(leadId);
    if (atual?.status === 'RODANDO' && Date.now() - atual.em < 4 * 60_000) return res.json({ status: 'RODANDO' });
    const nome = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || undefined;
    const b = req.body || {};
    const { estimarCustasFh } = require('../services/custas-fh.service') as typeof import('../services/custas-fh.service');
    jobs.set(leadId, { status: 'RODANDO', em: Date.now() });
    estimarCustasFh(req.user!.accountId, leadId, nome, { cidade: b.cidade, uf: b.uf, origemCidade: b.origemCidade, valorImovel: b.valorImovel, financiado: b.financiado, imovelNovo: b.imovelNovo === true, primeiraAquisicao: b.primeiraAquisicao === true })
      .then((out) => jobs.set(leadId, out.ok ? { status: 'PRONTO', em: Date.now(), mensagem: out.mensagem } : { status: 'ERRO', em: Date.now(), erro: out.erro }))
      .catch((e: any) => jobs.set(leadId, { status: 'ERRO', em: Date.now(), erro: e?.message || 'Erro ao calcular as custas' }));
    res.json({ status: 'RODANDO' });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao calcular as custas' }); }
});
router.get('/fh/:leadId/resultado', (req: AuthRequest, res: Response) => {
  const j = jobs.get(req.params.leadId);
  if (!j) return res.json({ status: 'NADA' });
  if (j.status !== 'RODANDO') jobs.delete(req.params.leadId); // entregue uma vez
  res.json(j);
});

export default router;
