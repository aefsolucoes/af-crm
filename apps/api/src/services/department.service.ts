import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// aiScope = produtos que a IA do WhatsApp (Lead.aiAutoReplyActive) deve
// tratar como "dentro do assunto" neste setor — usado só como valor inicial
// (o admin edita livremente depois em Configurações → Setores).
const DEFAULT_DEPARTMENTS = [
  { name: 'Financiamento Habitacional', aiScope: 'financiamento habitacional, home equity, financiamento para construção' },
  { name: 'Consórcio', aiScope: 'consórcio de imóveis, consórcio de veículos e consórcio de bens em geral' },
];

/**
 * Garante que a conta tem pelo menos os departamentos padrão — roda sozinho,
 * idempotente (não duplica se já existir algum). Na PRIMEIRA vez que cria os
 * departamentos padrão pra essa conta, também migra todos os pipelines
 * "órfãos" (sem departmento ainda) para "Financiamento Habitacional" — é a
 * suposição segura, já que essa foi a única linha de negócio até agora.
 */
export async function ensureDefaultDepartments(accountId: string) {
  let list = await prisma.department.findMany({ where: { accountId }, orderBy: { order: 'asc' } });

  if (list.length === 0) {
    const created = [];
    for (let i = 0; i < DEFAULT_DEPARTMENTS.length; i++) {
      created.push(await prisma.department.create({ data: { accountId, name: DEFAULT_DEPARTMENTS[i].name, aiScope: DEFAULT_DEPARTMENTS[i].aiScope, order: i } }));
    }
    list = created;

    const financiamento = created.find((d) => d.name === 'Financiamento Habitacional');
    if (financiamento) {
      await prisma.pipeline.updateMany({
        where: { accountId, departmentId: null },
        data: { departmentId: financiamento.id },
      });
    }
  } else {
    // Contas que já tinham os setores padrão de antes do campo aiScope
    // existir ficam sem esse texto — preenche uma vez, sem sobrescrever se o
    // admin já tiver editado (aiScope != null).
    for (const dep of list) {
      if (dep.aiScope == null) {
        const def = DEFAULT_DEPARTMENTS.find((d) => d.name === dep.name);
        if (def) await prisma.department.update({ where: { id: dep.id }, data: { aiScope: def.aiScope } }).catch(() => {});
      }
    }
  }

  // Separado do "cria os padrão" de cima de propósito: essa conta pode já
  // ter os departamentos (de um deploy anterior) na hora em que o campo
  // WhatsAppConfig.departmentId passou a existir — então roda toda vez,
  // idempotente, até resolver.
  await migrateLegacyWhatsAppConfig(accountId, list);

  return list;
}

/** A config da API Oficial que já existia (sem setor) é, na prática, de
 *  Financiamento Habitacional — mesma suposição usada pros pipelines (foi a
 *  única linha de negócio até os departamentos existirem). Idempotente. */
async function migrateLegacyWhatsAppConfig(accountId: string, departments: { id: string; name: string }[]) {
  const financiamento = departments.find((d) => d.name === 'Financiamento Habitacional');
  if (!financiamento) return;
  const legacyConfig = await prisma.whatsAppConfig.findFirst({ where: { accountId, departmentId: null } });
  if (!legacyConfig) return;
  const alreadyHasFinanciamento = await prisma.whatsAppConfig.findFirst({ where: { accountId, departmentId: financiamento.id } });
  if (alreadyHasFinanciamento) return; // evita colidir com o índice único accountId+departmentId
  await prisma.whatsAppConfig.update({ where: { id: legacyConfig.id }, data: { departmentId: financiamento.id } }).catch(() => {});
}

export async function listDepartments(accountId: string) {
  await ensureDefaultDepartments(accountId);
  return prisma.department.findMany({ where: { accountId }, orderBy: { order: 'asc' } });
}

/**
 * Funil "Caixa de Entrada" — a central ÚNICA onde TODO lead novo cai primeiro:
 * WhatsApp (número novo), lead criado manualmente sem funil, importação. É UMA
 * só pra conta inteira e SEM setor (departmentId null) de propósito: assim ela
 * aparece em toda tela de /funil (o filtro de lá inclui `|| !p.department`) e
 * um humano move o card pro funil do setor certo depois. Antes era uma por
 * setor — dava várias "Caixa de Entrada" iguais e a confusão de uma aparecer
 * no funil de outro setor; agora é centralizada, então "aparecer em todos" é o
 * comportamento desejado, não bug. `departmentId` fica na assinatura só por
 * compatibilidade com os callers e é ignorado.
 *
 * Compartilhado entre baileys.service.ts e whatsapp.service.ts pra não
 * duplicar a lógica (e sem import circular — este arquivo não importa nenhum).
 */
const INBOX_NAME_MATCH = [
  { name: { contains: 'Caixa', mode: 'insensitive' as const } },
  { name: { contains: 'Inbox', mode: 'insensitive' as const } },
];

/** Fila de criação por conta — o "achar ou criar" não é atômico: duas
 *  mensagens de WhatsApp quase simultâneas podiam rodar o findFirst ao mesmo
 *  tempo, nenhuma achar nada, e as duas criarem uma "Caixa de Entrada" cada.
 *  Enfileirando por conta, a 2ª só roda depois da 1ª e já acha pronta. Só
 *  serializa dentro deste processo — basta, a API roda numa instância só. */
const inboxPipelineLocks = new Map<string, Promise<unknown>>();

export async function getOrCreateInboxPipeline(accountId: string, _departmentId?: string | null) {
  const run = async () => {
    // 1) Já existe a global (sem setor)? usa ela.
    const globalInbox = await prisma.pipeline.findFirst({
      where: { accountId, departmentId: null, OR: INBOX_NAME_MATCH },
      orderBy: { id: 'asc' }, // Pipeline não tem createdAt; cuid ~cresce com o tempo, serve pra "a mais antiga"
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    if (globalInbox) return globalInbox;

    // 2) Existe uma "Caixa de Entrada" antiga presa a um setor? adota ela como
    //    global (só tira o setor) em vez de criar outra — não perde os leads
    //    que já estão nela.
    const legacy = await prisma.pipeline.findFirst({
      where: { accountId, OR: INBOX_NAME_MATCH },
      orderBy: { id: 'asc' }, // Pipeline não tem createdAt; cuid ~cresce com o tempo, serve pra "a mais antiga"
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    if (legacy) {
      return prisma.pipeline.update({
        where: { id: legacy.id },
        data: { departmentId: null },
        include: { stages: { orderBy: { order: 'asc' } } },
      });
    }

    // 3) Nenhuma existe ainda — cria a global.
    return prisma.pipeline.create({
      data: {
        name: 'Caixa de Entrada',
        accountId,
        departmentId: null,
        stages: { create: [{ name: 'Leads de Entrada', order: 0, color: '#25D366' }] },
      },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
  };

  const previous = inboxPipelineLocks.get(accountId) || Promise.resolve();
  const result = previous.then(run);
  // guarda uma cópia que nunca rejeita — senão uma falha travaria a fila pra
  // sempre esperando uma promise rejeitada que ninguém mais trata.
  inboxPipelineLocks.set(accountId, result.catch(() => undefined));
  return result;
}

export interface DuplicateInboxGroup {
  departmentId: string | null;
  departmentName: string;
  pipelines: { id: string; name: string; leadCount: number; stageNames: string[] }[];
}

/** Acha grupos de funil "Caixa de Entrada" duplicado (2+ pra um mesmo setor)
 *  — sobra da corrida corrigida em getOrCreateInboxPipeline. Só lê, não
 *  mexe em nada — usado pra mostrar um preview antes de mesclar. */
export async function findDuplicateInboxPipelines(accountId: string): Promise<DuplicateInboxGroup[]> {
  const pipelines = await prisma.pipeline.findMany({
    where: { accountId, name: { contains: 'Caixa', mode: 'insensitive' } },
    include: {
      _count: { select: { leads: true } },
      stages: { orderBy: { order: 'asc' }, select: { name: true } },
      department: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  });

  const byDept = new Map<string, typeof pipelines>();
  for (const p of pipelines) {
    const key = p.departmentId ?? '__sem_setor__';
    const arr = byDept.get(key);
    if (arr) arr.push(p);
    else byDept.set(key, [p]);
  }

  const groups: DuplicateInboxGroup[] = [];
  for (const [key, list] of byDept) {
    if (list.length < 2) continue;
    groups.push({
      departmentId: key === '__sem_setor__' ? null : key,
      departmentName: list[0].department?.name || 'Sem setor',
      pipelines: list.map((p) => ({ id: p.id, name: p.name, leadCount: p._count.leads, stageNames: p.stages.map((s) => s.name) })),
    });
  }
  return groups;
}

/**
 * Mescla os funis "Caixa de Entrada" duplicados de UM setor num só: escolhe
 * o canônico (o com mais leads — desempate pelo id mais antigo, já que
 * Pipeline não tem createdAt), move os leads dos outros pra lá (casando por
 * NOME de etapa — cria a etapa no canônico se não existir uma com esse nome
 * — e cai na primeira etapa do canônico se por algum motivo a etapa de
 * origem não tiver nome), depois apaga os funis (agora vazios) e suas
 * etapas. `dryRun` (padrão) só simula e devolve quantos leads seriam
 * movidos, sem tocar em nada.
 */
export async function mergeDuplicateInboxPipelines(
  accountId: string,
  departmentId: string | null,
  opts: { dryRun?: boolean } = {},
): Promise<{ dryRun: boolean; canonicalId: string | null; merged: { pipelineId: string; pipelineName: string; leadsMoved: number }[] }> {
  const dryRun = opts.dryRun !== false;

  const pipelines = await prisma.pipeline.findMany({
    where: { accountId, departmentId, name: { contains: 'Caixa', mode: 'insensitive' } },
    include: { _count: { select: { leads: true } }, stages: { orderBy: { order: 'asc' } } },
    orderBy: { id: 'asc' },
  });
  if (pipelines.length < 2) return { dryRun, canonicalId: pipelines[0]?.id ?? null, merged: [] };

  const canonical = [...pipelines].sort((a, b) => b._count.leads - a._count.leads)[0];
  const duplicates = pipelines.filter((p) => p.id !== canonical.id);

  if (dryRun) {
    return {
      dryRun,
      canonicalId: canonical.id,
      merged: duplicates.map((d) => ({ pipelineId: d.id, pipelineName: d.name, leadsMoved: d._count.leads })),
    };
  }

  const merged: { pipelineId: string; pipelineName: string; leadsMoved: number }[] = [];
  for (const dup of duplicates) {
    const canonicalByName = new Map(canonical.stages.map((s) => [s.name.trim().toLowerCase(), s.id]));
    let maxOrder = Math.max(-1, ...canonical.stages.map((s) => s.order));
    const stageMap = new Map<string, string>(); // stageId (dup) -> stageId (canônico)

    for (const dupStage of dup.stages) {
      const key = dupStage.name.trim().toLowerCase();
      let targetId = canonicalByName.get(key);
      if (!targetId) {
        maxOrder += 1;
        const created = await prisma.stage.create({
          data: { name: dupStage.name, color: dupStage.color, pipelineId: canonical.id, order: maxOrder },
        });
        targetId = created.id;
        canonicalByName.set(key, targetId);
      }
      stageMap.set(dupStage.id, targetId);
    }

    const leads = await prisma.lead.findMany({ where: { pipelineId: dup.id }, select: { id: true, stageId: true } });
    let leadsMoved = 0;
    for (const lead of leads) {
      const targetStageId = stageMap.get(lead.stageId) ?? canonical.stages[0]?.id;
      if (!targetStageId) continue; // não deveria acontecer (funil sempre nasce com 1 etapa)
      await prisma.lead.update({ where: { id: lead.id }, data: { pipelineId: canonical.id, stageId: targetStageId } });
      leadsMoved++;
    }
    merged.push({ pipelineId: dup.id, pipelineName: dup.name, leadsMoved });

    await prisma.stage.deleteMany({ where: { pipelineId: dup.id } });
    await prisma.pipeline.delete({ where: { id: dup.id } });
  }

  return { dryRun, canonicalId: canonical.id, merged };
}

/** Remove acento/caixa pra comparar nome de etapa sem depender de escrita
 *  exata ("Prospecção" vs "prospeccao" vs " Prospecção "). */
function normalizeStageName(name: string): string {
  return name.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export interface MoveInboxToStageResult {
  dryRun: boolean;
  departmentName: string;
  targetPipelineName: string;
  targetStageName: string;
  leadsMoved: number;
  sourcePipelines: { id: string; name: string; leadCount: number }[];
  pipelinesRemoved: number;
}

/**
 * Esvazia TODO funil "Caixa de Entrada" de um setor, movendo os leads pra
 * etapa `targetStageName` (ex.: "Prospecção") — precisa existir em exatamente
 * UM outro funil do mesmo setor, senão não decide sozinho pra onde mandar.
 * `dryRun` (padrão true) só simula. Sem dryRun, depois de mover os leads
 * apaga os funis "Caixa de Entrada" (ficam vazios) — um novo nasce sozinho na
 * próxima mensagem de WhatsApp, via getOrCreateInboxPipeline.
 */
export async function moveInboxLeadsToStage(
  accountId: string,
  departmentId: string,
  targetStageName: string,
  opts: { dryRun?: boolean } = {},
): Promise<MoveInboxToStageResult> {
  const dryRun = opts.dryRun !== false;

  const department = await prisma.department.findFirst({ where: { id: departmentId, accountId } });
  if (!department) throw new Error('Departamento não encontrado');

  const pipelines = await prisma.pipeline.findMany({
    where: { accountId, departmentId },
    include: { stages: { orderBy: { order: 'asc' } }, _count: { select: { leads: true } } },
  });

  const inboxPipelines = pipelines.filter((p) => p.name.toLowerCase().includes('caixa'));
  if (!inboxPipelines.length) {
    throw new Error(`Não achei nenhum funil "Caixa de Entrada" em ${department.name}.`);
  }

  const wanted = normalizeStageName(targetStageName);
  const candidates = pipelines
    .filter((p) => !inboxPipelines.some((ip) => ip.id === p.id))
    .flatMap((p) => p.stages.filter((s) => normalizeStageName(s.name) === wanted).map((s) => ({ pipeline: p, stage: s })));

  if (candidates.length === 0) {
    throw new Error(`Não achei nenhuma etapa "${targetStageName}" em outro funil de ${department.name}.`);
  }
  if (candidates.length > 1) {
    throw new Error(`Achei "${targetStageName}" em mais de um funil de ${department.name} (${candidates.map((c) => c.pipeline.name).join(', ')}) — não decido sozinho pra qual mandar.`);
  }
  const { pipeline: targetPipeline, stage: targetStage } = candidates[0];

  const sourcePipelines = inboxPipelines.map((p) => ({ id: p.id, name: p.name, leadCount: p._count.leads }));
  const totalLeads = sourcePipelines.reduce((n, p) => n + p.leadCount, 0);

  if (dryRun) {
    return {
      dryRun: true,
      departmentName: department.name,
      targetPipelineName: targetPipeline.name,
      targetStageName: targetStage.name,
      leadsMoved: totalLeads,
      sourcePipelines,
      pipelinesRemoved: 0,
    };
  }

  const moveResult = totalLeads > 0
    ? await prisma.lead.updateMany({
        where: { pipelineId: { in: inboxPipelines.map((p) => p.id) } },
        data: { pipelineId: targetPipeline.id, stageId: targetStage.id },
      })
    : { count: 0 };

  for (const p of inboxPipelines) {
    await prisma.stage.deleteMany({ where: { pipelineId: p.id } });
    await prisma.pipeline.delete({ where: { id: p.id } });
  }

  return {
    dryRun: false,
    departmentName: department.name,
    targetPipelineName: targetPipeline.name,
    targetStageName: targetStage.name,
    leadsMoved: moveResult.count,
    sourcePipelines,
    pipelinesRemoved: inboxPipelines.length,
  };
}

export interface ConsolidateInboxResult {
  dryRun: boolean;
  globalPipelineId: string;
  globalPipelineName: string;
  merged: { id: string; name: string; departmentName: string | null; leadCount: number }[];
  leadsMoved: number;
  pipelinesRemoved: number;
}

/**
 * Junta TODA "Caixa de Entrada" espalhada (as antigas, uma por setor, e
 * qualquer duplicata) na Caixa de Entrada global única. Move os leads pra 1ª
 * etapa da global e apaga os funis que ficaram vazios. `dryRun` (padrão true)
 * só simula — o retorno já lista o que seria mesclado. A global é criada se
 * ainda não existir (via getOrCreateInboxPipeline).
 */
export async function consolidateInboxPipelines(
  accountId: string,
  opts: { dryRun?: boolean } = {},
): Promise<ConsolidateInboxResult> {
  const dryRun = opts.dryRun !== false;

  const globalInbox = await getOrCreateInboxPipeline(accountId);
  const firstStageId = globalInbox.stages[0]?.id;
  if (!firstStageId) throw new Error('A Caixa de Entrada global não tem nenhuma etapa.');

  const others = await prisma.pipeline.findMany({
    where: { accountId, id: { not: globalInbox.id }, OR: INBOX_NAME_MATCH },
    include: { _count: { select: { leads: true } }, department: { select: { name: true } } },
    orderBy: { id: 'asc' },
  });

  const merged = others.map((p) => ({
    id: p.id,
    name: p.name,
    departmentName: p.department?.name ?? null,
    leadCount: p._count.leads,
  }));
  const leadsToMove = merged.reduce((n, p) => n + p.leadCount, 0);

  if (dryRun) {
    return {
      dryRun: true,
      globalPipelineId: globalInbox.id,
      globalPipelineName: globalInbox.name,
      merged,
      leadsMoved: leadsToMove,
      pipelinesRemoved: 0,
    };
  }

  if (others.length) {
    if (leadsToMove > 0) {
      await prisma.lead.updateMany({
        where: { pipelineId: { in: others.map((p) => p.id) } },
        data: { pipelineId: globalInbox.id, stageId: firstStageId },
      });
    }
    for (const p of others) {
      await prisma.stage.deleteMany({ where: { pipelineId: p.id } });
      await prisma.pipeline.delete({ where: { id: p.id } }).catch(() => undefined);
    }
  }

  return {
    dryRun: false,
    globalPipelineId: globalInbox.id,
    globalPipelineName: globalInbox.name,
    merged,
    leadsMoved: leadsToMove,
    pipelinesRemoved: others.length,
  };
}

/**
 * Setores efetivos do usuário logado, para filtrar o que ele enxerga.
 * ADMIN sempre retorna [] (= sem filtro, vê tudo). Não-admin sem nenhum
 * setor definido também retorna [] por ora (compatibilidade — não trava
 * quem ainda não foi configurado em Usuários). Array vazio == antigo
 * `null`: em todo lugar que consome isso, `scopeDepartmentIds.length` faz
 * o papel do antigo `if (scopeDepartmentId)`.
 */
export async function getScopeDepartmentIds(accountId: string, userId: string, role: string): Promise<string[]> {
  if (role === 'ADMIN') return [];
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { departmentIds: true } });
  return user?.departmentIds ?? [];
}

/**
 * @deprecated Ponte temporária pros ~30 pontos do backend que ainda
 * comparam um único id (`=== scopeDepartmentId`) — sendo migrados aos
 * poucos pra `getScopeDepartmentIds` (etapas seguintes deste mesmo
 * trabalho). Devolve o primeiro setor do usuário só — exato pra quem tem
 * 0 ou 1 (todo mundo, nesta etapa, já que ainda não existe UI/API pra
 * marcar mais de um), correto o suficiente como fallback pra quem tiver
 * mais depois, até a migração dessas rotas terminar. Remover quando o
 * último caller for migrado.
 */
export async function getScopeDepartmentId(accountId: string, userId: string, role: string): Promise<string | null> {
  const ids = await getScopeDepartmentIds(accountId, userId, role);
  return ids[0] ?? null;
}

/**
 * Decide em qual setor um registro novo (pipeline, template) deve nascer,
 * dado os setores do usuário logado e o `departmentId` que ele pediu no
 * corpo da requisição (só relevante pra admin/multi-setor — link direto).
 * - 0 setores (admin, ou colaborador sem setor definido): usa o que veio
 *   do body, ou null (compatibilidade — cria "órfão", visível em todo canto).
 * - 1 setor: sempre esse, ignora o que veio do body (igual ao comportamento
 *   de antes — não dava pra um colaborador de setor único criar em outro).
 * - 2+ setores: exige `requestedDepartmentId` explícito E que esteja entre
 *   os setores do próprio usuário — não dá pra "adivinhar" qual dos dois.
 */
export function resolveCreateDepartmentId(
  scopeDepartmentIds: string[],
  requestedDepartmentId?: string | null
): { ok: true; departmentId: string | null } | { ok: false; error: string } {
  if (scopeDepartmentIds.length === 0) return { ok: true, departmentId: requestedDepartmentId || null };
  if (scopeDepartmentIds.length === 1) return { ok: true, departmentId: scopeDepartmentIds[0] };
  if (!requestedDepartmentId || !scopeDepartmentIds.includes(requestedDepartmentId)) {
    return { ok: false, error: 'Você tem mais de um setor — escolha em qual deles isso deve entrar.' };
  }
  return { ok: true, departmentId: requestedDepartmentId };
}
