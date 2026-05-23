import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

router.get('/summary', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalLeads, newLeads, wonLeads, allLeads] = await Promise.all([
      prisma.lead.count({ where: { accountId } }),
      prisma.lead.count({ where: { accountId, createdAt: { gte: startOfMonth } } }),
      prisma.lead.findMany({ where: { accountId, status: 'WON' }, select: { value: true } }),
      prisma.lead.findMany({ where: { accountId }, select: { value: true, status: true, createdAt: true } }),
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

    const stages = await prisma.stage.findMany({
      where: { pipeline: { accountId } },
      include: { _count: { select: { leads: true } } },
      orderBy: { order: 'asc' },
    });

    const topUsers = await prisma.user.findMany({
      where: { accountId },
      include: {
        leads: { where: { status: 'WON' }, select: { value: true } },
        _count: { select: { leads: true } },
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
        prisma.lead.count({ where: { accountId, createdAt: { gte: start, lt: end } } }),
        prisma.lead.count({ where: { accountId, status: 'WON', createdAt: { gte: start, lt: end } } }),
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

export default router;
