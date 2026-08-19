import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Formato do JSON guardado em SalesBot.flow — espelha
// apps/web/components/salesbot/node-types.tsx (só os 6 tipos do MVP:
// send_message, pause, condition, action, validation, stop_salesbot). Ordem
// do array = próximo passo por padrão; só "condition" desvia (trueStepId/
// falseStepId), permitindo até voltar pra um passo anterior (loop de
// validação, por ex.).
export interface SalesBotFlow {
  trigger: { keywords: string[] };
  steps: SalesBotStep[];
}

export interface SalesBotStep {
  id: string;
  type: 'send_message' | 'pause' | 'condition' | 'action' | 'validation' | 'stop_salesbot';
  config: Record<string, unknown>;
}

export const EMPTY_FLOW: SalesBotFlow = { trigger: { keywords: [] }, steps: [] };

function stepCount(flow: unknown): number {
  const steps = (flow as SalesBotFlow)?.steps;
  return Array.isArray(steps) ? steps.length : 0;
}

export async function listSalesBots(accountId: string) {
  const bots = await prisma.salesBot.findMany({
    where: { accountId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, description: true, active: true, flow: true, createdAt: true, updatedAt: true },
  });
  return bots.map(({ flow, ...rest }) => ({ ...rest, stepCount: stepCount(flow) }));
}

export async function getSalesBot(id: string, accountId: string) {
  return prisma.salesBot.findFirst({ where: { id, accountId } });
}

export async function createSalesBot(accountId: string, data: { name: string; description?: string }) {
  return prisma.salesBot.create({
    data: {
      accountId,
      name: data.name,
      description: data.description || null,
      active: false,
      flow: EMPTY_FLOW as any,
    },
  });
}

export async function updateSalesBot(
  id: string,
  accountId: string,
  data: { name?: string; description?: string | null; active?: boolean; flow?: SalesBotFlow }
) {
  const existing = await prisma.salesBot.findFirst({ where: { id, accountId } });
  if (!existing) return null;
  return prisma.salesBot.update({
    where: { id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.active !== undefined ? { active: data.active } : {}),
      ...(data.flow !== undefined ? { flow: data.flow as any } : {}),
    },
  });
}

export async function deleteSalesBot(id: string, accountId: string) {
  const existing = await prisma.salesBot.findFirst({ where: { id, accountId } });
  if (!existing) return false;
  // Runs/logs referenciam salesBotId com onDelete: Restrict (padrão do
  // Prisma) — apaga o histórico de execuções primeiro pra não travar no bot
  // que já rodou de verdade.
  await prisma.salesBotRunLog.deleteMany({ where: { run: { salesBotId: id } } });
  await prisma.salesBotRun.deleteMany({ where: { salesBotId: id } });
  await prisma.salesBot.delete({ where: { id } });
  return true;
}

export async function listSalesBotRuns(salesBotId: string, accountId: string) {
  const bot = await prisma.salesBot.findFirst({ where: { id: salesBotId, accountId } });
  if (!bot) return null;
  const runs = await prisma.salesBotRun.findMany({
    where: { salesBotId },
    orderBy: { updatedAt: 'desc' },
    take: 50,
    include: { logs: { orderBy: { createdAt: 'asc' } } },
  });
  const leadIds = Array.from(new Set(runs.map((r) => r.leadId)));
  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true } });
  const leadNameById = new Map(leads.map((l) => [l.id, l.name]));
  return runs.map((r) => ({ ...r, leadName: leadNameById.get(r.leadId) || '—' }));
}
