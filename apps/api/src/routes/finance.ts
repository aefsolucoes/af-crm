import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

const transactionSchema = z.object({
  description: z.string().min(1),
  amount: z.number().positive(),
  type: z.enum(['INCOME', 'EXPENSE']),
  date: z.string(),
});

const savingsSchema = z.object({
  amount: z.number().positive(),
  description: z.string().optional(),
});

// GET /api/finance?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const { from, to } = req.query;

    const [transactions, savingsTotalAgg] = await Promise.all([
      prisma.transaction.findMany({
        where: {
          accountId,
          ...(from || to ? {
            date: {
              ...(from && { gte: new Date(from as string) }),
              ...(to && { lte: new Date(`${to}T23:59:59`) }),
            },
          } : {}),
        },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { date: 'desc' },
      }),
      // Total acumulado em poupança — sempre considera todo o histórico, não só o período filtrado
      prisma.transaction.aggregate({
        where: { accountId, type: 'SAVINGS' },
        _sum: { amount: true },
      }),
    ]);

    const totalIncome = transactions.filter(t => t.type === 'INCOME').reduce((s, t) => s + t.amount, 0);
    const totalExpense = transactions.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + t.amount, 0);
    const totalSavingsPeriod = transactions.filter(t => t.type === 'SAVINGS').reduce((s, t) => s + t.amount, 0);
    const totalSavingsAllTime = savingsTotalAgg._sum.amount || 0;

    res.json({
      transactions,
      totalIncome,
      totalExpense,
      totalSavingsPeriod,
      totalSavingsAllTime,
      balance: totalIncome - totalExpense - totalSavingsPeriod,
    });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar lançamentos' });
  }
});

// POST /api/finance/savings — transfere um valor do saldo disponível para a poupança
router.post('/savings', validate(savingsSchema), async (req: AuthRequest, res: Response) => {
  try {
    const transaction = await prisma.transaction.create({
      data: {
        description: req.body.description?.trim() || 'Transferência para poupança',
        amount: req.body.amount,
        type: 'SAVINGS',
        date: new Date(),
        accountId: req.user!.accountId,
        userId: req.user!.id,
      },
      include: { user: { select: { id: true, name: true } } },
    });
    res.status(201).json(transaction);
  } catch {
    res.status(500).json({ error: 'Erro ao guardar na poupança' });
  }
});

router.post('/', validate(transactionSchema), async (req: AuthRequest, res: Response) => {
  try {
    const transaction = await prisma.transaction.create({
      data: {
        description: req.body.description,
        amount: req.body.amount,
        type: req.body.type,
        date: new Date(req.body.date),
        accountId: req.user!.accountId,
        userId: req.user!.id,
      },
      include: { user: { select: { id: true, name: true } } },
    });
    res.status(201).json(transaction);
  } catch {
    res.status(500).json({ error: 'Erro ao criar lançamento' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const transaction = await prisma.transaction.findFirst({
      where: { id: req.params.id, accountId: req.user!.accountId },
    });
    if (!transaction) return res.status(404).json({ error: 'Lançamento não encontrado' });
    await prisma.transaction.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir lançamento' });
  }
});

export default router;
