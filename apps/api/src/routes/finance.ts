import express, { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { validate } from '../middleware/validate';
import { commissionRatePct, commissionAmount, propostaSeguida, pagadorComissao, producaoPorPagador, chaveProducao, bancoDoPagador, etapasDaVistoriaEmDiante, montarProvisoes, parseCreditValue } from '../services/commission.service';

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
    // A estimativa acompanha o card: proposta escolhida/banco que aprovou (Fabio 14/11 — Rosana com Inter escolhido seguia com "?").
    await (require('../services/commission.service') as typeof import('../services/commission.service')).sincronizarProvisoes(accountId).catch((e) => console.warn('[Provisão] sincronizar:', e?.message));
    const provisions = await prisma.commissionProvision.findMany({
      where: { accountId },
      orderBy: [{ status: 'asc' }, { expectedDate: 'asc' }, { createdAt: 'desc' }],
    });
    const leads = await prisma.lead.findMany({
      where: { id: { in: [...new Set(provisions.map((p) => p.leadId))] } },
      select: { id: true, status: true, pipeline: { select: { name: true } }, stage: { select: { name: true } } },
    });
    const where = new Map(leads.map((l) => [l.id, `${l.pipeline.name} · ${l.stage.name}`]));
    // Situação do processo (Fabio 14/11: "a soma de todos os processos pra receber"): card em Perdidos não paga — sai do total a receber; Concluído ainda entra até ser marcado "Recebido".
    const situacao = new Map(leads.map((l) => [l.id, l.status === 'LOST' || /perdid/i.test(l.pipeline.name) ? 'PERDIDO' : l.status === 'WON' || /conclu/i.test(l.pipeline.name) ? 'CONCLUIDO' : 'CONTRATACAO']));
    res.json(provisions.map((p) => ({ ...p, leadStage: where.get(p.leadId) || 'Card removido', leadSituacao: situacao.get(p.leadId) || 'REMOVIDO' })));
  } catch {
    res.status(500).json({ error: 'Erro ao buscar provisões' });
  }
});

// GET /api/finance/provisions/candidates?q= — clientes pra provisionar. Sem busca: quem está da VISTORIA em diante (Fabio 28/10: "as provisões são
// os clientes que estão em vistoria, pois está mais perto de finalizar" / "vistoria e os estágios à frente dele") e ainda não tem provisão — normalmente
// a provisão já é lançada sozinha (autoProvisoes); sobra aqui quem está sem valor no card. Já vem com o crédito, a taxa e quem paga.
router.get('/provisions/candidates', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const q = String(req.query.q || '').trim();
    const provisioned = new Set(
      (await prisma.commissionProvision.findMany({ where: { accountId }, select: { leadId: true } })).map((p) => p.leadId),
    );
    // Sem busca: quem está da Vistoria em diante nos funis "Em contratação" (Fabio 28/10) e ainda não tem provisão.
    const ids = q.length >= 2
      ? (await prisma.lead.findMany({ where: { accountId, name: { contains: q, mode: 'insensitive' } }, orderBy: { updatedAt: 'desc' }, take: 15, select: { id: true } })).map((l) => l.id)
      : (await prisma.lead.findMany({ where: { accountId, status: 'OPEN', archived: false, stageId: { in: await etapasDaVistoriaEmDiante(accountId) } }, orderBy: { updatedAt: 'desc' }, take: 80, select: { id: true } }))
        .map((l) => l.id).filter((id) => !provisioned.has(id));
    res.json((await montarProvisoes(accountId, ids)).map((p) => ({ ...p, hasProvision: provisioned.has(p.id) })));
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
        // % ou valor mudado por uma pessoa: a taxa aprendida das notas não mexe mais nessa provisão (Fabio 14/11)
        ...((b.ratePct !== undefined && b.ratePct !== existing.ratePct) || (b.amount !== undefined && Math.abs(b.amount - existing.amount) >= 0.01) ? { rateLocked: true } : {}),
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

// POST /api/finance/provisions/:id/bank { payer } — escolhe o banco de uma provisão "?" no Financeiro; refaz a % pela tabela/taxa aprendida (se ninguém digitou a %)
router.post('/provisions/:id/bank', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const payer = String(req.body?.payer || '').trim().slice(0, 60);
    if (!payer) return res.status(400).json({ error: 'Escolha o banco' });
    const p = await prisma.commissionProvision.findFirst({ where: { id: req.params.id, accountId, status: 'OPEN' } });
    if (!p) return res.status(404).json({ error: 'Provisão não encontrada' });
    const svc = require('../services/commission.service') as typeof import('../services/commission.service');
    const ratePct = p.rateLocked || p.noteId ? p.ratePct : await svc.taxaParaPagador(accountId, p.product, payer, p.baseAmount);
    const amount = p.rateLocked || p.noteId ? p.amount : commissionAmount(p.baseAmount, ratePct);
    res.json(await prisma.commissionProvision.update({ where: { id: p.id }, data: { payer, ratePct, amount } }));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao escolher o banco' });
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

// ── Notas de comissão (Fabio 14/11): uma nota (NF ou demonstrativo) do banco com um ou vários processos ─────────────────────────────
const notaSvc = () => require('../services/commission-note.service') as typeof import('../services/commission-note.service');
const semArquivo = { id: true, accountId: true, payer: true, number: true, issueDate: true, totalAmount: true, retainedAmount: true, netAmount: true, taxesToPay: true, taxes: true, docType: true, driveFileId: true, driveLink: true, drivePath: true, fileName: true, fileMime: true, aiRead: true, status: true, receivedAt: true, transactionId: true, note: true, createdAt: true, updatedAt: true } as const;

/** Lê o arquivo, guarda como rascunho e devolve a proposta (usada no anexo pelo CRM e na nota que já está no Drive). */
async function criarRascunhoDaNota(accountId: string, userId: string, p: { buf: Buffer; mime: string; payer: string; fileName: string; drive?: { id: string; link: string | null; path: string } }) {
  const svc = notaSvc();
  const candidatos = await svc.candidatosDaNota(accountId, undefined, { concluidos: true });
  const leitura = await svc.lerNotaComIA(p.buf, p.mime, candidatos.map((c) => ({ id: c.id, cliente: c.cliente, credito: c.credito, estimado: c.estimado, pagador: c.pagador, nomes: c.nomes })));
  svc.casarPorPropostaECpf(leitura, candidatos); // nº da proposta/CPF da nota casam o processo mesmo com o nome de outro participante
  const total = leitura?.valorTotal || 0;
  const imp = leitura?.impostos || null;
  const retido = leitura?.totalRetido ?? (imp ? [imp.irrf, imp.issRetido, imp.pis, imp.cofins, imp.csll, imp.inss, imp.outras].reduce<number>((s, v) => s + (v || 0), 0) : 0);
  const liquido = leitura?.valorLiquido ?? (total ? Math.round((total - retido) * 100) / 100 : null);
  const aPagar = imp && imp.issRetidoNaNota === false && imp.issApurado ? imp.issApurado : 0; // ISS apurado e não retido: a A&F paga depois
  const proposta = svc.proporItens(leitura, total, p.payer, candidatos);
  const nota = await prisma.commissionNote.create({
    data: {
      accountId, payer: p.payer, status: 'DRAFT', number: leitura?.numero || null, issueDate: toDate(leitura?.data), totalAmount: total,
      retainedAmount: Math.round(retido * 100) / 100, netAmount: liquido, taxesToPay: aPagar, taxes: (imp as any) || undefined, docType: leitura?.tipo || null,
      fileName: p.fileName.slice(0, 160), fileMime: p.mime, fileData: p.buf, aiRead: (leitura as any) || undefined, createdById: userId,
      ...(p.drive ? { driveFileId: p.drive.id, driveLink: p.drive.link, drivePath: p.drive.path } : {}),
    },
    select: semArquivo,
  });
  return { nota, leitura, candidatos, proposta, lida: !!leitura };
}

// GET /api/finance/notes — notas confirmadas/recebidas com os processos de cada uma + taxas aprendidas
router.get('/notes', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    // Rascunho esquecido (leu o PDF e não confirmou) some depois de 1 dia.
    await prisma.commissionNote.deleteMany({ where: { accountId, status: 'DRAFT', createdAt: { lt: new Date(Date.now() - 86_400_000) } } }).catch(() => {});
    const notas = await prisma.commissionNote.findMany({ where: { accountId, status: { in: ['OPEN', 'RECEIVED'] } }, orderBy: [{ status: 'asc' }, { issueDate: 'desc' }, { createdAt: 'desc' }], select: semArquivo });
    const provs = await prisma.commissionProvision.findMany({ where: { accountId, noteId: { in: notas.map((n) => n.id) } }, select: { id: true, noteId: true, leadId: true, leadName: true, product: true, payer: true, baseAmount: true, amount: true, estimatedAmount: true, receivedAmount: true } });
    const taxas = [...(await notaSvc().taxasAprendidas(accountId)).values()].map((t) => ({ ...t, bancoNome: notaSvc().nomeDoBanco(t.banco) }));
    res.json({ notas: notas.map((n) => ({ ...n, processos: provs.filter((p) => p.noteId === n.id) })), taxas });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao buscar notas' });
  }
});

// POST /api/finance/notes/read?payer=Inter&fileName=x.pdf — corpo = o arquivo (PDF ou foto). Guarda como rascunho, a IA lê e o CRM propõe os processos.
router.post('/notes/read', express.raw({ type: () => true, limit: '15mb' }), async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const payer = String(req.query.payer || '').trim().slice(0, 60);
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!payer) return res.status(400).json({ error: 'Escolha quem paga a nota' });
    if (!buf.length) return res.status(400).json({ error: 'Anexe o PDF da nota' });
    const mime = String(req.headers['content-type'] || 'application/pdf').split(';')[0];
    res.status(201).json(await criarRascunhoDaNota(accountId, req.user!.id, { buf, mime, payer, fileName: String(req.query.fileName || 'nota.pdf') }));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao ler a nota' });
  }
});

// GET /api/finance/notes/:id/candidates — processos que podem entrar na nota (pra editar uma nota já lançada)
router.get('/notes/:id/candidates', async (req: AuthRequest, res: Response) => {
  try {
    const nota = await prisma.commissionNote.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId }, select: { id: true } });
    if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });
    res.json(await notaSvc().candidatosDaNota(req.user!.accountId, nota.id, { concluidos: true }));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao buscar processos' });
  }
});

const notaSchema = z.object({
  payer: z.string().min(1),
  number: z.string().nullable().optional(),
  issueDate: z.string().nullable().optional(),
  totalAmount: z.number().positive(),
  note: z.string().nullable().optional(),
  retainedAmount: z.number().min(0).optional(),
  netAmount: z.number().positive().nullable().optional(),
  taxesToPay: z.number().min(0).optional(),
  docType: z.enum(['NFSE', 'DEMONSTRATIVO']).nullable().optional(),
  // Pode ficar vazio: nota de cliente que não está no CRM (de antes do CRM) — fica guardada com os nomes que a nota cita.
  itens: z.array(z.object({ id: z.string().min(1), amount: z.number().positive(), credito: z.number().positive().optional() })),
});

// PUT /api/finance/notes/:id — confirma (ou corrige) a nota: o valor de cada processo passa a ser o da nota; a taxa aprendida atualiza as estimativas do mesmo banco.
router.put('/notes/:id', validate(notaSchema), async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const b = req.body as z.infer<typeof notaSchema>;
    const nota = await prisma.commissionNote.findFirst({ where: { id: req.params.id, accountId }, select: { id: true, status: true, driveFileId: true } });
    if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });
    if (nota.status === 'RECEIVED') return res.status(400).json({ error: 'Nota já recebida' });
    const soma = Math.round(b.itens.reduce((s, i) => s + i.amount, 0) * 100) / 100;
    if (b.itens.length && Math.abs(soma - b.totalAmount) > 0.01) return res.status(400).json({ error: `A soma dos processos (R$ ${soma.toFixed(2)}) não bate com o total da nota (R$ ${b.totalAmount.toFixed(2)})` });

    // 1) Solta os processos que estavam nesta nota (voltam pra estimativa).
    const antes = await prisma.commissionProvision.findMany({ where: { accountId, noteId: nota.id, status: 'OPEN' } });
    for (const p of antes) await prisma.commissionProvision.update({ where: { id: p.id }, data: { noteId: null, amount: p.estimatedAmount ?? p.amount, estimatedAmount: null } });

    // 2) Liga os processos escolhidos. Concluído só com comissão sugerida (sem provisão) vira provisão aqui.
    for (const it of b.itens) {
      let provId = it.id;
      if (it.id.startsWith('lead:')) {
        const lead = await prisma.lead.findFirst({ where: { id: it.id.slice(5), accountId }, select: { id: true, name: true, value: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
        if (!lead) continue;
        const cfL = (lead.customFields || {}) as Record<string, unknown>;
        const base = it.credito || Number(lead.value) || parseCreditValue(cfL.valor_credito) || 0;
        const criada = await prisma.commissionProvision.create({
          data: { accountId, leadId: lead.id, leadName: lead.name, product: lead.pipeline.department?.name || null, payer: b.payer, baseAmount: base, ratePct: base > 0 ? Math.round((it.amount / base) * 100 * 10_000) / 10_000 : 0, amount: it.amount, note: 'Processo concluído ligado à nota', createdById: req.user!.id },
        });
        provId = criada.id;
      } else if (it.id.startsWith('sug:')) {
        const sg = await prisma.commissionSuggestion.findFirst({ where: { id: it.id.slice(4), accountId, status: 'PENDING' } });
        if (!sg) continue;
        const lead = await prisma.lead.findFirst({ where: { id: sg.leadId, accountId }, select: { id: true, name: true, pipeline: { select: { department: { select: { name: true } } } } } });
        if (!lead) continue;
        const criada = await prisma.commissionProvision.create({
          // Base = o financiamento que a NOTA traz (ex.: Taysnara 187.500 na NF × 195.000 no card), senão o da sugestão.
          data: { accountId, leadId: lead.id, leadName: lead.name, product: lead.pipeline.department?.name || null, payer: b.payer, baseAmount: it.credito || sg.baseAmount, ratePct: (it.credito || sg.baseAmount) > 0 ? Math.round((sg.suggestedAmount / (it.credito || sg.baseAmount)) * 100 * 10_000) / 10_000 : 0, amount: sg.suggestedAmount, estimatedAmount: sg.suggestedAmount, note: 'Concluído: comissão sugerida no Ganho, ligada à nota', createdById: req.user!.id },
        });
        provId = criada.id;
      }
      const p = await prisma.commissionProvision.findFirst({ where: { id: provId, accountId, status: 'OPEN' } });
      if (!p) continue;
      await prisma.commissionProvision.update({
        where: { id: p.id },
        data: {
          noteId: nota.id, estimatedAmount: p.estimatedAmount ?? p.amount, amount: it.amount,
          ratePct: p.baseAmount > 0 ? Math.round((it.amount / p.baseAmount) * 100 * 10_000) / 10_000 : p.ratePct,
          payer: p.payer || b.payer, // processo sem banco: fica com quem pagou a nota
        },
      });
    }
    const salva = await prisma.commissionNote.update({
      where: { id: nota.id },
      data: {
        payer: b.payer.trim(), number: b.number?.trim() || null, issueDate: toDate(b.issueDate), totalAmount: b.totalAmount, note: b.note?.trim() || null, status: nota.status === 'DRAFT' ? 'OPEN' : nota.status,
        ...(b.retainedAmount !== undefined && { retainedAmount: b.retainedAmount }),
        ...(b.netAmount !== undefined && { netAmount: b.netAmount }),
        ...(b.taxesToPay !== undefined && { taxesToPay: b.taxesToPay }),
        ...(b.docType !== undefined && { docType: b.docType }),
      },
      select: semArquivo,
    });
    // Drive: renomeia no padrão e guarda em CONTABILIDADE/<ano>/NFE (ou na pasta do pagador, se for o demonstrativo do banco). Nota que veio do Drive fica onde está.
    let salva2 = salva;
    if (!nota.driveFileId) {
      try {
        const cheia = await prisma.commissionNote.findUnique({ where: { id: nota.id }, select: { payer: true, issueDate: true, createdAt: true, docType: true, fileData: true, fileMime: true, fileName: true } });
        const d = cheia?.fileData ? await notaSvc().salvarNotaNoDrive(accountId, cheia as any) : null;
        if (d) salva2 = await prisma.commissionNote.update({ where: { id: nota.id }, data: { driveFileId: d.id, driveLink: d.link, drivePath: d.caminho }, select: semArquivo });
      } catch (e: any) { console.warn('[Nota comissão] não salvei no Drive:', e?.message); }
    }
    // 3) Aprende: as estimativas (sem % digitada por uma pessoa) do mesmo banco e produto passam pra taxa efetiva das notas.
    const reestimadas = await notaSvc().reestimarPelasNotas(accountId).catch(() => [] as string[]);
    res.json({ nota: salva2, reestimadas });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao salvar a nota' });
  }
});

// Receita no extrato = o PROCESSO de cada cliente (Fabio 15/11: "era pra estar o processo dos clientes, não a referência à NF"): uma receita por processo,
// com a parte dele do que caiu (líquido, na proporção do valor bruto na nota), e a NF só como referência no fim. Nota sem processo do CRM: os clientes que ela cita.
const marcaDaNota = /^Comissão — NF|· NF (nº|s\/ nº)/; // receitas que a própria nota lançou (as lançadas à mão não têm isso)
function clientesCitados(nota: { aiRead?: any; note?: string | null }): string {
  const daLeitura = (Array.isArray(nota.aiRead?.itens) ? nota.aiRead.itens : []).map((i: any) => String(i?.cliente || '').trim()).filter(Boolean);
  if (daLeitura.length) return Array.from(new Set(daLeitura)).join(' e ');
  const m = /Clientes?:\s*([^—·]+)/i.exec(nota.note || '');
  return m ? m[1].replace(/\(R\$[^)]*\)/g, '').replace(/\s+/g, ' ').trim() : '';
}
async function lancarReceitasDaNota(accountId: string, userId: string, nota: { id: string; number: string | null; payer: string; aiRead?: any; note?: string | null }, provs: Array<{ id: string; leadId: string; leadName: string; amount: number }>, valor: number, when: Date): Promise<string[]> {
  const ref = `NF ${nota.number ? `nº ${nota.number}` : 's/ nº'}`;
  if (!provs.length) {
    const tx = await prisma.transaction.create({ data: { description: `Comissão — ${clientesCitados(nota) || 'cliente não identificado na nota'} (${nota.payer}) · ${ref}`, amount: valor, type: 'INCOME', date: when, accountId, userId } });
    return [tx.id];
  }
  const partes = notaSvc().dividirProporcional(valor, provs.map((p) => p.amount));
  const ids: string[] = [];
  for (let i = 0; i < provs.length; i++) {
    const tx = await prisma.transaction.create({ data: { description: `Comissão — ${provs[i].leadName} (${nota.payer}) · ${ref}`, amount: partes[i], type: 'INCOME', date: when, accountId, userId } });
    ids.push(tx.id);
    await prisma.commissionProvision.update({ where: { id: provs[i].id }, data: { status: 'RECEIVED', receivedAmount: partes[i], receivedAt: when, transactionId: tx.id } });
    await prisma.commissionSuggestion.updateMany({ where: { accountId, leadId: provs[i].leadId, status: 'PENDING' }, data: { status: 'CONFIRMED', transactionId: tx.id, resolvedAt: new Date() } });
  }
  return ids;
}
/** Receitas que a nota lançou (as dos processos dela + a da própria nota), só as com a marca da nota. */
async function receitasLancadasPelaNota(accountId: string, nota: { id: string; transactionId: string | null }) {
  const ids = new Set<string>((await prisma.commissionProvision.findMany({ where: { accountId, noteId: nota.id, transactionId: { not: null } }, select: { transactionId: true } })).map((p) => p.transactionId!));
  if (nota.transactionId) ids.add(nota.transactionId);
  const txs = await prisma.transaction.findMany({ where: { accountId, id: { in: Array.from(ids) } }, select: { id: true, description: true, amount: true, date: true } });
  return txs.filter((t) => marcaDaNota.test(t.description));
}

// POST /api/finance/notes/:id/receive — o banco pagou a nota: UMA Receita com o total e baixa em todos os processos dela.
router.post('/notes/:id/receive', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const nota = await prisma.commissionNote.findFirst({ where: { id: req.params.id, accountId, status: 'OPEN' }, select: semArquivo });
    if (!nota) return res.status(404).json({ error: 'Nota não encontrada (ou já recebida)' });
    const { amount, date, transactionId, semReceita } = req.body as { amount?: number; date?: string; transactionId?: string; semReceita?: boolean };
    const liquido = nota.netAmount ?? Math.round((nota.totalAmount - (nota.retainedAmount || 0)) * 100) / 100; // o que cai na conta (bruto − impostos retidos)
    const provs = await prisma.commissionProvision.findMany({ where: { accountId, noteId: nota.id, status: 'OPEN' } });
    // Receita que já foi lançada à mão (ex.: "Recebimento Credmorar …"): só liga, não lança de novo.
    const existente = transactionId ? await prisma.transaction.findFirst({ where: { id: transactionId, accountId, type: 'INCOME' }, include: { user: { select: { id: true, name: true } } } }) : null;
    if (transactionId && !existente) return res.status(404).json({ error: 'Receita não encontrada' });
    const valor = existente ? existente.amount : typeof amount === 'number' && amount > 0 ? amount : liquido;
    const when = existente ? existente.date : toDate(date) || new Date();
    if (existente || semReceita) {
      // Receita lançada à mão (só liga) ou nota de antes do Financeiro (sem receita): os processos recebem a sua parte, sem mexer no extrato.
      const partes = notaSvc().dividirProporcional(valor, provs.map((p) => p.amount));
      for (let i = 0; i < provs.length; i++) {
        await prisma.commissionProvision.update({ where: { id: provs[i].id }, data: { status: 'RECEIVED', receivedAmount: partes[i], receivedAt: when, transactionId: existente?.id || null } });
        await prisma.commissionSuggestion.updateMany({ where: { accountId, leadId: provs[i].leadId, status: 'PENDING' }, data: { status: 'CONFIRMED', transactionId: existente?.id || null, resolvedAt: new Date() } });
      }
      await prisma.commissionNote.update({ where: { id: nota.id }, data: { status: 'RECEIVED', receivedAt: when, transactionId: existente?.id || null } });
      return res.status(201).json(existente || { ok: true, semReceita: true });
    }
    const ids = await lancarReceitasDaNota(accountId, req.user!.id, nota, provs, valor, when);
    await prisma.commissionNote.update({ where: { id: nota.id }, data: { status: 'RECEIVED', receivedAt: when, transactionId: ids[0] || null } });
    res.status(201).json({ ok: true, receitas: ids.length, amount: valor });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao registrar o recebimento da nota' });
  }
});

// POST /api/finance/notes/:id/redo-income — refaz as receitas de uma nota já recebida: uma por processo (com o nome do cliente), mesma data e mesmo total
router.post('/notes/:id/redo-income', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const nota = await prisma.commissionNote.findFirst({ where: { id: req.params.id, accountId, status: 'RECEIVED' }, select: { id: true, number: true, payer: true, aiRead: true, note: true, transactionId: true, receivedAt: true } });
    if (!nota) return res.status(404).json({ error: 'Nota recebida não encontrada' });
    const velhas = await receitasLancadasPelaNota(accountId, nota);
    if (!velhas.length) return res.json({ ok: true, refeitas: 0, motivo: 'a nota não lançou receita (ligada a receita lançada à mão ou sem receita)' });
    const valor = Math.round(velhas.reduce((s, t) => s + t.amount, 0) * 100) / 100;
    const when = velhas[0].date;
    await prisma.transaction.deleteMany({ where: { id: { in: velhas.map((t) => t.id) } } });
    const provs = await prisma.commissionProvision.findMany({ where: { accountId, noteId: nota.id }, orderBy: { createdAt: 'asc' } });
    const ids = await lancarReceitasDaNota(accountId, req.user!.id, nota, provs, valor, when);
    await prisma.commissionNote.update({ where: { id: nota.id }, data: { transactionId: ids[0] || null } });
    res.json({ ok: true, refeitas: ids.length, valor });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao refazer as receitas' });
  }
});

// GET /api/finance/notes/drive?ano=2026 — NFs que já estão em CONTABILIDADE/<ano>/NFE e se já foram trazidas pro CRM
router.get('/notes/drive', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const ano = Number(req.query.ano) || new Date().getFullYear();
    const g = require('../services/google.service') as typeof import('../services/google.service');
    const anoId = await notaSvc().pastaDoAno(accountId, ano);
    if (!anoId) return res.status(404).json({ error: 'Não achei a pasta CONTABILIDADE no Drive do CRM' });
    const nfe = await g.findFolder(accountId, 'NFE', anoId);
    const arquivos = nfe ? await notaSvc().pdfsDaPasta(accountId, nfe) : [];
    const jaTem = new Map((await prisma.commissionNote.findMany({ where: { accountId, driveFileId: { in: arquivos.map((a) => a.id) } }, select: { id: true, driveFileId: true, status: true } })).map((n) => [n.driveFileId, n]));
    res.json(arquivos.map((a) => ({ ...a, notaId: jaTem.get(a.id)?.id || null, status: jaTem.get(a.id)?.status || null })));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao listar as notas do Drive' });
  }
});

// POST /api/finance/notes/from-drive { fileId, payer } — nota que já está no Drive: lê e prepara (não sobe de novo; fica onde está)
router.post('/notes/from-drive', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const fileId = String(req.body?.fileId || '');
    const payer = String(req.body?.payer || '').trim().slice(0, 60);
    if (!fileId || !payer) return res.status(400).json({ error: 'fileId e payer são obrigatórios' });
    const ja = await prisma.commissionNote.findFirst({ where: { accountId, driveFileId: fileId, status: { in: ['OPEN', 'RECEIVED'] } }, select: { id: true } });
    if (ja) return res.status(409).json({ error: 'Essa nota já está no CRM', notaId: ja.id });
    await prisma.commissionNote.deleteMany({ where: { accountId, driveFileId: fileId, status: 'DRAFT' } });
    const g = require('../services/google.service') as typeof import('../services/google.service');
    const drive = await g.getDrive(accountId);
    const meta = await drive.files.get({ fileId, fields: 'id, name, mimeType, webViewLink, parents', supportsAllDrives: true });
    const buf = await g.downloadDriveFile(accountId, fileId, meta.data.mimeType || 'application/pdf');
    res.status(201).json(await criarRascunhoDaNota(accountId, req.user!.id, { buf, mime: meta.data.mimeType || 'application/pdf', payer, fileName: meta.data.name || 'nota.pdf', drive: { id: fileId, link: meta.data.webViewLink || null, path: meta.data.name || '' } }));
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao trazer a nota do Drive' });
  }
});

// GET /api/finance/notes/:id/file — o PDF (ou foto) da nota
router.get('/notes/:id/file', async (req: AuthRequest, res: Response) => {
  try {
    const nota = await prisma.commissionNote.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId }, select: { fileData: true, fileMime: true, fileName: true } });
    if (!nota?.fileData) return res.status(404).json({ error: 'Arquivo não encontrado' });
    res.setHeader('Content-Type', nota.fileMime || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(nota.fileName || 'nota.pdf')}"`);
    res.send(Buffer.from(nota.fileData));
  } catch {
    res.status(500).json({ error: 'Erro ao abrir o arquivo' });
  }
});

// DELETE /api/finance/notes/:id — tira a nota (rascunho ou em aberto): os processos voltam pra estimativa
router.delete('/notes/:id', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const nota = await prisma.commissionNote.findFirst({ where: { id: req.params.id, accountId }, select: { id: true, status: true, transactionId: true } });
    if (!nota) return res.status(404).json({ error: 'Nota não encontrada' });
    const forcar = String(req.query.forcar || '') === '1';
    if (nota.status === 'RECEIVED' && !forcar) return res.status(400).json({ error: 'Nota já recebida — exclua a Receita no extrato se precisar' });
    // Nota recebida tirada de propósito (Fabio 14/11: "vamos usar apenas as notas a partir de setembro"): a receita que a PRÓPRIA nota lançou sai junto;
    // receita lançada à mão e só ligada à nota fica. Processos dela voltam a ficar em aberto, com a estimativa.
    if (nota.status === 'RECEIVED') {
      const lancadas = await receitasLancadasPelaNota(accountId, nota);
      if (lancadas.length) await prisma.transaction.deleteMany({ where: { id: { in: lancadas.map((t) => t.id) } } });
      const recebidas = await prisma.commissionProvision.findMany({ where: { accountId, noteId: nota.id, status: 'RECEIVED' } });
      for (const p of recebidas) await prisma.commissionProvision.update({ where: { id: p.id }, data: { status: 'OPEN', receivedAmount: null, receivedAt: null, transactionId: null } });
    }
    const provs = await prisma.commissionProvision.findMany({ where: { accountId, noteId: nota.id, status: 'OPEN' } });
    for (const p of provs) await prisma.commissionProvision.update({ where: { id: p.id }, data: { noteId: null, amount: p.estimatedAmount ?? p.amount, estimatedAmount: null, ratePct: p.baseAmount > 0 ? Math.round(((p.estimatedAmount ?? p.amount) / p.baseAmount) * 100 * 10_000) / 10_000 : p.ratePct } });
    await prisma.commissionNote.delete({ where: { id: nota.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir a nota' });
  }
});

export default router;
