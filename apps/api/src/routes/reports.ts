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

/** Conversão do Fabio: cliente que ENVIOU A DOCUMENTAÇÃO (foi pra "Fechado"
 *  → funil de contratação) — não o status "Ganho". Estar em "Em contratação"
 *  ou "Concluído" conta; a data de entrada vem da nota de "Fechado" ou da
 *  migração pro funil de contratação (a mais antiga). */
const CONTRACT_PIPELINE: Prisma.PipelineWhereInput = { OR: [{ name: { startsWith: 'Em contrata' } }, { name: 'Concluído' }] };
async function contractEntries(accountId: string, deptFilter: Prisma.PipelineWhereInput): Promise<Map<string, Date>> {
  // Entrada na contratação: foi pra "Fechado", migração automática ou
  // movido pra "Em contratação…" (Fabio 30/09: quem foi direto pra contratação
  // também conta). "Movido do funil "Em contratação" para …" é SAÍDA — não conta.
  const notes = await prisma.note.findMany({
    where: {
      OR: [{ content: { contains: '→ "Fechado"' } }, { content: { contains: 'para o funil "Em contrata' } }, { content: { contains: 'para "Em contrata' } }],
      lead: { is: { accountId, pipeline: deptFilter } },
    },
    select: { leadId: true, createdAt: true },
  });
  const first = new Map<string, Date>();
  for (const n of notes) if (!first.has(n.leadId) || n.createdAt < first.get(n.leadId)!) first.set(n.leadId, n.createdAt);
  // Quem está na contratação/concluído sem nota (movido antes do histórico
  // existir): usa a data em que entrou na etapa atual.
  const semNota = await prisma.lead.findMany({
    where: { accountId, id: { notIn: [...first.keys()] }, pipeline: { AND: [deptFilter, CONTRACT_PIPELINE] } },
    select: { id: true, stageEnteredAt: true, createdAt: true },
  });
  for (const l of semNota) first.set(l.id, l.stageEnteredAt || l.createdAt);
  return first;
}

router.get('/summary', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const scopeDepartmentIds = await getScopeDepartmentIds(accountId, req.user!.id, req.user!.role);
    const deptFilter = pipelineDeptFilter(scopeDepartmentIds);
    const now = new Date();
    // Início do mês no horário de Brasília (servidor em UTC).
    const [smY, smM] = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(now).split('-');
    const startOfMonth = new Date(`${smY}-${smM}-01T00:00:00-03:00`);

    // Leads = só cards num setor — Caixa de Entrada (corretores, não
    // triados) fica de fora, igual ao relatório mensal (Fabio 30/09).
    const clientFilter: Prisma.PipelineWhereInput = { AND: [deptFilter, { departmentId: { not: null } }] };
    const [totalLeads, newLeads, wonLeads, allLeads] = await Promise.all([
      prisma.lead.count({ where: { accountId, pipeline: clientFilter } }),
      prisma.lead.count({ where: { accountId, createdAt: { gte: startOfMonth }, pipeline: clientFilter } }),
      prisma.lead.findMany({ where: { accountId, status: 'WON', pipeline: { name: 'Concluído', ...deptFilter } }, select: { value: true } }),
      prisma.lead.findMany({ where: { accountId, pipeline: { name: 'Concluído', ...deptFilter } }, select: { value: true, status: true, createdAt: true } }),
    ]);

    const totalRevenue = wonLeads.reduce((sum, l) => sum + (l.value || 0), 0);

    // Documentação enviada (conversão) e perdidos — total e no mês.
    const [docsSent, lost, entries, lostNotes] = await Promise.all([
      prisma.lead.count({ where: { accountId, pipeline: { AND: [deptFilter, CONTRACT_PIPELINE] } } }),
      prisma.lead.count({ where: { accountId, status: 'LOST', pipeline: deptFilter } }),
      contractEntries(accountId, deptFilter),
      prisma.note.findMany({
        where: { content: { contains: 'funil "Perdidos"' }, createdAt: { gte: startOfMonth }, lead: { is: { accountId, status: 'LOST', pipeline: deptFilter } } },
        select: { leadId: true },
        distinct: ['leadId'],
      }),
    ]);
    const docsSentMonth = [...entries.values()].filter((d) => d >= startOfMonth).length;
    const lostMonth = lostNotes.length;
    const conversionRate = totalLeads > 0 ? (docsSent / totalLeads) * 100 : 0;

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

    res.json({ totalRevenue, newLeads, conversionRate: Math.round(conversionRate * 10) / 10, totalLeads, monthlyRevenue, docsSent, docsSentMonth, lost, lostMonth });
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

    // Conversão semanal (8 semanas): clientes que enviaram a documentação
    // na semana ÷ leads novos da semana.
    const now = new Date();
    const entries = await contractEntries(accountId, deptFilter);
    const weeklyData = [];
    for (let i = 7; i >= 0; i--) {
      const start = new Date(now.getTime() - (i + 1) * 7 * 86400000);
      const end = new Date(now.getTime() - i * 7 * 86400000);
      const total = await prisma.lead.count({ where: { accountId, createdAt: { gte: start, lt: end }, pipeline: deptFilter } });
      const converted = [...entries.values()].filter((d) => d >= start && d < end).length;
      weeklyData.push({
        week: `S${8 - i}`,
        rate: total > 0 ? Math.round((converted / total) * 1000) / 10 : 0,
      });
    }

    res.json({ stages: stages.map((s) => ({ name: s.name, count: s._count.leads, color: s.color })), topAgents, weeklyData });
  } catch {
    res.status(500).json({ error: 'Erro ao gerar relatório de conversão' });
  }
});

// GET /api/reports/monthly?months=6&departmentId=&mode=event|cohort —
// relatório mensal (Fabio 30/09): clientes que ENTRARAM, foram APROVADOS
// (pré-análise), MANDARAM A DOCUMENTAÇÃO (Fechado/contratação) e foram
// PERDIDOS. Só conta card que está num setor — a Caixa de Entrada fica de fora
// (corretor que fala com a gente fica lá e não é cliente).
//  - event: cada coisa no mês em que aconteceu.
//  - cohort: dos que ENTRARAM no mês, quantos já foram aprovados / mandaram a
//    documentação / foram perdidos (a qualquer tempo).
// Aprovado/documentação/perdido vêm do histórico de mudanças de etapa do card,
// que existe desde 31/08/2026.
router.get('/monthly', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const scopeDepartmentIds = await getScopeDepartmentIds(accountId, req.user!.id, req.user!.role);
    const scope = pipelineDeptFilter(scopeDepartmentIds);
    const dept = req.query.departmentId ? String(req.query.departmentId) : '';
    const deptFilter: Prisma.PipelineWhereInput = { AND: [scope, dept ? { departmentId: dept } : { departmentId: { not: null } }] };
    const months = Math.min(Math.max(Number(req.query.months) || 6, 1), 24);
    const mode = req.query.mode === 'cohort' ? 'cohort' : 'event';

    // Meses no horário de Brasília (o servidor roda em UTC, 3h à frente).
    const monthKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(d);
    const [cy, cm] = monthKey(new Date()).split('-').map(Number);
    const starts: Date[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const y = cy + Math.floor((cm - 1 - i) / 12);
      const m = ((cm - 1 - i) % 12 + 12) % 12 + 1;
      starts.push(new Date(`${y}-${String(m).padStart(2, '0')}-01T00:00:00-03:00`));
    }
    const from = starts[0];

    const leadScope = { accountId, pipeline: deptFilter };
    const [created, approvalNotes, entries, lostNotes] = await Promise.all([
      prisma.lead.findMany({ where: { ...leadScope, createdAt: { gte: from } }, select: { id: true, createdAt: true, status: true } }),
      prisma.note.findMany({
        where: { OR: [{ content: { contains: '→ "Aprovado Pr' } }, { content: { contains: '→ "Aguardando Documenta' } }], lead: { is: leadScope } },
        select: { leadId: true, createdAt: true },
      }),
      contractEntries(accountId, deptFilter),
      prisma.note.findMany({
        where: { OR: [{ content: { contains: 'funil "Perdidos"' } }, { content: { contains: 'Status alterado para "Perdido"' } }], lead: { is: { ...leadScope, status: 'LOST' } } },
        select: { leadId: true, createdAt: true },
      }),
    ]);
    // Aprovado = primeira aprovação registrada; quem foi direto pra
    // contratação sem essa nota conta como aprovado na entrada da contratação.
    const approvedAt = new Map<string, Date>();
    for (const n of approvalNotes) if (!approvedAt.has(n.leadId) || n.createdAt < approvedAt.get(n.leadId)!) approvedAt.set(n.leadId, n.createdAt);
    for (const [leadId, d] of entries) if (!approvedAt.has(leadId) || d < approvedAt.get(leadId)!) approvedAt.set(leadId, d);
    // Está hoje em etapa de aprovado sem registro (movido antes do histórico):
    // usa a data em que entrou na etapa atual.
    const approvedNow = await prisma.lead.findMany({
      where: { ...leadScope, id: { notIn: [...approvedAt.keys()] }, stage: { OR: [{ name: { startsWith: 'Aprovado Pr' } }, { name: { startsWith: 'Aguardando Documenta' } }] } },
      select: { id: true, stageEnteredAt: true, createdAt: true },
    });
    for (const l of approvedNow) approvedAt.set(l.id, l.stageEnteredAt || l.createdAt);
    const lostAt = new Map<string, Date>();
    for (const n of lostNotes) if (!lostAt.has(n.leadId) || n.createdAt > lostAt.get(n.leadId)!) lostAt.set(n.leadId, n.createdAt);

    // Guarda QUEM entra em cada número (Fabio 30/09: passar o mouse e ver os
    // clientes com valores).
    const push = (m: Map<string, string[]>, k: string, id: string) => m.set(k, [...(m.get(k) || []), id]);
    const cEntered = new Map<string, string[]>();
    const cApproved = new Map<string, string[]>();
    const cDocs = new Map<string, string[]>();
    const cLost = new Map<string, string[]>();
    for (const l of created) push(cEntered, monthKey(l.createdAt), l.id);
    if (mode === 'event') {
      for (const [id, d] of approvedAt) push(cApproved, monthKey(d), id);
      for (const [id, d] of entries) push(cDocs, monthKey(d), id);
      for (const [id, d] of lostAt) push(cLost, monthKey(d), id);
    } else {
      for (const l of created) {
        const k = monthKey(l.createdAt);
        if (approvedAt.has(l.id)) push(cApproved, k, l.id);
        if (entries.has(l.id)) push(cDocs, k, l.id);
        if (l.status === 'LOST') push(cLost, k, l.id);
      }
    }
    const monthKeys = new Set(starts.map(monthKey));
    const ids = new Set<string>();
    for (const m of [cEntered, cApproved, cDocs, cLost]) for (const [k, list] of m) if (monthKeys.has(k)) list.forEach((id) => ids.add(id));
    const info = new Map<string, { id: string; name: string; value: number }>();
    for (const l of await prisma.lead.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, value: true, customFields: true } })) {
      const cf = (l.customFields || {}) as Record<string, unknown>;
      // Gravado de vários jeitos: "400000", "400.000", "400.000,00", "1508.38".
      const raw = String(cf.valor_credito ?? '').replace(/[^\d.,]/g, '');
      const credito = !raw ? 0
        : /,\d{1,2}$/.test(raw) ? Number(raw.replace(/\./g, '').replace(',', '.'))
        : /^\d{1,3}(\.\d{3})+$/.test(raw) ? Number(raw.replace(/\./g, ''))
        : Number(raw.replace(/,/g, '')) || 0;
      info.set(l.id, { id: l.id, name: String(cf.participante_1 || l.name || '').trim() || l.name, value: credito || Number(l.value) || 0 });
    }
    const people = (list?: string[]) => (list || []).map((id) => info.get(id)).filter(Boolean).sort((a, b) => b!.value - a!.value) as { id: string; name: string; value: number }[];

    const rows = starts.map((d) => {
      const k = monthKey(d);
      return {
        month: k,
        label: d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' }),
        entered: cEntered.get(k)?.length || 0,
        approved: cApproved.get(k)?.length || 0,
        docsSent: cDocs.get(k)?.length || 0,
        lost: cLost.get(k)?.length || 0,
        people: { entered: people(cEntered.get(k)), approved: people(cApproved.get(k)), docsSent: people(cDocs.get(k)), lost: people(cLost.get(k)) },
      };
    }).reverse();
    res.json({ rows, mode, historySince: '2026-08-31' });
  } catch (err: any) {
    console.error('[Relatório mensal]', err?.message);
    res.status(500).json({ error: 'Erro ao gerar o relatório mensal' });
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
// - Clientes esperando resposta: conversas da API Oficial (marcada pra ele em
//   Usuários) cuja última mensagem foi do cliente (INBOUND).
router.get('/morning', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const userId = req.user!.id;

    const user = await prisma.user.findFirst({ where: { id: userId, accountId } });
    if (!user) { res.status(404).json({ error: 'Usuário não encontrado' }); return; }

    const now = new Date();
    const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);

    const tasksRaw = await prisma.task.findMany({
      where: { userId, done: false, dueAt: { lte: endOfToday } },
      include: { lead: { select: { id: true, name: true } } },
      orderBy: { dueAt: 'asc' },
      take: 50,
    });

    type ClientRow = { leadId: string; name: string; phone: string | null; lastMessage: string; at: Date | null };
    const clientsByLead = new Map<string, ClientRow>();
    const numbers: { id: string; label: string }[] = [];

    if (user.whatsAppNumberIds.includes('API')) {
      numbers.push({ id: 'API', label: 'API Oficial' });
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
      for (const l of leads) {
        if (l.messages[0]?.direction !== 'INBOUND' || !l.messages[0]?.externalId?.startsWith('wamid')) continue;
        clientsByLead.set(l.id, {
          leadId: l.id,
          name: l.name || l.contact?.name || 'Sem nome',
          phone: l.contact?.whatsappPhone || l.contact?.phone || null,
          lastMessage: (l.messages[0]?.content || '').slice(0, 90),
          at: l.messages[0]?.createdAt || null,
        });
      }
    }

    const clients = Array.from(clientsByLead.values()).sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0));

    res.json({
      user: { name: user.name },
      numbers,
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
