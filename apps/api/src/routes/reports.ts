import { Router, Response } from 'express';
import { PrismaClient, Prisma } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getScopeDepartmentIds } from '../services/department.service';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

/** Filtro de pipeline por setor(es), pra usar dentro de `where: { pipeline: {...} }`.
 *  Sem setor (admin, ou array vazio) = sem filtro extra. */
function pipelineDeptFilter(scopeDepartmentIds: string[]): Prisma.PipelineWhereInput {
  return scopeDepartmentIds.length ? { OR: [{ departmentId: { in: scopeDepartmentIds } }, { departmentId: null }] } : {};
}

router.get('/summary', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const scopeDepartmentIds = await getScopeDepartmentIds(accountId, req.user!.id, req.user!.role);
    const deptFilter = pipelineDeptFilter(scopeDepartmentIds);
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalLeads, newLeads, wonLeads, allLeads] = await Promise.all([
      prisma.lead.count({ where: { accountId, pipeline: deptFilter } }),
      prisma.lead.count({ where: { accountId, createdAt: { gte: startOfMonth }, pipeline: deptFilter } }),
      prisma.lead.findMany({ where: { accountId, status: 'WON', pipeline: { name: 'Concluído', ...deptFilter } }, select: { value: true } }),
      prisma.lead.findMany({ where: { accountId, pipeline: { name: 'Concluído', ...deptFilter } }, select: { value: true, status: true, createdAt: true } }),
    ]);

    const totalRevenue = wonLeads.reduce((sum, l) => sum + (l.value || 0), 0);
    const conversionRate = totalLeads > 0 ? (wonLeads.length / totalLeads) * 100 : 0;

    // Monthly revenue for last 6 months
    const monthlyRevenue = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      const revenue = allLeads
        .filter((l) => l.status === 'WON' && l.createdAt >= d && l.createdAt < end)
        .reduce((sum, l) => sum + (l.value || 0), 0);
      monthlyRevenue.push({
        month: d.toLocaleString('pt-BR', { month: 'short' }),
        revenue,
      });
    }

    res.json({ totalRevenue, newLeads, conversionRate: Math.round(conversionRate), totalLeads, monthlyRevenue });
  } catch {
    res.status(500).json({ error: 'Erro ao gerar relatório' });
  }
});

router.get('/conversion', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const scopeDepartmentIds = await getScopeDepartmentIds(accountId, req.user!.id, req.user!.role);
    const deptFilter = pipelineDeptFilter(scopeDepartmentIds);

    const stages = await prisma.stage.findMany({
      where: { pipeline: { accountId, ...deptFilter } },
      include: { _count: { select: { leads: true } } },
      orderBy: { order: 'asc' },
    });

    const topUsers = await prisma.user.findMany({
      where: { accountId },
      include: {
        leads: { where: { status: 'WON', pipeline: deptFilter }, select: { value: true } },
        _count: { select: { leads: { where: { pipeline: deptFilter } } } },
      },
    });

    const topAgents = topUsers.map((u) => ({
      name: u.name,
      leads: u._count.leads,
      revenue: u.leads.reduce((s, l) => s + (l.value || 0), 0),
    })).sort((a, b) => b.revenue - a.revenue);

    // Weekly conversion for last 8 weeks
    const now = new Date();
    const weeklyData = [];
    for (let i = 7; i >= 0; i--) {
      const start = new Date(now.getTime() - i * 7 * 86400000);
      const end = new Date(now.getTime() - (i - 1) * 7 * 86400000);
      const [total, won] = await Promise.all([
        prisma.lead.count({ where: { accountId, createdAt: { gte: start, lt: end }, pipeline: deptFilter } }),
        prisma.lead.count({ where: { accountId, status: 'WON', createdAt: { gte: start, lt: end }, pipeline: deptFilter } }),
      ]);
      weeklyData.push({
        week: `S${8 - i}`,
        rate: total > 0 ? Math.round((won / total) * 100) : 0,
      });
    }

    res.json({ stages: stages.map((s) => ({ name: s.name, count: s._count.leads, color: s.color })), topAgents, weeklyData });
  } catch {
    res.status(500).json({ error: 'Erro ao gerar relatório de conversão' });
  }
});

// GET /api/reports/fechados?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/fechados', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const now = new Date();

    const fromDate = req.query.from
      ? new Date(req.query.from as string)
      : new Date(now.getFullYear(), now.getMonth(), 1);

    const toDate = req.query.to
      ? new Date(req.query.to as string)
      : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const scopeDepartmentIds = await getScopeDepartmentIds(accountId, req.user!.id, req.user!.role);
    // Encontra o(s) funil(is) "Concluído" — um por setor. Admin vê todos;
    // colaborador só o do próprio setor.
    const concluidos = await prisma.pipeline.findMany({
      where: { accountId, name: 'Concluído', ...pipelineDeptFilter(scopeDepartmentIds) },
    });
    if (!concluidos.length) {
      return res.json({ leads: [], total: 0, totalValue: 0, missingPipeline: true });
    }

    const leads = await prisma.lead.findMany({
      where: { accountId, pipelineId: { in: concluidos.map((p) => p.id) } },
      include: {
        contact: true,
        user: { select: { id: true, name: true } },
        stage: true,
        notes: { where: { type: 'STAGE_CHANGE' }, orderBy: { createdAt: 'desc' } },
      },
    });

    // Data de entrada em "Concluído": nota de mudança de estágio mais recente
    // que menciona essa etapa; se não houver (edge case), cai para updatedAt.
    const withEnteredAt = leads.map((l) => {
      const note = l.notes.find((n) => n.content.includes('Concluído'));
      const { notes, ...lead } = l;
      return { ...lead, enteredAt: note?.createdAt || l.updatedAt };
    });

    const filtered = withEnteredAt
      .filter((l) => l.enteredAt >= fromDate && l.enteredAt <= toDate)
      .sort((a, b) => b.enteredAt.getTime() - a.enteredAt.getTime());

    const totalValue = filtered.reduce((sum, l) => sum + (l.value || 0), 0);

    res.json({ leads: filtered, total: filtered.length, totalValue });
  } catch {
    res.status(500).json({ error: 'Erro ao gerar relatório de fechados' });
  }
});

// GET /api/reports/documentacao?from=YYYY-MM-DD&to=YYYY-MM-DD
// Clientes que estão ou passaram pela etapa "Fechado" do funil "Vendas" (enviaram documentação),
// filtrados pela data em que entraram nessa etapa.
router.get('/documentacao', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const now = new Date();

    const fromDate = req.query.from
      ? new Date(req.query.from as string)
      : new Date(now.getFullYear(), now.getMonth(), 1);

    const toDate = req.query.to
      ? new Date(req.query.to as string)
      : new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);

    const vendas = await prisma.pipeline.findFirst({
      where: { accountId, name: 'Vendas' },
      include: { stages: true },
    });
    const fechadoStage = vendas?.stages.find((s) => s.name === 'Fechado');
    if (!fechadoStage) {
      return res.json({ leads: [], total: 0, totalValue: 0, missingStage: true });
    }

    // Notas de auditoria que registram a entrada na etapa "Fechado"
    const notes = await prisma.note.findMany({
      where: {
        type: 'STAGE_CHANGE',
        content: { contains: '"Fechado"' },
        lead: { is: { accountId } },
      },
      select: { leadId: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    // Um lead pode ter entrado mais de uma vez — considera a entrada mais recente
    const enteredMap = new Map<string, Date>();
    for (const n of notes) {
      if (!enteredMap.has(n.leadId)) enteredMap.set(n.leadId, n.createdAt);
    }

    const leads = await prisma.lead.findMany({
      where: { id: { in: [...enteredMap.keys()] } },
      include: {
        contact: true,
        user: { select: { id: true, name: true } },
        stage: true,
        pipeline: true,
      },
    });

    const withEnteredAt = leads.map((l) => ({ ...l, enteredAt: enteredMap.get(l.id)! }));

    const filtered = withEnteredAt
      .filter((l) => l.enteredAt >= fromDate && l.enteredAt <= toDate)
      .sort((a, b) => b.enteredAt.getTime() - a.enteredAt.getTime());

    const totalValue = filtered.reduce((sum, l) => sum + (l.value || 0), 0);

    res.json({ leads: filtered, total: filtered.length, totalValue });
  } catch {
    res.status(500).json({ error: 'Erro ao gerar relatório de documentação' });
  }
});

// Relatório Matinal: o que o usuário logado tem pra hoje.
// - Tarefas dele (vencendo hoje ou atrasadas).
// - Clientes esperando resposta: conversas do NÚMERO dele (WhatsApp vinculado)
//   cuja última mensagem foi do cliente (INBOUND).
router.get('/morning', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const userId = req.user!.id;

    const user = await prisma.user.findFirst({
      where: { id: userId, accountId },
      include: { whatsAppNumber: { select: { id: true, label: true } } },
    });
    if (!user) { res.status(404).json({ error: 'Usuário não encontrado' }); return; }

    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const tasksRaw = await prisma.task.findMany({
      where: { userId, done: false, dueAt: { lte: endOfToday } },
      include: { lead: { select: { id: true, name: true } } },
      orderBy: { dueAt: 'asc' },
      take: 50,
    });

    // Clientes esperando resposta: no número QR do usuário, OU (se ele opera
    // pela API Oficial) nas conversas da API dentro do SETOR dele.
    let clients: Array<{ leadId: string; name: string; phone: string | null; lastMessage: string; at: Date | null }> = [];
    if (user.whatsAppNumberId) {
      const leads = await prisma.lead.findMany({
        where: { accountId, whatsappNumberId: user.whatsAppNumberId, archived: false },
        include: {
          contact: { select: { name: true, whatsappPhone: true, phone: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { direction: true, content: true, createdAt: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      });
      clients = leads
        .filter((l) => l.messages[0]?.direction === 'INBOUND')
        .map((l) => ({
          leadId: l.id,
          name: l.name || l.contact?.name || 'Sem nome',
          phone: l.contact?.whatsappPhone || l.contact?.phone || null,
          lastMessage: (l.messages[0]?.content || '').slice(0, 90),
          at: l.messages[0]?.createdAt || null,
        }));
    } else if (user.operatesApiOficial) {
      // Antes daqui não checava role === 'ADMIN' (só o resto do arquivo
      // fazia) — um admin com setor(es) preenchido(s) ficava incorretamente
      // restrito. getScopeDepartmentIds já resolve isso certo (ADMIN = []).
      const scopeDepartmentIds = await getScopeDepartmentIds(accountId, userId, req.user!.role);
      const leads = await prisma.lead.findMany({
        where: {
          accountId,
          archived: false,
          // Sem setor definido: vê todos os leads da API (compatibilidade).
          pipeline: pipelineDeptFilter(scopeDepartmentIds),
        },
        include: {
          contact: { select: { name: true, whatsappPhone: true, phone: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { direction: true, content: true, createdAt: true, externalId: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      });
      clients = leads
        .filter((l) => l.messages[0]?.direction === 'INBOUND' && l.messages[0]?.externalId?.startsWith('wamid'))
        .map((l) => ({
          leadId: l.id,
          name: l.name || l.contact?.name || 'Sem nome',
          phone: l.contact?.whatsappPhone || l.contact?.phone || null,
          lastMessage: (l.messages[0]?.content || '').slice(0, 90),
          at: l.messages[0]?.createdAt || null,
        }));
    }

    res.json({
      user: { name: user.name },
      number: user.operatesApiOficial ? { id: 'API', label: 'API Oficial' } : (user.whatsAppNumber || null),
      tasks: tasksRaw.map((t) => ({
        id: t.id, title: t.title, dueAt: t.dueAt, overdue: t.dueAt < now,
        leadId: t.leadId, leadName: t.lead?.name || null,
      })),
      clients,
    });
  } catch (err) {
    console.error('[Reports] morning:', err);
    res.status(500).json({ error: 'Erro ao montar o relatório matinal' });
  }
});

export default router;
