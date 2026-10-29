import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { pedirCadastroCaixa, proximaConsulta, gravarConsulta, prontosParaCadastro, conferirCadastro, pedirCadastroParticipantes, gravarCadastro } from '../services/caixa-cadastro.service';

// Fila do cadastro na CAIXA (Fabio 29/10: "quero que o CRM indique qual cliente rodar") — usada pela extensão "Cadastro CAIXA (Caixa Aqui)".
const router = Router();
router.use(authMiddleware);

router.get('/fila', async (req: AuthRequest, res: Response) => {
  try { res.json(await proximaConsulta(req.user!.accountId)); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro na fila da CAIXA' }); }
});

router.get('/prontos', async (req: AuthRequest, res: Response) => {
  try { res.json(await prontosParaCadastro(req.user!.accountId)); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

router.post('/:leadId/consulta', async (req: AuthRequest, res: Response) => {
  const { ordem, texto } = req.body as { ordem?: number; texto?: string };
  if (!ordem || !texto) return res.status(400).json({ error: 'ordem e texto obrigatórios' });
  try { await gravarConsulta(req.user!.accountId, req.params.leadId, Number(ordem), String(texto)); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

router.post('/:leadId/pedir', async (req: AuthRequest, res: Response) => {
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  const erro = await pedirCadastroCaixa(req.user!.accountId, req.params.leadId, quem).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});

router.post('/:leadId/conferir', async (req: AuthRequest, res: Response) => {
  const { ordem, campos } = req.body as { ordem?: number; campos?: { rotulo: string; valor: string }[] };
  if (!ordem || !Array.isArray(campos)) return res.status(400).json({ error: 'ordem e campos obrigatórios' });
  try {
    const r = await conferirCadastro(req.user!.accountId, req.params.leadId, Number(ordem), campos);
    if (!r) return res.status(502).json({ error: 'Não consegui conferir agora' });
    res.json(r);
  } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

router.post('/:leadId/cadastrar', async (req: AuthRequest, res: Response) => {
  const ordens = (Array.isArray(req.body?.ordens) ? req.body.ordens : []).map(Number).filter((n: number) => n > 0);
  const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
  const erro = await pedirCadastroParticipantes(req.user!.accountId, req.params.leadId, ordens, quem).catch((e) => e?.message || 'erro');
  if (erro) return res.status(400).json({ error: erro });
  res.json({ ok: true });
});

router.post('/:leadId/cadastro', async (req: AuthRequest, res: Response) => {
  const { ordem, status, texto } = req.body as { ordem?: number; status?: string; texto?: string };
  if (!ordem || !status) return res.status(400).json({ error: 'ordem e status obrigatórios' });
  try { await gravarCadastro(req.user!.accountId, req.params.leadId, Number(ordem), { status: String(status), texto: String(texto || '') }); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

// Mapa do formulário de cadastro da CAIXA (nomes, rótulos, opções e botões — sem valores), pra acertar o preenchimento.
router.post('/:leadId/mapa', async (req: AuthRequest, res: Response) => {
  const l = await prisma.lead.findFirst({ where: { id: req.params.leadId, accountId: req.user!.accountId }, select: { customFields: true } });
  if (!l) return res.status(404).json({ error: 'Lead não encontrado' });
  const mapa = { at: new Date().toISOString(), pagina: String((req.body as any)?.pagina || '').slice(0, 200), campos: Array.isArray((req.body as any)?.campos) ? (req.body as any).campos.slice(0, 150) : [], botoes: Array.isArray((req.body as any)?.botoes) ? (req.body as any).botoes.slice(0, 40) : [] };
  await prisma.lead.update({ where: { id: req.params.leadId }, data: { customFields: { ...((l.customFields || {}) as Record<string, unknown>), _caixaFormMapa: mapa } as any } });
  res.json({ ok: true });
});

// Histórico da extensão nos logs do servidor (diagnóstico sem precisar abrir o Chrome do Fabio).
router.post('/log', async (req: AuthRequest, res: Response) => {
  console.log('[CAIXA ext]', String((req.body as any)?.texto || '').replace(/\d{11}/g, '[CPF]').slice(0, 500));
  res.json({ ok: true });
});

export default router;
