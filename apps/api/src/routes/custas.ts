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
    estimarCustasFh(req.user!.accountId, leadId, nome, { cidade: b.cidade, uf: b.uf, origemCidade: b.origemCidade, valorImovel: b.valorImovel, financiado: b.financiado, imovelNovo: b.imovelNovo === true, primeiraAquisicao: b.primeiraAquisicao === true, banco: typeof b.banco === 'string' ? b.banco : undefined })
      .then((out) => jobs.set(leadId, out.ok ? { status: 'PRONTO', em: Date.now(), mensagem: out.mensagem } : { status: 'ERRO', em: Date.now(), erro: out.erro }))
      .catch((e: any) => jobs.set(leadId, { status: 'ERRO', em: Date.now(), erro: e?.message || 'Erro ao calcular as custas' }));
    res.json({ status: 'RODANDO' });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao calcular as custas' }); }
});
// Valores do card pra janela de confirmação.
router.get('/fh/:leadId', async (req: AuthRequest, res: Response) => {
  try {
    const { dadosCustasFh } = require('../services/custas-fh.service') as typeof import('../services/custas-fh.service');
    const out = await dadosCustasFh(req.user!.accountId, req.params.leadId);
    if (!out.ok) return res.status(400).json({ error: out.erro });
    res.json(out.dados);
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});
// Cidades da UF pra lista da janela (Fabio 16/11: "a cidade e UF deve ter as opções"), pelo IBGE — guardadas em memória.
const municipiosCache = new Map<string, string[]>();
router.get('/municipios/:uf', async (req: AuthRequest, res: Response) => {
  const uf = String(req.params.uf || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(uf)) return res.status(400).json({ error: 'UF inválida' });
  try {
    let lista = municipiosCache.get(uf);
    if (!lista) {
      const r = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?orderBy=nome`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) throw new Error(`IBGE ${r.status}`);
      const dados = (await r.json()) as { nome: string }[];
      lista = (Array.isArray(dados) ? dados : []).map((m) => m.nome).filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt-BR'));
      if (lista.length) municipiosCache.set(uf, lista);
    }
    res.json(lista);
  } catch (e: any) { res.status(502).json({ error: e?.message || 'Não consegui carregar as cidades' }); }
});
router.get('/fh/:leadId/resultado', (req: AuthRequest, res: Response) => {
  const j = jobs.get(req.params.leadId);
  if (!j) return res.json({ status: 'NADA' });
  if (j.status !== 'RODANDO') jobs.delete(req.params.leadId); // entregue uma vez
  res.json(j);
});

export default router;
