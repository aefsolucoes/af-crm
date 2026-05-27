/**
 * Adiciona BRB às opções do campo Instituição sem recriar campos.
 * Uso: npx ts-node scripts/patch-instituicao.ts
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const updated = await prisma.fieldDefinition.updateMany({
    where: { key: 'instituicao' },
    data: { options: ['Caixa', 'Bradesco', 'Itaú', 'Santander', 'BB', 'BRB', 'Inter', 'Outro'] },
  });
  console.log(`✅ ${updated.count} registro(s) atualizado(s) — BRB adicionado à Instituição`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
