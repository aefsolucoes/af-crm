import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { prisma } from '../lib/prisma';
import { assistantChat, assistantSimulationStatus, assistantSimulationPdf, ChatMsg } from '../services/assistant.service';

/** Assistente do CRM (chat da equipe) — ver services/assistant.service.ts. */
const router = Router();
router.use(authMiddleware);
router.use(requirePermission('inbox_view'));

router.post('/chat', async (req: AuthRequest, res: Response) => {
  try {
    const messages = (Array.isArray(req.body?.messages) ? req.body.messages : []) as ChatMsg[];
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } });
    res.json(await assistantChat({ accountId: req.user!.accountId, userId: req.user!.id, userName: user?.name || 'a equipe', messages }));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'O assistente não respondeu agora' });
  }
});

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
