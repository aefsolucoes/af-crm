import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { validate } from '../middleware/validate';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);
router.use(requirePermission('finance'));

const transactionSchema = z.object({
  description: z.string().min(1),
  amount: z.number().positive(),
  type: z.enum(['INCOME', 'EXPENSE']),
  date: z.string(),
  // Lançamento fixo — repete todo mês sozinho a partir do dia deste primeiro lançamento.
  recurring: z.boolean().optional(),
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

    const [transactions, savingsTotalAgg, previousAgg] = await Promise.all([
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
      // Saldo de TUDO antes do período filtrado — o "residual" que entra como
      // ponto de partida do mês (sem isso, cada mês parecia começar do zero).
      from
        ? prisma.transaction.groupBy({
            by: ['type'],
            where: { accountId, date: { lt: new Date(from as string) } },
            _sum: { amount: true },
          })
        : Promise.resolve(null),
    ]);

    const totalIncome = transactions.filter(t => t.type === 'INCOME').reduce((s, t) => s + t.amount, 0);
    const totalExpense = transactions.filter(t => t.type === 'EXPENSE').reduce((s, t) => s + t.amount, 0);
    const totalSavingsPeriod = transactions.filter(t => t.type === 'SAVINGS').reduce((s, t) => s + t.amount, 0);
    const totalSavingsAllTime = savingsTotalAgg._sum.amount || 0;

    const sumByType = (type: string) => previousAgg?.find((g) => g.type === type)?._sum.amount || 0;
    const previousBalance = previousAgg
      ? sumByType('INCOME') - sumByType('EXPENSE') - sumByType('SAVINGS')
      : 0;

    res.json({
      transactions,
      totalIncome,
      totalExpense,
      totalSavingsPeriod,
      totalSavingsAllTime,
      previousBalance,
      // Saldo acumulado: o que sobrou de antes + o que aconteceu neste período.
      balance: previousBalance + (totalIncome - totalExpense - totalSavingsPeriod),
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
    const date = new Date(req.body.date);
    const transaction = await prisma.transaction.create({
      data: {
        description: req.body.description,
        amount: req.body.amount,
        type: req.body.type,
        date,
        accountId: req.user!.accountId,
        userId: req.user!.id,
        ...(req.body.recurring ? { isRecurring: true, recurringDay: date.getDate() } : {}),
      },
      include: { user: { select: { id: true, name: true } } },
    });
    res.status(201).json(transaction);
  } catch {
    res.status(500).json({ error: 'Erro ao criar lançamento' });
  }
});

// PATCH /api/finance/:id — edita um lançamento (descrição, valor, tipo, data)
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.transaction.findFirst({
      where: { id: req.params.id, accountId: req.user!.accountId },
    });
    if (!existing) return res.status(404).json({ error: 'Lançamento não encontrado' });

    const { description, amount, type, date } = req.body as {
      description?: string; amount?: number; type?: string; date?: string;
    };
    const data: Record<string, unknown> = {};
    if (description !== undefined) {
      if (!String(description).trim()) return res.status(400).json({ error: 'Descrição obrigatória' });
      data.description = String(description).trim();
    }
    if (amount !== undefined) {
      if (typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'Valor inválido' });
      data.amount = amount;
    }
    if (type !== undefined) {
      if (!['INCOME', 'EXPENSE'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' });
      data.type = type;
    }
    if (date !== undefined) data.date = new Date(date);

    const transaction = await prisma.transaction.update({
      where: { id: req.params.id },
      data,
      include: { user: { select: { id: true, name: true } } },
    });
    res.json(transaction);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar lançamento' });
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

// ── Sugestões de comissão ────────────────────────────────────────────────────
// Geradas sozinhas quando um lead é marcado como Ganho (1% do valor de
// crédito) — ver leads.ts. Ficam pendentes até o usuário revisar/ajustar o
// valor aqui no Financeiro e confirmar; só então viram uma Transaction real.

// GET /api/finance/commission-suggestions — sugestões pendentes
router.get('/commission-suggestions', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const suggestions = await prisma.commissionSuggestion.findMany({
      where: { accountId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });
    const leadIds = [...new Set(suggestions.map((s) => s.leadId))];
    const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true } });
    const leadNames = new Map(leads.map((l) => [l.id, l.name]));
    res.json(suggestions.map((s) => ({ ...s, leadName: leadNames.get(s.leadId) || 'Lead removido' })));
  } catch {
    res.status(500).json({ error: 'Erro ao buscar sugestões de comissão' });
  }
});

// POST /api/finance/commission-suggestions/:id/confirm — vira um lançamento (Receita) de verdade
router.post('/commission-suggestions/:id/confirm', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const suggestion = await prisma.commissionSuggestion.findFirst({ where: { id: req.params.id, accountId, status: 'PENDING' } });
    if (!suggestion) return res.status(404).json({ error: 'Sugestão não encontrada (ou já resolvida)' });

    const { amount, description } = req.body as { amount?: number; description?: string };
    const finalAmount = typeof amount === 'number' && amount > 0 ? amount : suggestion.suggestedAmount;
    if (finalAmount <= 0) return res.status(400).json({ error: 'Valor inválido' });

    const lead = await prisma.lead.findUnique({ where: { id: suggestion.leadId }, select: { name: true } });
    const finalDescription = description?.trim() || `Comissão — ${lead?.name || 'cliente'}`;

    const transaction = await prisma.transaction.create({
      data: {
        description: finalDescription,
        amount: finalAmount,
        type: 'INCOME',
        date: new Date(),
        accountId,
        userId: req.user!.id,
      },
      include: { user: { select: { id: true, name: true } } },
    });

    await prisma.commissionSuggestion.update({
      where: { id: suggestion.id },
      data: { status: 'CONFIRMED', transactionId: transaction.id, resolvedAt: new Date() },
    });

    res.status(201).json(transaction);
  } catch {
    res.status(500).json({ error: 'Erro ao confirmar comissão' });
  }
});

// POST /api/finance/commission-suggestions/:id/dismiss — descarta a sugestão
router.post('/commission-suggestions/:id/dismiss', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const suggestion = await prisma.commissionSuggestion.findFirst({ where: { id: req.params.id, accountId, status: 'PENDING' } });
    if (!suggestion) return res.status(404).json({ error: 'Sugestão não encontrada (ou já resolvida)' });
    await prisma.commissionSuggestion.update({
      where: { id: suggestion.id },
      data: { status: 'DISMISSED', resolvedAt: new Date() },
    });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao descartar sugestão' });
  }
});

// ── Lançamentos fixos (repetem todo mês sozinhos) ────────────────────────────

/** Cria a ocorrência do mês para cada lançamento marcado como fixo, se ainda
 *  não existir uma para o mês atual e se já chegou o dia. Roda sozinha,
 *  agendada no index.ts — ninguém precisa abrir o Financeiro para acontecer. */
export async function generateRecurringTransactions(): Promise<void> {
  const templates = await prisma.transaction.findMany({ where: { isRecurring: true } });
  if (!templates.length) return;

  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-based
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0, 23, 59, 59, 999);
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (const t of templates) {
    try {
      const day = Math.min(t.recurringDay || new Date(t.date).getDate(), daysInMonth);
      if (now.getDate() < day) continue; // ainda não chegou o dia deste mês

      const exists = await prisma.transaction.findFirst({
        where: {
          accountId: t.accountId,
          date: { gte: monthStart, lte: monthEnd },
          OR: [{ id: t.id }, { recurringParentId: t.id }],
        },
      });
      if (exists) continue;

      await prisma.transaction.create({
        data: {
          description: t.description,
          amount: t.amount,
          type: t.type,
          date: new Date(year, month, day),
          accountId: t.accountId,
          userId: t.userId,
          recurringParentId: t.id,
        },
      });
      console.log(`[Financeiro] Lançamento fixo gerado: "${t.description}" (${t.type}) — ${year}-${month + 1}`);
    } catch (err) {
      console.error(`[Financeiro] Falha ao gerar ocorrência fixa (template ${t.id}):`, (err as any)?.message);
    }
  }
}

export default router;
