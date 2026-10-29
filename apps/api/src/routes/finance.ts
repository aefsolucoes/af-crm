import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { validate } from '../middleware/validate';
import { commissionRatePct, commissionAmount, parseCreditValue, propostaSeguida, pagadorComissao, producaoPorPagador, chaveProducao, bancoDoPagador } from '../services/commission.service';

const router = Router();
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

// ── Provisão de comissão por processo ────────────────────────────────────────
// Lançada À MÃO (Fabio 28/10): previsão do que vai entrar de cada cliente em contratação. Não mexe no saldo;
// "Recebido" cria a Receita de verdade. Taxa padrão pelo setor do funil (FH 1%, Home Equity 5%) — ver commission.service.

const provisionSchema = z.object({
  leadId: z.string().min(1),
  baseAmount: z.number().positive(),
  ratePct: z.number().positive().max(100),
  amount: z.number().positive(),
  expectedDate: z.string().nullable().optional(),
  payer: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

const toDate = (d?: string | null) => (d ? new Date(`${d.slice(0, 10)}T12:00:00`) : null);

// GET /api/finance/provisions — todas as provisões, com o funil/etapa atual do card
router.get('/provisions', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const provisions = await prisma.commissionProvision.findMany({
      where: { accountId },
      orderBy: [{ status: 'asc' }, { expectedDate: 'asc' }, { createdAt: 'desc' }],
    });
    const leads = await prisma.lead.findMany({
      where: { id: { in: [...new Set(provisions.map((p) => p.leadId))] } },
      select: { id: true, pipeline: { select: { name: true } }, stage: { select: { name: true } } },
    });
    const where = new Map(leads.map((l) => [l.id, `${l.pipeline.name} · ${l.stage.name}`]));
    res.json(provisions.map((p) => ({ ...p, leadStage: where.get(p.leadId) || 'Card removido' })));
  } catch {
    res.status(500).json({ error: 'Erro ao buscar provisões' });
  }
});

// GET /api/finance/provisions/candidates?q= — clientes pra provisionar. Sem busca: quem está na etapa VISTORIA (Fabio 28/10: "as provisões são
// os clientes que estão em vistoria, pois está mais perto de finalizar") e ainda não tem provisão. Já vem com o crédito, a taxa e quem paga.
router.get('/provisions/candidates', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const q = String(req.query.q || '').trim();
    const provisioned = new Set(
      (await prisma.commissionProvision.findMany({ where: { accountId }, select: { leadId: true } })).map((p) => p.leadId),
    );
    const leads = await prisma.lead.findMany({
      where: q.length >= 2
        ? { accountId, name: { contains: q, mode: 'insensitive' } }
        : { accountId, status: 'OPEN', archived: false, stage: { name: { contains: 'vistoria', mode: 'insensitive' } } },
      select: {
        id: true, name: true, value: true, customFields: true,
        pipeline: { select: { name: true, department: { select: { name: true } } } },
        stage: { select: { name: true } },
      },
      orderBy: { updatedAt: 'desc' },
      take: q.length >= 2 ? 15 : 80,
    });
    const list = q.length >= 2 ? leads : leads.filter((l) => !provisioned.has(l.id));
    const analyses = await prisma.creditAnalysis.findMany({
      where: { leadId: { in: list.map((l) => l.id) }, dryRun: false, source: { not: 'AI_SIM' }, OR: [{ chosen: true }, { status: { in: ['APPROVED', 'CONDITIONAL'] }, approvedValue: { not: null } }] },
      select: { leadId: true, bank: true, approvedValue: true, chosen: true },
      orderBy: { createdAt: 'desc' },
    });
    // Faixa por produção do mês (Inter Home Equity, Bradesco e Santander no Financiamento): o que já foi provisionado no mês + este cliente.
    const producao = await producaoPorPagador(accountId);
    res.json(list.map((l) => {
      const mine = analyses.filter((a) => a.leadId === l.id);
      const seguida = propostaSeguida(mine);
      const pick = seguida || mine[0];
      const cf = (l.customFields as Record<string, unknown>) || {};
      // Base: proposta que o cliente segue (escolhida ⭐ ou a do único banco que aprovou) > "Valor da venda" do card > crédito pedido > última aprovação.
      const base = seguida?.approvedValue || l.value || parseCreditValue(cf.valor_credito) || pick?.approvedValue || 0;
      const product = l.pipeline.department?.name || null;
      const pagador = pagadorComissao(product, pick?.bank, cf.instituicao);
      return {
        id: l.id,
        name: l.name,
        stage: `${l.pipeline.name} · ${l.stage.name}`,
        product,
        baseAmount: base,
        ratePct: commissionRatePct(product, seguida?.bank, { instituicao: cf.instituicao, producaoMes: (producao.get(chaveProducao(product, pagador)) || 0) + base }),
        payer: pagador,
        hasProvision: provisioned.has(l.id),
      };
    }));
  } catch {
    res.status(500).json({ error: 'Erro ao buscar clientes' });
  }
});

// POST /api/finance/provisions/recalculate — refaz a taxa das provisões EM ABERTO e das sugestões pendentes do "Ganho" pela tabela atual
// (Fabio 28/10: contrato do Inter + tabela do Credimorar; as antigas estavam com Inter 5% e Financiamento 1%). Recebidas não mudam.
router.post('/provisions/recalculate', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const abertas = await prisma.commissionProvision.findMany({ where: { accountId, status: 'OPEN' } });
    const leads = new Map((await prisma.lead.findMany({
      where: { id: { in: abertas.map((p) => p.leadId) } }, select: { id: true, customFields: true },
    })).map((l) => [l.id, (l.customFields || {}) as Record<string, unknown>]));
    // 1) Pagador no formato novo (Financiamento: "Credimorar (Banco)"), pra produção de cada banco sair separada.
    for (const p of abertas) {
      const { bank, instituicao } = bancoDoPagador(p.product, p.payer, leads.get(p.leadId)?.instituicao);
      const novo = pagadorComissao(p.product, bank, instituicao) || p.payer;
      if (novo !== p.payer) { await prisma.commissionProvision.update({ where: { id: p.id }, data: { payer: novo } }); p.payer = novo; }
    }
    // 2) Taxa pela faixa do mês de cada provisão.
    const porMes = new Map<string, Map<string, number>>();
    const mudancas: string[] = [];
    for (const p of abertas) {
      const ref = p.expectedDate || p.createdAt;
      const mes = ref.toISOString().slice(0, 7);
      if (!porMes.has(mes)) porMes.set(mes, await producaoPorPagador(accountId, ref));
      const { bank, instituicao } = bancoDoPagador(p.product, p.payer, leads.get(p.leadId)?.instituicao);
      const ratePct = commissionRatePct(p.product, bank, { instituicao, producaoMes: porMes.get(mes)!.get(chaveProducao(p.product, p.payer)) || p.baseAmount });
      if (ratePct === p.ratePct) continue;
      const amount = commissionAmount(p.baseAmount, ratePct);
      await prisma.commissionProvision.update({ where: { id: p.id }, data: { ratePct, amount } });
      mudancas.push(`Provisão ${p.leadName} (${p.payer || 'sem pagador'}): ${p.ratePct}% → ${ratePct}% (R$ ${p.amount.toFixed(2)} → R$ ${amount.toFixed(2)})`);
    }
    // 3) Sugestões pendentes do "Ganho".
    const sugestoes = await prisma.commissionSuggestion.findMany({ where: { accountId, status: 'PENDING' } });
    const producaoAgora = await producaoPorPagador(accountId);
    for (const sg of sugestoes) {
      const lead = await prisma.lead.findUnique({ where: { id: sg.leadId }, select: { name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
      if (!lead) continue;
      const cf = (lead.customFields || {}) as Record<string, unknown>;
      const produto = lead.pipeline?.department?.name || null;
      const seguida = propostaSeguida(await prisma.creditAnalysis.findMany({
        where: { leadId: sg.leadId, dryRun: false, source: { not: 'AI_SIM' }, status: { in: ['APPROVED', 'CONDITIONAL'] }, approvedValue: { not: null } },
        orderBy: { createdAt: 'desc' }, take: 12, select: { bank: true, chosen: true },
      }));
      const ratePct = commissionRatePct(produto, seguida?.bank, { instituicao: cf.instituicao, producaoMes: (producaoAgora.get(chaveProducao(produto, pagadorComissao(produto, seguida?.bank, cf.instituicao))) || 0) + sg.baseAmount });
      const suggestedAmount = commissionAmount(sg.baseAmount, ratePct);
      if (Math.abs(suggestedAmount - sg.suggestedAmount) < 0.01) continue;
      await prisma.commissionSuggestion.update({ where: { id: sg.id }, data: { suggestedAmount } });
      mudancas.push(`Sugestão ${lead.name}: R$ ${sg.suggestedAmount.toFixed(2)} → R$ ${suggestedAmount.toFixed(2)} (${ratePct}%)`);
    }
    res.json({ provisoes: abertas.length, sugestoes: sugestoes.length, mudancas });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao recalcular' });
  }
});

// POST /api/finance/provisions — lança a provisão de um cliente
router.post('/provisions', validate(provisionSchema), async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const body = req.body as z.infer<typeof provisionSchema>;
    const lead = await prisma.lead.findFirst({
      where: { id: body.leadId, accountId },
      select: { id: true, name: true, pipeline: { select: { department: { select: { name: true } } } } },
    });
    if (!lead) return res.status(404).json({ error: 'Cliente não encontrado' });
    const open = await prisma.commissionProvision.findFirst({ where: { leadId: lead.id, status: 'OPEN' } });
    if (open) return res.status(409).json({ error: 'Esse cliente já tem uma provisão em aberto' });
    const provision = await prisma.commissionProvision.create({
      data: {
        accountId,
        leadId: lead.id,
        leadName: lead.name,
        product: lead.pipeline.department?.name || null,
        payer: body.payer?.trim() || null,
        baseAmount: body.baseAmount,
        ratePct: body.ratePct,
        amount: body.amount,
        expectedDate: toDate(body.expectedDate),
        note: body.note?.trim() || null,
        createdById: req.user!.id,
      },
    });
    res.status(201).json(provision);
  } catch {
    res.status(500).json({ error: 'Erro ao lançar provisão' });
  }
});

// PATCH /api/finance/provisions/:id — edita uma provisão em aberto
router.patch('/provisions/:id', validate(provisionSchema.omit({ leadId: true }).partial()), async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.commissionProvision.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
    if (!existing) return res.status(404).json({ error: 'Provisão não encontrada' });
    if (existing.status !== 'OPEN') return res.status(400).json({ error: 'Provisão já recebida' });
    const b = req.body as Partial<z.infer<typeof provisionSchema>>;
    const provision = await prisma.commissionProvision.update({
      where: { id: existing.id },
      data: {
        ...(b.baseAmount !== undefined && { baseAmount: b.baseAmount }),
        ...(b.ratePct !== undefined && { ratePct: b.ratePct }),
        ...(b.amount !== undefined && { amount: b.amount }),
        ...(b.expectedDate !== undefined && { expectedDate: toDate(b.expectedDate) }),
        ...(b.payer !== undefined && { payer: b.payer?.trim() || null }),
        ...(b.note !== undefined && { note: b.note?.trim() || null }),
      },
    });
    res.json(provision);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar provisão' });
  }
});

// POST /api/finance/provisions/:id/receive — o dinheiro caiu: vira Receita (com o valor e a data reais)
router.post('/provisions/:id/receive', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const provision = await prisma.commissionProvision.findFirst({ where: { id: req.params.id, accountId, status: 'OPEN' } });
    if (!provision) return res.status(404).json({ error: 'Provisão não encontrada (ou já recebida)' });
    const { amount, date } = req.body as { amount?: number; date?: string };
    const finalAmount = typeof amount === 'number' && amount > 0 ? amount : provision.amount;
    const when = toDate(date) || new Date();

    const transaction = await prisma.transaction.create({
      data: {
        description: `Comissão — ${provision.leadName}${provision.payer ? ` (${provision.payer})` : ''}`,
        amount: finalAmount,
        type: 'INCOME',
        date: when,
        accountId,
        userId: req.user!.id,
      },
      include: { user: { select: { id: true, name: true } } },
    });
    await prisma.commissionProvision.update({
      where: { id: provision.id },
      data: { status: 'RECEIVED', receivedAmount: finalAmount, receivedAt: when, transactionId: transaction.id },
    });
    // A sugestão automática do "Ganho" do mesmo cliente é a mesma comissão — resolve junto pra não lançar duas vezes.
    await prisma.commissionSuggestion.updateMany({
      where: { accountId, leadId: provision.leadId, status: 'PENDING' },
      data: { status: 'CONFIRMED', transactionId: transaction.id, resolvedAt: new Date() },
    });
    res.status(201).json(transaction);
  } catch {
    res.status(500).json({ error: 'Erro ao registrar recebimento' });
  }
});

// DELETE /api/finance/provisions/:id — tira uma provisão em aberto (ex.: o processo caiu)
router.delete('/provisions/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.commissionProvision.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
    if (!existing) return res.status(404).json({ error: 'Provisão não encontrada' });
    if (existing.status !== 'OPEN') return res.status(400).json({ error: 'Provisão já recebida — exclua a Receita no extrato se precisar' });
    await prisma.commissionProvision.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir provisão' });
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
