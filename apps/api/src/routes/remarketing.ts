import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { PrismaClient } from '@prisma/client';
import { listRemarketingStages, startRemarketing, remarketingStatus, setRemarketingPaused, numberQuality } from '../services/remarketing.service';

/** Tela Remarketing — ver remarketing.service.ts. Iniciar/pausar é só admin. */
const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

router.get('/stages', async (req: AuthRequest, res: Response) => {
  try {
    res.json(await listRemarketingStages(req.user!.accountId));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao listar estágios' });
  }
});

router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const [status, quality] = await Promise.all([remarketingStatus(req.user!.accountId), numberQuality(req.user!.accountId)]);
    res.json({ ...status, quality });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao buscar o remarketing' });
  }
});

router.post('/start', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só administradores podem iniciar o remarketing' });
  const stageIds = Array.isArray(req.body?.stageIds) ? (req.body.stageIds as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  if (!stageIds.length) return res.status(400).json({ error: 'Escolha pelo menos um estágio' });
  try {
    const userName = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'Usuário';
    res.json(await startRemarketing({ accountId: req.user!.accountId, stageIds, userId: req.user!.id, userName }));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao iniciar o remarketing' });
  }
});

router.post('/pause', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só administradores podem pausar o remarketing' });
  const paused = req.body?.paused !== false;
  try {
    res.json({ affected: await setRemarketingPaused(req.user!.accountId, paused), paused });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao pausar' });
  }
});

export default router;
