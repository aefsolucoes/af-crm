import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export type ActivityAction =
  | 'lead_created'
  | 'lead_stage_changed'
  | 'lead_pipeline_changed'
  | 'lead_edited'
  | 'lead_status_changed'
  | 'leads_bulk_moved'
  | 'client_replied';

/**
 * Registra uma atividade da equipe. Fire-and-forget: NUNCA lança — se falhar,
 * só loga no console (o fluxo principal não pode quebrar por causa do
 * registro). `userName`/`leadName` são gravados como snapshot.
 */
export async function logActivity(input: {
  accountId: string;
  userId?: string | null;
  userName?: string | null;
  action: ActivityAction | string;
  leadId?: string | null;
  leadName?: string | null;
  summary: string;
  channel?: string | null;
}): Promise<void> {
  try {
    let userName = input.userName || null;
    if (!userName && input.userId) {
      userName = (await prisma.user.findUnique({ where: { id: input.userId }, select: { name: true } }))?.name || null;
    }
    let leadName = input.leadName || null;
    if (!leadName && input.leadId) {
      leadName = (await prisma.lead.findUnique({ where: { id: input.leadId }, select: { name: true } }))?.name || null;
    }
    await prisma.activityLog.create({
      data: {
        accountId: input.accountId,
        userId: input.userId ?? null,
        userName: userName || 'Sistema',
        action: input.action,
        leadId: input.leadId ?? null,
        leadName,
        summary: input.summary,
        channel: input.channel ?? null,
      },
    });
  } catch (err) {
    console.error('[activity] falha ao registrar (ignorado):', (err as any)?.message);
  }
}

export async function listActivity(
  accountId: string,
  opts: { limit?: number; cursor?: string; leadId?: string; userId?: string; action?: string } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const rows = await prisma.activityLog.findMany({
    where: {
      accountId,
      ...(opts.leadId ? { leadId: opts.leadId } : {}),
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.action ? { action: opts.action } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
}
