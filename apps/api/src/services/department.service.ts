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
 * Funil "Caixa de Entrada" — onde caem leads novos vindos do WhatsApp. Um por
 * departamento (departmentId null = "genérico"/compartilhado, usado por
 * números/canais ainda não migrados pra um setor). Cria sozinho na primeira
 * vez que precisar, sem exigir configuração manual antes. Compartilhado entre
 * baileys.service.ts e whatsapp.service.ts pra não duplicar a lógica (e sem
 * criar import circular entre os dois — este arquivo não importa nenhum).
 */
/** Fila de criação por (conta+setor) — ver comentário em getOrCreateInboxPipeline. */
const inboxPipelineLocks = new Map<string, Promise<unknown>>();

/**
 * Acha (ou cria) o funil "Caixa de Entrada" de um setor. O "achar ou criar"
 * não é atômico: mensagens de WhatsApp chegando quase juntas pro MESMO setor
 * (ex.: dois clientes novos do Financiamento Habitacional em poucos segundos)
 * podiam rodar o findFirst ao mesmo tempo, nenhuma achar nada ainda, e as
 * duas criarem um funil "Caixa de Entrada" cada — funil duplicado, com os
 * leads espalhados entre os dois (mesma classe de bug do createFolder() do
 * Drive, ver google.service.ts).
 *
 * Corrigido enfileirando por chave (conta+setor): a segunda chamada só roda
 * depois que a primeira terminou, então já encontra o funil pronto. Só
 * serializa dentro deste processo — é suficiente porque a API roda numa
 * instância só.
 */
export async function getOrCreateInboxPipeline(accountId: string, departmentId?: string | null) {
  const key = `${accountId}::${departmentId ?? ''}`;
  const run = async () => {
    const pipeline = await prisma.pipeline.findFirst({
      where: {
        accountId,
        name: { contains: 'Caixa', mode: 'insensitive' },
        departmentId: departmentId ?? null,
      },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    if (pipeline) return pipeline;

    return prisma.pipeline.create({
      data: {
        name: 'Caixa de Entrada',
        accountId,
        departmentId: departmentId ?? null,
        stages: { create: [{ name: 'Leads de Entrada', order: 0, color: '#25D366' }] },
      },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
  };

  const previous = inboxPipelineLocks.get(key) || Promise.resolve();
  const result = previous.then(run);
  // guarda uma cópia que nunca rejeita — senão uma falha travaria a fila pra
  // sempre esperando uma promise rejeitada que ninguém mais trata.
  inboxPipelineLocks.set(key, result.catch(() => undefined));
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
