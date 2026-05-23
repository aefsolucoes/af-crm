import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

const pipelineSchema = z.object({
  name: z.string().min(1),
  stages: z.array(z.object({ name: z.string(), color: z.string().optional(), order: z.number() })).optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const pipelines = await prisma.pipeline.findMany({
      where: { accountId: req.user!.accountId },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    res.json(pipelines);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar pipelines' });
  }
});

router.post('/', validate(pipelineSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { name, stages } = req.body;
    const pipeline = await prisma.pipeline.create({
      data: {
        name,
        accountId: req.user!.accountId,
        stages: stages ? { create: stages } : undefined,
      },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    res.status(201).json(pipeline);
  } catch {
    res.status(500).json({ error: 'Erro ao criar pipeline' });
  }
});

export default router;
