import { PrismaClient } from '@prisma/client';

/**
 * Funis "por mês" (Concluído / Perdidos) e a ida do card pro "Perdidos" —
 * saiu de routes/leads.ts pra ser usado também pela IA e pelo botão
 * "Não tenho interesse" do WhatsApp (pedido do Fabio 26/09: todo Perdido,
 * venha de onde vier, some do funil ativo do mesmo jeito).
 */

const prisma = new PrismaClient();

export const MONTH_NAMES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

/** Nome do mês atual no fuso de Brasília, independente do fuso do servidor. */
export function currentMonthNamePT(): string {
  const idx = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', month: 'numeric' }).format(new Date()), 10) - 1;
  return MONTH_NAMES_PT[idx];
}

/** Fila de criação por (conta+nome+setor) — o "achar ou criar" abaixo não é
 *  atômico: dois PUTs marcando leads como Ganho/Perdido quase juntos podiam
 *  criar dois funis "Concluído"/"Perdidos" duplicados — mesma classe de
 *  corrida já corrigida em createFolder (google.service.ts) e
 *  getOrCreateInboxPipeline (department.service.ts). */
const namedPipelineLocks = new Map<string, Promise<unknown>>();

/** Funil com um estágio por mês do ano (pra saber quantos entraram em cada
 *  mês) — usado tanto por "Concluído" (leads Ganho) quanto "Perdidos" (leads
 *  Perdido). Cria sozinho na primeira vez que precisar, sem exigir
 *  configuração manual antes. Um por departamento — cada setor tem o seu. */
export async function getOrCreateNamedPipeline(
  accountId: string,
  name: string,
  departmentId: string | null | undefined,
  stageColor: string,
  /** Etapas do funil na criação. Sem isso, cria um estágio por mês (uso de
   *  "Concluído"/"Perdidos"). Com isso, cria exatamente essas (ex.: as 7 de
   *  "Em contratação"). Ignorado se o funil já existir. */
  stageDefs?: { name: string; order: number; color: string }[],
) {
  const key = `${accountId}::${name}::${departmentId ?? ''}`;
  const run = async () => {
    const existing = await prisma.pipeline.findFirst({
      where: { accountId, name, departmentId: departmentId ?? null },
      include: { stages: { orderBy: { order: 'asc' } } },
      orderBy: { id: 'asc' },
    });
    if (existing) return existing;

    const created = await prisma.pipeline.create({
      data: {
        name,
        accountId,
        departmentId: departmentId ?? null,
        stages: {
          create: stageDefs
            ? stageDefs.map((s) => ({ name: s.name, order: s.order, color: s.color }))
            : MONTH_NAMES_PT.map((n, i) => ({ name: n, order: i + 1, color: stageColor })),
        },
      },
      include: { stages: { orderBy: { order: 'asc' } } },
    });

    // Auto-cura da corrida entre PROCESSOS (a trava por chave acima só vale
    // dentro de um processo; num redeploy do Railway dois processos podem
    // criar o mesmo funil ao mesmo tempo — foi o que gerou dois "Perdidos"
    // no Home Equity). Se sobrou mais de um com esse nome/setor, fica com o
    // de id mais antigo e apaga os outros que estiverem VAZIOS.
    const all = await prisma.pipeline.findMany({
      where: { accountId, name, departmentId: departmentId ?? null },
      include: { _count: { select: { leads: true } } },
      orderBy: { id: 'asc' },
    });
    if (all.length > 1) {
      const keep = all[0];
      for (const extra of all.slice(1)) {
        if (extra._count.leads === 0) {
          await prisma.stage.deleteMany({ where: { pipelineId: extra.id } }).catch(() => {});
          await prisma.pipeline.delete({ where: { id: extra.id } }).catch(() => {});
        }
      }
      if (keep.id !== created.id) {
        return prisma.pipeline.findUniqueOrThrow({ where: { id: keep.id }, include: { stages: { orderBy: { order: 'asc' } } } });
      }
    }
    return created;
  };
  const previous = namedPipelineLocks.get(key) || Promise.resolve();
  const result = previous.then(run);
  // guarda uma cópia que nunca rejeita — senão uma falha travaria a fila pra
  // sempre esperando uma promise rejeitada que ninguém mais trata.
  namedPipelineLocks.set(key, result.catch(() => undefined));
  return result as ReturnType<typeof run>;
}

/** Funil "Perdidos" — pra onde vão os leads marcados como Perdido, do mesmo
 *  jeito que "Concluído" já faz com Ganho (usuário pediu: card sumia dentro
 *  do funil ativo, só com uma etiqueta, difícil de achar depois). */
export async function getOrCreatePerdidosPipeline(accountId: string, departmentId?: string | null) {
  return getOrCreateNamedPipeline(accountId, 'Perdidos', departmentId, '#ef4444');
}

/** Leva o card pro funil "Perdidos" do setor (etapa = mês atual) com nota —
 *  mesmo comportamento do botão "Marcar Perdido". Chamar DEPOIS de marcar o
 *  status LOST (updateLead). */
export async function moveLeadToPerdidos(params: {
  accountId: string; leadId: string; departmentId: string | null | undefined;
  byName: string; userId: string | null; motivo?: string | null;
  io?: { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null;
}) {
  const { accountId, leadId, departmentId, byName, userId, motivo, io } = params;
  const perdidos = await getOrCreatePerdidosPipeline(accountId, departmentId ?? null);
  const mesAtual = currentMonthNamePT();
  const targetStage = perdidos.stages.find((s) => s.name === mesAtual) || perdidos.stages[0];
  if (!targetStage) return null;
  const m = (motivo || '').trim();
  const movedLead = await prisma.lead.update({
    where: { id: leadId },
    data: {
      pipelineId: perdidos.id,
      stageId: targetStage.id,
      notes: {
        create: {
          content: m
            ? `Lead migrado automaticamente para o funil "Perdidos" (${targetStage.name}) ao ser marcado como Perdido — por ${byName}. Motivo: ${m}`
            : `Lead migrado automaticamente para o funil "Perdidos" (${targetStage.name}) ao ser marcado como Perdido — por ${byName}.`,
          type: 'STAGE_CHANGE',
          ...(userId ? { userId } : {}),
        },
      },
    },
  });
  io?.to(`account_${accountId}`).emit('lead_moved', { lead: movedLead });
  console.log(`[Auto-migração] Lead "${movedLead.name}" marcado como Perdido → funil Perdidos (${targetStage.name})`);
  return movedLead;
}
