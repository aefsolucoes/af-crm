import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_DEPARTMENTS = ['Financiamento Habitacional', 'Consórcio'];

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
      created.push(await prisma.department.create({ data: { accountId, name: DEFAULT_DEPARTMENTS[i], order: i } }));
    }
    list = created;

    const financiamento = created.find((d) => d.name === 'Financiamento Habitacional');
    if (financiamento) {
      await prisma.pipeline.updateMany({
        where: { accountId, departmentId: null },
        data: { departmentId: financiamento.id },
      });
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
export async function getOrCreateInboxPipeline(accountId: string, departmentId?: string | null) {
  let pipeline = await prisma.pipeline.findFirst({
    where: {
      accountId,
      name: { contains: 'Caixa', mode: 'insensitive' },
      departmentId: departmentId ?? null,
    },
    include: { stages: { orderBy: { order: 'asc' } } },
  });

  if (!pipeline) {
    pipeline = await prisma.pipeline.create({
      data: {
        name: 'Caixa de Entrada',
        accountId,
        departmentId: departmentId ?? null,
        stages: { create: [{ name: 'Leads de Entrada', order: 0, color: '#25D366' }] },
      },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
  }

  return pipeline;
}

/**
 * Departamento efetivo do usuário logado, para filtrar o que ele enxerga.
 * ADMIN sempre retorna null (= sem filtro, vê tudo). Não-admin sem
 * departamento definido também retorna null por ora (compatibilidade — não
 * trava quem ainda não foi configurado em Usuários).
 */
export async function getScopeDepartmentId(accountId: string, userId: string, role: string): Promise<string | null> {
  if (role === 'ADMIN') return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { departmentId: true } });
  return user?.departmentId ?? null;
}
