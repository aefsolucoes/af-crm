/**
 * Migra o pipeline principal para os 6 estágios novos.
 * Renomeia estágios existentes e insere os novos.
 * Leads são preservados — apenas o estágio que os contém muda de nome/ordem.
 *
 * Uso: npx ts-node scripts/migrate-pipeline-stages.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Nova configuração de estágios (ordem, nome, cor)
const NEW_STAGES = [
  { order: 1, name: 'Prospecção',              color: '#3b82f6' },
  { order: 2, name: 'Follow Up',               color: '#f59e0b' },
  { order: 3, name: 'Aguardando Simulação',    color: '#8b5cf6' },
  { order: 4, name: 'Proposta Enviada',        color: '#f97316' },
  { order: 5, name: 'Aguardando Documentação', color: '#ef4444' },
  { order: 6, name: 'Fechado',                 color: '#10b981' },
];

// Mapeamento: nome antigo → nome novo (para renomear sem perder leads)
const RENAMES: Record<string, string> = {
  'Prospecção':  'Prospecção',              // mantém
  'Qualificação':'Aguardando Simulação',    // renomeia
  'Proposta':    'Proposta Enviada',        // renomeia
  'Negociação':  'Aguardando Documentação', // renomeia
  'Fechado':     'Fechado',                 // mantém
};

async function main() {
  const pipeline = await prisma.pipeline.findFirst({
    include: { stages: { orderBy: { order: 'asc' } } },
  });

  if (!pipeline) {
    console.error('❌ Nenhum pipeline encontrado');
    process.exit(1);
  }

  console.log(`📋 Pipeline: "${pipeline.name}" (${pipeline.stages.length} estágios atuais)`);

  // 1) Renomeia / reordena estágios existentes
  for (const stage of pipeline.stages) {
    const newName = RENAMES[stage.name];
    const newStage = NEW_STAGES.find(s => s.name === newName);
    if (newName && newStage) {
      await prisma.stage.update({
        where: { id: stage.id },
        data: { name: newName, order: newStage.order, color: newStage.color },
      });
      console.log(`  ✏️  "${stage.name}" → "${newName}" (ordem ${newStage.order})`);
    }
  }

  // 2) Insere estágios que não existem ainda
  const existingNames = pipeline.stages.map(s => RENAMES[s.name] || s.name);
  for (const ns of NEW_STAGES) {
    if (!existingNames.includes(ns.name)) {
      await prisma.stage.create({
        data: { name: ns.name, color: ns.color, order: ns.order, pipelineId: pipeline.id },
      });
      console.log(`  ➕ Criado "${ns.name}" (ordem ${ns.order})`);
    }
  }

  // 3) Remove estágios que não fazem mais parte do pipeline (sem leads)
  const refreshed = await prisma.pipeline.findFirst({
    where: { id: pipeline.id },
    include: { stages: { include: { _count: { select: { leads: true } } } } },
  });

  const validNames = NEW_STAGES.map(s => s.name);
  for (const stage of refreshed!.stages) {
    if (!validNames.includes(stage.name)) {
      if (stage._count.leads > 0) {
        console.warn(`  ⚠️  Estágio "${stage.name}" tem ${stage._count.leads} lead(s) — não removido`);
      } else {
        await prisma.stage.delete({ where: { id: stage.id } });
        console.log(`  🗑️  Removido "${stage.name}" (sem leads)`);
      }
    }
  }

  console.log('\n✅ Migração concluída!');
  console.log('Novo pipeline:');
  NEW_STAGES.forEach(s => console.log(`  ${s.order}. ${s.name}`));
}

main().catch(console.error).finally(() => prisma.$disconnect());
