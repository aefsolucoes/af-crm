import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { requirePermission } from '../middleware/permission';
import { solicitarVistoriaCaixa, enviarOsVistoriaCaixa, estadoVistoriaCaixa, proximaVistoriaCaixa, gravarVistoriaCaixa, certidaoDaVistoria, boletoAberto, gravarBoletoVistoria } from '../services/vistoria-caixa.service';

// Vistoria da CAIXA pelo SIOPI (Fabio 06/11) — botões do bloco CAIXA do card + fila da extensão "SIOPI (A&F)".
const router = Router();
router.use(authMiddleware);

const quem = async (req: AuthRequest) => ({ id: req.user!.id, nome: (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe' });

// Extensão: próximo card (cadastrar imóvel + preparar a OS, ou criar a OS já conferida).
router.get('/fila', async (req: AuthRequest, res: Response) => {
  try { res.json(await proximaVistoriaCaixa(req.user!.accountId)); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro na fila da vistoria CAIXA' }); }
});
// Histórico da extensão nos logs do servidor (diagnóstico remoto) — CPF mascarado.
router.post('/log', async (req: AuthRequest, res: Response) => {
  console.log('[SIOPI ext]', String(req.body?.texto || '').replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, '***.***.***-**').slice(0, 500));
  res.json({ ok: true });
});

// Extensão: abriu uma aba de boleto do SIOPI (mantemTaxaCobrancaBancaria.do?method=exibirGerarBoleto&nuSqnclTituloCobranca=N) → liga ao card que espera a taxa.
router.post('/boleto-aberto', async (req: AuthRequest, res: Response) => {
  try {
    const r = await boletoAberto(req.user!.accountId, String(req.body?.titulo || ''), req.body?.leadId || null);
    if ('erro' in r) return res.status(409).json({ error: r.erro });
    res.json({ ok: true, leadId: r.leadId });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});
// Extensão: o PDF do boleto (baixado dentro do SIOPI) → Drive + WhatsApp do cliente.
router.post('/:leadId/boleto', async (req: AuthRequest, res: Response) => {
  try {
    const r = await gravarBoletoVistoria(req.user!.accountId, req.params.leadId, req.body || {}, req.app.get('io'));
    if ('erro' in r) return res.status(400).json({ error: r.erro });
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});
// Extensão: a certidão de ônus do imóvel pra anexar na OS ("Incluir Documentos").
router.get('/:leadId/certidao', async (req: AuthRequest, res: Response) => {
  try {
    const c = await certidaoDaVistoria(req.user!.accountId, req.params.leadId);
    if (!c) return res.status(404).json({ error: 'Certidão do imóvel não encontrada na pasta IMOVEL' });
    res.json(c);
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao baixar a certidão' }); }
});
router.get('/:leadId', async (req: AuthRequest, res: Response) => {
  try {
    const e = await estadoVistoriaCaixa(req.user!.accountId, req.params.leadId);
    if (!e) return res.status(404).json({ error: 'Lead não encontrado' });
    res.json(e);
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});
router.post('/:leadId/solicitar', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try {
    const r = await solicitarVistoriaCaixa(req.user!.accountId, req.params.leadId, await quem(req), req.app.get('io'), { novoImovel: req.body?.novoImovel === true });
    if ('erro' in r) return res.status(400).json({ error: r.erro });
    res.json({ ok: true, mensagem: r.mensagem });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao pedir a vistoria' }); }
});
// O clique é a ordem de CRIAR a OS de engenharia (taxa da vistoria) — só depois da OS pronta/conferida.
router.post('/:leadId/enviar', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try {
    const r = await enviarOsVistoriaCaixa(req.user!.accountId, req.params.leadId, await quem(req));
    if ('erro' in r) return res.status(400).json({ error: r.erro });
    res.json({ ok: true, mensagem: r.mensagem });
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao enviar a OS' }); }
});
router.post('/:leadId/report', async (req: AuthRequest, res: Response) => {
  if (!req.body?.etapa) return res.status(400).json({ error: 'etapa obrigatória' });
  try { await gravarVistoriaCaixa(req.user!.accountId, req.params.leadId, req.body, req.app.get('io')); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

export default router;
