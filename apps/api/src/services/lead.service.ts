import { PrismaClient, LeadStatus } from '@prisma/client';
import { normalizeClientName } from '../lib/text';
import { logActivity } from './activity.service';

const prisma = new PrismaClient();

export async function getLeads(
  accountId: string,
  pipelineId?: string,
  stageId?: string,
  archived = false,
  isAdmin = true,
  /** Setor(es) do usuário logado (não-admin) — filtra pra só os leads cujo
   *  FUNIL pertence a algum deles (mais os "órfãos", sem setor definido).
   *  Array vazio = sem restrição (admin, ou colaborador sem setor ainda). */
  scopeDepartmentIds: string[] = [],
) {
  return prisma.lead.findMany({
    where: {
      accountId,
      // Grupos do WhatsApp não são cards de venda — ficam só na Inbox, não no Funil.
      isGroup: false,
      // Só admin enxerga arquivados e leads ganhos (WON); demais nunca.
      archived: isAdmin ? archived : false,
      ...(pipelineId && { pipelineId }),
      ...(stageId && { stageId }),
      ...(isAdmin ? {} : { status: { not: LeadStatus.WON } }),
      ...(scopeDepartmentIds.length ? { pipeline: { OR: [{ departmentId: { in: scopeDepartmentIds } }, { departmentId: null }] } } : {}),
    },
    include: {
      stage: true,
      user: { select: { id: true, name: true, email: true } },
      contact: true,
      company: true,
      messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      _count: { select: { messages: { where: { read: false, direction: 'INBOUND' } } } },
    },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getLeadById(id: string, accountId: string) {
  return prisma.lead.findFirst({
    where: { id, accountId },
    include: {
      stage: true,
      pipeline: { include: { stages: { orderBy: { order: 'asc' } }, department: { select: { id: true, name: true } } } },
      user: { select: { id: true, name: true, email: true } },
      contact: true,
      company: true,
      whatsappNumber: { select: { id: true, label: true, phone: true } },
      tasks: { include: { user: { select: { id: true, name: true } } }, orderBy: { dueAt: 'asc' } },
      notes: { orderBy: { createdAt: 'desc' }, include: { user: { select: { id: true, name: true } } } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
}

export async function createLead(data: {
  name: string;
  value?: number;
  pipelineId: string;
  stageId: string;
  userId: string;
  contactId?: string;
  companyId?: string;
  tags?: string[];
  accountId: string;
  customFields?: Record<string, unknown>;
}) {
  const { customFields, ...rest } = data;
  return prisma.lead.create({
    data: { ...rest, name: normalizeClientName(rest.name), ...(customFields ? { customFields: customFields as any } : {}) },
    include: { stage: true, user: { select: { id: true, name: true } } },
  });
}

export async function updateLead(id: string, accountId: string, data: Partial<{
  name: string;
  value: number;
  status: LeadStatus;
  lostReason: string | null;
  userId: string;
  contactId: string;
  companyId: string;
  tags: string[];
  customFields: Record<string, unknown>;
  isGroup: boolean;
}>) {
  return prisma.lead.update({
    where: { id },
    data: { ...data, ...(data.name !== undefined ? { name: normalizeClientName(data.name) } : {}) } as any,
  });
}

export async function updateLeadStage(id: string, accountId: string, stageId: string) {
  // Move o FUNIL junto com o estágio. Antes só o stageId era gravado: mover um
  // lead pra um estágio de outro funil (a automação e o SalesBot deixam
  // escolher qualquer estágio, de qualquer funil) deixava o card com
  // pipelineId de um funil e stageId de outro — some da tela, porque cada
  // funil só mostra os estágios dele. Dentro do mesmo funil nada muda: o
  // pipelineId gravado é o mesmo que já estava lá.
  const stage = await prisma.stage.findFirst({
    where: { id: stageId, pipeline: { accountId } },
    select: { pipelineId: true },
  });
  if (!stage) throw new Error('Estágio não encontrado nesta conta');

  return prisma.lead.update({
    where: { id },
    data: { stageId, pipelineId: stage.pipelineId },
    include: { stage: true },
  });
}

/**
 * Correção do incidente 2026-08 (conversas separadas por número): junta de
 * volta os cards que se duplicaram só porque o mesmo contato falou por dois
 * números diferentes. Une TODOS os leads (não-grupo) de um mesmo contactId
 * num único card — mantém o que tem mais mensagens, move mensagens/tarefas/
 * notas dos demais para ele, mescla campos e valor, e apaga os duplicados.
 */
export async function mergeLeadsBySameContact(accountId: string): Promise<{ merged: number; groups: number }> {
  const leads = await prisma.lead.findMany({
    where: { accountId, isGroup: false, contactId: { not: null } },
    include: { _count: { select: { messages: true } } },
  });

  const byContact = new Map<string, typeof leads>();
  for (const l of leads) {
    if (!l.contactId) continue;
    if (!byContact.has(l.contactId)) byContact.set(l.contactId, [] as any);
    byContact.get(l.contactId)!.push(l);
  }

  let merged = 0;
  let groups = 0;
  for (const [, group] of byContact) {
    if (group.length < 2) continue;
    groups++;

    // Mantém o card com mais mensagens (desempate: mais recente).
    const sorted = [...group].sort((a, b) =>
      (b._count.messages - a._count.messages) || (b.updatedAt.getTime() - a.updatedAt.getTime()));
    const keep = sorted[0];
    const rest = sorted.slice(1);

    for (const source of rest) {
      const mergedCF = { ...((source.customFields as any) || {}), ...((keep.customFields as any) || {}) };
      const mergedValue = Math.max(keep.value || 0, source.value || 0) || undefined;
      try {
        await prisma.$transaction([
          prisma.message.updateMany({ where: { leadId: source.id }, data: { leadId: keep.id } }),
          prisma.task.updateMany({ where: { leadId: source.id }, data: { leadId: keep.id } }),
          prisma.note.updateMany({ where: { leadId: source.id }, data: { leadId: keep.id } }),
          prisma.lead.update({ where: { id: keep.id }, data: { customFields: mergedCF as any, value: mergedValue } }),
          prisma.note.create({
            data: {
              leadId: keep.id,
              content: `Card unificado automaticamente com "${source.name}" (conversa que havia se separado por número de WhatsApp).`,
              type: 'DATA_EDIT',
            },
          }),
          prisma.lead.delete({ where: { id: source.id } }),
        ]);
        merged++;
      } catch (err) {
        console.error('[Merge automático] Falhou para', source.id, err);
      }
    }
  }

  return { merged, groups };
}

export async function deleteLead(id: string, accountId: string) {
  return prisma.lead.delete({ where: { id } });
}

/** true se "nome" não é um nome de verdade — é só o telefone (fallback usado
 *  quando um lead nasce sem nome real, ex.: mensagem recebida sem perfil).
 *  Usado no merge pra nunca manter um nome assim se o outro lado tiver nome
 *  de verdade. */
function looksLikePhoneOnly(name: string | null | undefined): boolean {
  if (!name || !name.trim()) return true;
  const digits = name.replace(/\D/g, '');
  return digits.length >= 8 && digits.length >= name.replace(/\s/g, '').length - 2;
}

/** Une o lead `sourceId` dentro do lead `keepId` — mensagens, tarefas e
 *  notas migram, campos/valor/nome/estágio são mesclados com prioridade pro
 *  dado mais completo/recente, e o source é excluído. Compartilhada entre a
 *  rota manual (POST /:id/merge, usuário escolhe os dois) e o job automático
 *  por telefone (autoMergeDuplicatesByPhone) — `userId` null = ação do
 *  sistema. Nunca lança: quem chama decide o que fazer com {ok:false}. */
export async function mergeLeadPair(
  accountId: string,
  keepId: string,
  sourceId: string,
  userId: string | null,
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null,
): Promise<{ ok: boolean; lead?: unknown; error?: string }> {
  try {
    const [keep, source] = await Promise.all([
      prisma.lead.findUnique({ where: { id: keepId, accountId }, include: { contact: true } }),
      prisma.lead.findUnique({ where: { id: sourceId, accountId } }),
    ]);
    if (!keep || !source) return { ok: false, error: 'Lead não encontrado' };

    const mergedCF: Record<string, unknown> = { ...((source.customFields as any) || {}) };
    for (const [k, v] of Object.entries((keep.customFields as any) || {})) {
      if (v !== undefined && v !== null && String(v).trim() !== '') mergedCF[k] = v;
    }

    const mergedValue = Math.max(keep.value || 0, source.value || 0) || undefined;

    const useSourceName = looksLikePhoneOnly(keep.name) && !looksLikePhoneOnly(source.name);
    const finalName = useSourceName ? source.name : keep.name;

    const useSourceStage = source.updatedAt > keep.updatedAt
      && (source.pipelineId !== keep.pipelineId || source.stageId !== keep.stageId);

    await prisma.$transaction([
      prisma.message.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      prisma.task.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      prisma.note.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      prisma.lead.update({
        where: { id: keepId },
        data: {
          name: finalName, customFields: mergedCF as any, value: mergedValue,
          ...(useSourceStage ? { pipelineId: source.pipelineId, stageId: source.stageId } : {}),
        },
      }),
      ...(useSourceName && keep.contactId
        ? [prisma.contact.update({ where: { id: keep.contactId }, data: { name: finalName } })]
        : []),
      prisma.note.create({
        data: {
          leadId: keepId,
          content: `Lead unificado com "${source.name}" (ID: ${sourceId}). Mensagens, tarefas e notas foram migradas.`
            + (useSourceStage ? ' Estágio/funil atualizado pro do lead mais recente.' : '')
            + (userId ? '' : ' (unificação automática por telefone)'),
          type: 'DATA_EDIT',
          ...(userId ? { userId } : {}),
        },
      }),
      prisma.lead.delete({ where: { id: sourceId } }),
    ]);

    logActivity({
      accountId, userId, userName: userId ? undefined : 'Sistema',
      action: 'lead_merged', leadId: keepId, leadName: finalName || keep.name,
      summary: userId
        ? `unificou "${source.name}" neste card — mensagens, tarefas e notas migradas`
        : `unificou automaticamente "${source.name}" (mesmo telefone) neste card`,
    });

    const updated = await prisma.lead.findUnique({ where: { id: keepId } });
    io?.to(`account_${accountId}`).emit('lead_merged', { keepId, sourceId, lead: updated });
    return { ok: true, lead: updated };
  } catch (err) {
    console.error('[Merge]', err);
    return { ok: false, error: 'Erro ao unificar leads' };
  }
}

/** Une automaticamente leads duplicados que têm o MESMO TELEFONE (últimos 8
 *  dígitos, ignorando formatação) — só telefone, nunca nome (nome duplicado
 *  não significa a mesma pessoa). Pedido real: campanha faz o 1º contato
 *  (webhook do site), cliente preenche a proposta e manda pelo WhatsApp —
 *  isso criava um 2º card por causa de um bug de comparação de telefone (já
 *  corrigido em whatsapp.service.ts). Esse job aqui é a rede de segurança:
 *  roda periodicamente e une qualquer duplicata que ainda escapar (ou que já
 *  existia antes do fix). Mantém o card com mais mensagens (desempate: mais
 *  dado preenchido, depois mais antigo) — mesma lógica de
 *  GET /api/leads/duplicate-groups, só que só por telefone e sem precisar de
 *  alguém abrir a tela. */
export async function autoMergeDuplicatesByPhone(
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null,
): Promise<{ merged: number; groups: number }> {
  const leads = await prisma.lead.findMany({
    where: { archived: false, isGroup: false, status: 'OPEN' },
    include: { contact: true, _count: { select: { messages: true } } },
  });

  function phoneCoreOf(l: (typeof leads)[number]): string | null {
    const cf = (l.customFields || {}) as Record<string, string>;
    const raw = (cf.telefone_1 || l.contact?.phone || l.contact?.whatsappPhone || '').replace(/\D/g, '');
    return raw.length >= 8 ? raw.slice(-8) : null;
  }

  const groups = new Map<string, typeof leads>();
  for (const l of leads) {
    const core = phoneCoreOf(l);
    if (!core) continue;
    const key = `${l.accountId}|${core}`;
    if (!groups.has(key)) groups.set(key, [] as any);
    groups.get(key)!.push(l);
  }

  let merged = 0;
  let groupCount = 0;
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    groupCount++;

    const scored = group
      .map((l) => {
        const cf = (l.customFields || {}) as Record<string, string>;
        const dataScore = Object.values(cf).filter((v) => String(v || '').trim()).length + (l.value ? 2 : 0);
        return { l, msgs: l._count.messages, dataScore };
      })
      .sort((a, b) => b.msgs - a.msgs || b.dataScore - a.dataScore || a.l.createdAt.getTime() - b.l.createdAt.getTime());

    const keep = scored[0].l;
    for (const { l: source } of scored.slice(1)) {
      const result = await mergeLeadPair(keep.accountId, keep.id, source.id, null, io);
      if (result.ok) merged++;
      else console.error('[Auto-merge telefone] Falhou para', source.id, result.error);
    }
  }

  return { merged, groups: groupCount };
}
