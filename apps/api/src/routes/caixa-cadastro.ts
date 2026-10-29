import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { pedirCadastroCaixa, proximaConsulta, gravarConsulta, prontosParaCadastro } from '../services/caixa-cadastro.service';

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

export default router;
