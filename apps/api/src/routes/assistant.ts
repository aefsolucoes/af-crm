import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { prisma } from '../lib/prisma';
import { assistantChat, assistantSimulationStatus, assistantSimulationPdf, dueReminders, ChatMsg } from '../services/assistant.service';
import { confirmPendingAction, cancelPendingAction } from '../services/assistant-actions.service';
import { supervisionTts } from '../services/supervision.service';

/** Assistente do CRM (chat da equipe) — ver services/assistant.service.ts. */
const router = Router();
router.use(authMiddleware);
router.use(requirePermission('inbox_view'));

router.post('/chat', async (req: AuthRequest, res: Response) => {
  try {
    const messages = (Array.isArray(req.body?.messages) ? req.body.messages : []) as ChatMsg[];
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } });
    res.json(await assistantChat({ accountId: req.user!.accountId, userId: req.user!.id, userName: user?.name || 'a equipe', token: String(req.headers.authorization || ''), voice: req.body?.voice === true, messages }));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'O assistente não respondeu agora' });
  }
});

// Ação preparada pelo assistente (mensagem, mover card, ganho/perdido, análise, vistoria, certidão): só roda aqui, com o clique/"sim" da pessoa.
router.post('/confirm/:id', async (req: AuthRequest, res: Response) => {
  try { res.json(await confirmPendingAction({ accountId: req.user!.accountId, userId: req.user!.id, token: String(req.headers.authorization || ''), id: req.params.id })); }
  catch (err: any) { res.status(400).json({ error: err?.message || 'Não consegui fazer' }); }
});
router.post('/cancel/:id', (req: AuthRequest, res: Response) => { res.json(cancelPendingAction(req.user!.accountId, req.user!.id, req.params.id)); });

// Voz natural (ElevenLabs, a mesma da supervisão); sem crédito = 503 e o balão usa a voz do navegador.
router.post('/tts', async (req: AuthRequest, res: Response) => {
  try { const audio = await supervisionTts(String(req.body?.text || '')); res.setHeader('Content-Type', 'audio/mpeg'); res.send(audio); }
  catch (err: any) { res.status(err?.status || 500).json({ error: err?.message || 'Erro na voz' }); }
});

// Lembretes que venceram agora — o balão abre e fala.
router.get('/reminders/due', async (req: AuthRequest, res: Response) => { res.json(await dueReminders(req.user!.id)); });

router.get('/simulation/:id', async (req: AuthRequest, res: Response) => {
  const r = await assistantSimulationStatus(req.user!.accountId, req.params.id);
  if (!r) return res.status(404).json({ error: 'Simulação não encontrada' });
  res.json(r);
});

router.get('/simulation/:id/pdf', async (req: AuthRequest, res: Response) => {
  const r = await assistantSimulationPdf(req.user!.accountId, req.params.id);
  if (!r) return res.status(404).json({ error: 'O PDF ainda não está pronto (ou já saiu do CRM depois de 3 dias)' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r.fileName)}"`);
  res.send(r.pdf);
});

export default router;
