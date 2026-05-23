import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

const taskSchema = z.object({
  title: z.string().min(1),
  dueAt: z.string().datetime(),
  userId: z.string(),
  leadId: z.string().optional(),
});

const updateTaskSchema = z.object({
  done: z.boolean().optional(),
  title: z.string().optional(),
  dueAt: z.string().datetime().optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { leadId, userId } = req.query;
    const tasks = await prisma.task.findMany({
      where: {
        user: { accountId: req.user!.accountId },
        ...(leadId && { leadId: leadId as string }),
        ...(userId && { userId: userId as string }),
      },
      include: {
        user: { select: { id: true, name: true } },
        lead: { select: { id: true, name: true } },
      },
      orderBy: { dueAt: 'asc' },
    });
    res.json(tasks);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar tarefas' });
  }
});

router.post('/', validate(taskSchema), async (req: AuthRequest, res: Response) => {
  try {
    const task = await prisma.task.create({
      data: { ...req.body, dueAt: new Date(req.body.dueAt) },
      include: { user: { select: { id: true, name: true } } },
    });
    res.status(201).json(task);
  } catch {
    res.status(500).json({ error: 'Erro ao criar tarefa' });
  }
});

router.patch('/:id', validate(updateTaskSchema), async (req: AuthRequest, res: Response) => {
  try {
    const data: Record<string, unknown> = { ...req.body };
    if (req.body.dueAt) data.dueAt = new Date(req.body.dueAt);
    const task = await prisma.task.update({ where: { id: req.params.id }, data });
    res.json(task);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar tarefa' });
  }
});

export default router;
