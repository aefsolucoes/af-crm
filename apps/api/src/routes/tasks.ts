import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { getScopeDepartmentIds } from '../services/department.service';
import { logActivity } from '../services/activity.service';

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
    const scopeDepartmentIds = await getScopeDepartmentIds(req.user!.accountId, req.user!.id, req.user!.role);
    const tasks = await prisma.task.findMany({
      where: {
        user: { accountId: req.user!.accountId },
        ...(leadId && { leadId: leadId as string }),
        ...(userId && { userId: userId as string }),
        // Tarefa presa a um lead de fora de todos os setores do usuário fica
        // de fora; tarefa sem lead (lembrete pessoal) continua aparecendo.
        ...(scopeDepartmentIds.length ? {
          OR: [
            { leadId: null },
            { lead: { pipeline: { OR: [{ departmentId: { in: scopeDepartmentIds } }, { departmentId: null }] } } },
          ],
        } : {}),
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
    logActivity({
      accountId: req.user!.accountId, userId: req.user!.id,
      action: 'task_created', leadId: task.leadId,
      summary: `criou a tarefa: "${task.title}"`,
    });
  } catch {
    res.status(500).json({ error: 'Erro ao criar tarefa' });
  }
});

router.patch('/:id', validate(updateTaskSchema), async (req: AuthRequest, res: Response) => {
  try {
    const before = await prisma.task.findFirst({
      where: { id: req.params.id, user: { accountId: req.user!.accountId } },
      select: { done: true, title: true, leadId: true },
    });
    const data: Record<string, unknown> = { ...req.body };
    if (req.body.dueAt) data.dueAt = new Date(req.body.dueAt);
    const task = await prisma.task.update({ where: { id: req.params.id }, data });
    res.json(task);

    if (before && req.body.done !== undefined && req.body.done !== before.done) {
      logActivity({
        accountId: req.user!.accountId, userId: req.user!.id,
        action: req.body.done ? 'task_completed' : 'task_reopened', leadId: before.leadId,
        summary: `${req.body.done ? 'concluiu' : 'reabriu'} a tarefa: "${before.title}"`,
      });
    }
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar tarefa' });
  }
});

export default router;
