import { prisma } from '../lib/prisma';

/**
 * Ligação do cliente que ninguém atendeu (Fabio 29/10, Jaime: "sempre que um cliente ligar e não atendermos, avisa o cliente que irei ligar
 * daqui 20 min, pois estamos em outra ligação, e coloca um sinal de alerta para a Andreia ver esse card e ligar").
 * - Espera 1 min: se alguém da equipe já escreveu ou retornou nesse meio tempo, não manda nada.
 * - Mensagem ao cliente só das 07h às 21h e uma vez a cada 30 min (cliente que liga 3 vezes seguidas recebe uma só).
 * - Alerta: tag "📞 Retornar ligação" no card + tarefa da Andreia pra daqui 20 min (o push sai na hora) + push agora + nota.
 *   A tag sai quando a ligação de retorno é atendida (clearMissedCallAlert).
 */
export const RETORNAR_TAG = '📞 Retornar ligação';
const ESPERA_MS = 60_000;
const RETORNO_MIN = 20;
const UMA_VEZ_MS = 30 * 60_000;

export function scheduleMissedCallFollowUp(accountId: string, leadId: string, io?: any) {
  const endedAt = new Date();
  setTimeout(() => { handleMissedCall(accountId, leadId, endedAt, io).catch((e) => console.error('[Ligação perdida]', e?.message || e)); }, ESPERA_MS);
}

async function handleMissedCall(accountId: string, leadId: string, endedAt: Date, io?: any) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, tags: true, customFields: true } });
  if (!lead) return;
  // Alguém da equipe já respondeu (mensagem) ou já ligou de volta depois da ligação perdida: não manda nada.
  const respondeu = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', createdAt: { gte: endedAt } }, select: { id: true } });
  const retornou = await prisma.call.findFirst({ where: { leadId, direction: 'OUTBOUND', startedAt: { gte: endedAt } }, select: { id: true } });
  if (retornou) return;

  const cf = (lead.customFields || {}) as Record<string, any>;
  const ultimo = cf._missedCallReplyAt ? new Date(cf._missedCallReplyAt).getTime() : 0;
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  let enviado = false;
  if (!respondeu && Date.now() - ultimo > UMA_VEZ_MS && inNoticeWindow() && (await whatsappWindowOpen(leadId))) {
    const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
    const nome = callableFirstName(cf.falando_com, cf.participante_1, lead.name);
    const texto = `Oi${nome ? `, ${nome}` : ''}! Vi sua ligação, mas estamos em outra ligação agora. Te ligo em uns ${RETORNO_MIN} minutos, tudo bem?`;
    const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
    const r = await sendOutboundWhatsApp({ accountId, leadId, content: texto, io }).catch((e: any) => ({ success: false, error: e?.message }));
    enviado = !!(r as any)?.success;
  }

  // Alerta pra Andreia (quem liga). Sem Andreia, fica com o responsável do card.
  const andreia = await prisma.user.findFirst({ where: { accountId, name: { startsWith: 'Andreia', mode: 'insensitive' } }, select: { id: true, name: true } });
  const dono = andreia || (await prisma.lead.findUnique({ where: { id: leadId }, select: { user: { select: { id: true, name: true } } } }).catch(() => null))?.user || null;
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { tags: true, customFields: true } });
  const tags = fresh?.tags || [];
  await prisma.lead.update({
    where: { id: leadId },
    data: {
      tags: tags.includes(RETORNAR_TAG) ? tags : [...tags, RETORNAR_TAG],
      ...(enviado ? { customFields: { ...((fresh?.customFields || {}) as Record<string, any>), _missedCallReplyAt: new Date().toISOString() } as any } : {}),
    },
  });
  const jaTemTarefa = dono ? await prisma.task.findFirst({ where: { leadId, userId: dono.id, done: false, title: { startsWith: '📞 Retornar ligação' } }, select: { id: true } }) : null;
  if (dono && !jaTemTarefa) {
    await prisma.task.create({ data: { title: `📞 Retornar ligação de ${lead.name}`, dueAt: new Date(Date.now() + RETORNO_MIN * 60_000), userId: dono.id, leadId } });
  }
  await prisma.note.create({ data: { leadId, type: 'CALL', content: `📞 Ligação do cliente não atendida. ${enviado ? `Avisei que retornamos em ${RETORNO_MIN} min.` : 'Não mandei mensagem (fora do horário, janela fechada ou a equipe já respondeu).'} Alerta pra ${dono?.name || 'a equipe'} retornar a ligação.` } }).catch(() => {});
  try {
    (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: '📞 Retornar ligação', body: `${lead.name} ligou e ninguém atendeu${enviado ? ` — avisei que você liga em ${RETORNO_MIN} min` : ''}`, leadId }, dono ? [dono.id] : undefined).catch(() => {});
  } catch { /* push é só aviso */ }
  io?.to(`account_${accountId}`).emit('lead_updated', { leadId });
}

/** Ligação de retorno atendida (ou a pessoa resolveu): tira o alerta do card e fecha a tarefa. */
export async function clearMissedCallAlert(leadId: string | null) {
  if (!leadId) return;
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { tags: true } });
  if (!l?.tags?.includes(RETORNAR_TAG)) return;
  await prisma.lead.update({ where: { id: leadId }, data: { tags: l.tags.filter((t) => t !== RETORNAR_TAG) } });
  await prisma.task.updateMany({ where: { leadId, done: false, title: { startsWith: '📞 Retornar ligação' } }, data: { done: true } });
}
