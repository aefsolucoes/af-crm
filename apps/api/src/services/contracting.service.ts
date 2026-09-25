import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/** Leva o card pro funil de contratação do setor, na etapa "Documentação
 *  Recebida", e avisa o time do setor com o popup `contracting_lead` — o
 *  mesmo destino e aviso de quando alguém move o card pra "Fechado" na tela
 *  (PATCH /api/leads/:id/stage). Usado quando a IA confere que a
 *  documentação chegou completa. Retorna null se o funil não existir. */
export async function moveLeadToContracting(accountId: string, leadId: string, io: Io, reason: string): Promise<{ pipelineName: string; stageName: string } | null> {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: {
      pipeline: { include: { department: { select: { id: true, name: true } } } },
      whatsappNumber: { select: { department: { select: { id: true, name: true } } } },
    },
  });
  if (!lead) return null;

  const deptName = lead.pipeline.department?.name || lead.whatsappNumber?.department?.name || null;
  const deptId = lead.pipeline.departmentId || lead.whatsappNumber?.department?.id || null;
  const pipelineName = deptName === 'Home Equity' ? 'Em contratação Home Equity' : 'Em contratação';
  const pipeline = await prisma.pipeline.findFirst({
    where: { accountId, name: pipelineName },
    include: { stages: { orderBy: { order: 'asc' } } },
  });
  const stage = pipeline?.stages.find((s) => s.name === 'Documentação Recebida') || pipeline?.stages[0];
  if (!pipeline || !stage) return null;

  const moved = await prisma.lead.update({
    where: { id: leadId },
    data: {
      pipelineId: pipeline.id,
      stageId: stage.id,
      // Pedido do Fabio: a IA fica ligada até aqui; em Documentação Recebida
      // o time humano assume a contratação.
      aiAutoReplyActive: false,
      notes: { create: { content: `Lead migrado automaticamente para o funil "${pipeline.name}" (${stage.name}) — ${reason}.`, type: 'STAGE_CHANGE' } },
    },
  });
  if (io) {
    io.to(`account_${accountId}`).emit('lead_moved', { lead: moved });
    io.to(`lead:${leadId}`).emit('lead_ai_toggled', { leadId, active: false });
  }

  if (io) {
    const recipientDeptId = deptId
      ?? (await prisma.department.findFirst({ where: { accountId, name: 'Financiamento Habitacional' }, select: { id: true } }))?.id
      ?? null;
    let recipients = recipientDeptId
      ? await prisma.user.findMany({ where: { accountId, departmentIds: { has: recipientDeptId } }, select: { id: true } })
      : [];
    if (!recipients.length) recipients = await prisma.user.findMany({ where: { accountId, role: 'ADMIN' }, select: { id: true } });
    for (const u of recipients) {
      io.to(`user_${u.id}`).emit('contracting_lead', { leadId: moved.id, leadName: moved.name, pipelineName: pipeline.name });
    }
  }
  return { pipelineName: pipeline.name, stageName: stage.name };
}
