import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

export const MOTIVO_NUMERO_INEXISTENTE = 'Número de telefone inexistente (sem WhatsApp)';

/**
 * CLIENTE QUE ENTROU COM NÚMERO QUE NÃO EXISTE VAI PRA PERDIDOS (Fabio 09/11). A Meta avisa com o código 131026 no webhook de status.
 * Só mexe quando nada prova que o número funciona ou que o cliente está em contato: nunca escreveu (o aviso do site não conta) e nenhuma mensagem foi entregue.
 * O 131026 também aparece pra quem tem WhatsApp desatualizado, e por isso quem já conversou fica onde está.
 */
export async function perdidoSeNumeroInexistente(leadId: string, io: any): Promise<boolean> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, name: true, accountId: true, status: true, archived: true, isGroup: true, pipeline: { select: { departmentId: true } } },
  });
  if (!lead || lead.status !== 'OPEN' || lead.archived || lead.isGroup) return false;
  const prova = await prisma.message.findFirst({
    where: {
      leadId,
      OR: [
        { direction: 'INBOUND', NOT: [{ content: { contains: 'Proposta preenchida no site' } }, { content: { startsWith: '🔔' } }] },
        { direction: 'OUTBOUND', channel: { not: 'EMAIL' }, status: { in: ['DELIVERED', 'READ'] } },
      ],
    },
    select: { id: true },
  });
  if (prova) return false;

  const { updateLead } = require('./lead.service') as typeof import('./lead.service');
  const { moveLeadToPerdidos } = require('./named-pipeline.service') as typeof import('./named-pipeline.service');
  await updateLead(lead.id, lead.accountId, { status: 'LOST', lostReason: MOTIVO_NUMERO_INEXISTENTE }, io);
  await moveLeadToPerdidos({ accountId: lead.accountId, leadId: lead.id, departmentId: lead.pipeline?.departmentId, byName: 'CRM', userId: null, motivo: MOTIVO_NUMERO_INEXISTENTE, io });
  logActivity({ accountId: lead.accountId, userId: null, userName: 'CRM', action: 'lead_status_changed', leadId: lead.id, leadName: lead.name, summary: `marcou o card como Perdido: "${MOTIVO_NUMERO_INEXISTENTE}"` });
  return true;
}
