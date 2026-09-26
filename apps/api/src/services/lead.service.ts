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
}>, io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null) {
  // Perdido é definitivo — a IA de auto-resposta não deve continuar
  // conversando com o cliente depois disso (usuário pediu: não pode "dar
  // esperança" oferecendo outro produto pra quem já recusou). Central aqui
  // porque os dois caminhos que marcam Perdido passam por updateLead: o
  // botão manual "Marcar Perdido" e a própria IA quando ela mesma decide
  // marcar (applyAiExtractedActions, ai-shared.service.ts).
  const deactivatingAi = data.status === 'LOST';
  const lead = await prisma.lead.update({
    where: { id },
    data: {
      ...data,
      ...(data.name !== undefined ? { name: normalizeClientName(data.name) } : {}),
      ...(deactivatingAi ? { aiAutoReplyActive: false } : {}),
    } as any,
  });
  if (deactivatingAi) io?.to(`lead:${id}`).emit('lead_ai_toggled', { leadId: id, active: false });
  return lead;
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
 *  notas migram, campos/valor/nome são mesclados com prioridade pro dado
 *  mais completo; estágio/funil e status Perdido seguem o card MAIS ANTIGO
 *  dos dois (createdAt), não o mais recentemente ativo — decisão explícita
 *  do usuário. O source é excluído. Compartilhada entre a rota manual
 *  (POST /:id/merge, usuário escolhe os dois) e o job automático por
 *  telefone (autoMergeDuplicatesByPhone) — `userId` null = ação do sistema.
 *  Nunca lança: quem chama decide o que fazer com {ok:false}. */
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

    // Estágio/funil: sempre o do card MAIS ANTIGO dos dois (por createdAt) —
    // decisão explícita do usuário, mesmo sabendo que num caso real
    // (cliente com card antigo parado numa etapa cedo + card novo onde a
    // conversa de verdade avançou) isso pode manter um estágio
    // desatualizado — prefere isso a um comportamento "adivinhado" pela
    // atividade recente.
    const sourceIsOlder = source.createdAt < keep.createdAt;
    const useSourceStage = sourceIsOlder
      && (source.pipelineId !== keep.pipelineId || source.stageId !== keep.stageId);

    // Status: Perdido é definitivo e "gruda" no card mais antigo — cliente
    // que já foi marcado Perdido e manda mensagem de novo (ex.: cai um card
    // novo na Caixa de Entrada) NÃO reabre sozinho no merge, pra não dar a
    // entender que é um lead novo/ativo. Só o mais antigo dos dois "manda"
    // aqui — um source recém-perdido não deve "contaminar" um keep mais
    // antigo que nunca foi perdido. Reabrir é decisão humana (botão
    // "Reabrir" já existe na tela).
    const older = sourceIsOlder ? source : keep;
    const useOlderStatus = older.status === 'LOST' && keep.status !== 'LOST';

    await prisma.$transaction([
      prisma.message.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      prisma.task.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      prisma.note.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      // Tudo que aponta pro card também vai junto — anexos (Drive/docs),
      // ligações, e-mails, dúvidas da IA, comissão e histórico de automação
      // (sem isso ficavam órfãos ou eram apagados junto com o source).
      prisma.messageAttachment.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      prisma.call.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      prisma.emailMessage.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      prisma.aiTeamQuestion.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      prisma.assistantQuestion.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      prisma.commissionSuggestion.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      prisma.automationLog.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      prisma.lead.update({
        where: { id: keepId },
        data: {
          name: finalName, customFields: mergedCF as any, value: mergedValue,
          ...(useSourceStage ? { pipelineId: source.pipelineId, stageId: source.stageId } : {}),
          ...(useOlderStatus ? { status: 'LOST', lostReason: older.lostReason } : {}),
        },
      }),
      ...(useSourceName && keep.contactId
        ? [prisma.contact.update({ where: { id: keep.contactId }, data: { name: finalName } })]
        : []),
      prisma.note.create({
        data: {
          leadId: keepId,
          content: `Lead unificado com "${source.name}" (ID: ${sourceId}). Mensagens, tarefas e notas foram migradas.`
            + (useSourceStage ? ' Estágio/funil atualizado pro do card mais antigo.' : '')
            + (useOlderStatus ? ' Mantido como Perdido (o card mais antigo já tinha essa marcação).' : '')
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
 *  alguém abrir a tela.
 *
 *  Inclui leads Perdidos de propósito (não filtra por status): cliente já
 *  marcado Perdido que manda mensagem de novo cai num card novo na Caixa de
 *  Entrada — sem unir os dois esse card novo nunca seria pego (Perdido
 *  ficaria de fora do agrupamento pra sempre). mergeLeadPair já garante que
 *  o status Perdido do card mais antigo "gruda" no resultado, não reabre
 *  sozinho. */
export async function autoMergeDuplicatesByPhone(
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null,
): Promise<{ merged: number; groups: number }> {
  const leads = await prisma.lead.findMany({
    where: { archived: false, isGroup: false },
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
