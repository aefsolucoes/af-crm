/**
 * Script para recriar apenas os field definitions sem apagar leads/contatos.
 * Uso: npx ts-node src/scripts/seed-fields.ts
 */
import 'dotenv/config';
import { PrismaClient, FieldType } from '@prisma/client';

const prisma = new PrismaClient();

const fieldDefs: { tab: string; name: string; key: string; type: FieldType; options: string[]; order: number }[] = [
  // Principal
  { tab: 'Principal', name: 'Participante 1', key: 'participante_1', type: 'TEXT', options: [], order: 0 },
  { tab: 'Principal', name: 'CPF', key: 'cpf_1', type: 'TEXT', options: [], order: 1 },
  { tab: 'Principal', name: 'Data de nascimento', key: 'nascimento_1', type: 'DATE', options: [], order: 2 },
  { tab: 'Principal', name: 'Renda', key: 'renda_1', type: 'NUMBER', options: [], order: 3 },
  { tab: 'Principal', name: 'E-mail', key: 'email_1', type: 'EMAIL', options: [], order: 4 },
  { tab: 'Principal', name: 'Tipo de vínculo', key: 'vinculo_1', type: 'TEXT', options: [], order: 5 },
  { tab: 'Principal', name: 'Participante 2', key: 'participante_2', type: 'TEXT', options: [], order: 6 },
  { tab: 'Principal', name: 'CPF 2', key: 'cpf_2', type: 'TEXT', options: [], order: 7 },
  { tab: 'Principal', name: 'Data de nascimento 2', key: 'nascimento_2', type: 'DATE', options: [], order: 8 },
  { tab: 'Principal', name: 'Renda 2', key: 'renda_2', type: 'NUMBER', options: [], order: 9 },
  { tab: 'Principal', name: 'E-mail 2', key: 'email_2', type: 'EMAIL', options: [], order: 10 },
  { tab: 'Principal', name: 'Tipo de vínculo 2', key: 'vinculo_2', type: 'TEXT', options: [], order: 11 },
  { tab: 'Principal', name: 'Pasta Drive', key: 'pasta_drive', type: 'LINK', options: [], order: 14 },
  // Financiamento
  { tab: 'Financiamento', name: 'Finalidade', key: 'finalidade', type: 'TEXT', options: [], order: 0 },
  { tab: 'Financiamento', name: 'Indexador', key: 'indexador', type: 'TEXT', options: [], order: 1 },
  { tab: 'Financiamento', name: 'Valor de avaliação', key: 'valor_avaliacao', type: 'NUMBER', options: [], order: 2 },
  { tab: 'Financiamento', name: 'Valor do imóvel', key: 'valor_imovel', type: 'NUMBER', options: [], order: 3 },
  { tab: 'Financiamento', name: 'Valor do crédito', key: 'valor_credito', type: 'NUMBER', options: [], order: 4 },
  { tab: 'Financiamento', name: 'Valor de entrada', key: 'valor_entrada', type: 'NUMBER', options: [], order: 5 },
  { tab: 'Financiamento', name: 'Primeira parcela', key: 'primeira_parcela', type: 'NUMBER', options: [], order: 6 },
  { tab: 'Financiamento', name: 'Última parcela', key: 'ultima_parcela', type: 'NUMBER', options: [], order: 7 },
  { tab: 'Financiamento', name: 'Instituição', key: 'instituicao', type: 'SELECT', options: ['Caixa', 'Bradesco', 'Itaú', 'Santander', 'BB', 'Inter', 'Outro'], order: 8 },
  { tab: 'Financiamento', name: 'Taxa efetiva', key: 'taxa_efetiva', type: 'TEXT', options: [], order: 9 },
  { tab: 'Financiamento', name: 'Prazo', key: 'prazo_financ', type: 'TEXT', options: [], order: 10 },
  { tab: 'Financiamento', name: 'FGTS?', key: 'fgts', type: 'TEXT', options: [], order: 11 },
  { tab: 'Financiamento', name: 'COH criado?', key: 'coh_criado', type: 'SELECT', options: ['Sim', 'Não', 'Em andamento'], order: 12 },
  { tab: 'Financiamento', name: 'CND GDF e Fed Compra', key: 'cnd_compra', type: 'TEXT', options: [], order: 13 },
  { tab: 'Financiamento', name: 'CND GDF e Fed Vend', key: 'cnd_venda', type: 'TEXT', options: [], order: 14 },
  { tab: 'Financiamento', name: 'Contato para Vistoria', key: 'contato_vistoria', type: 'TEXT', options: [], order: 15 },
  { tab: 'Financiamento', name: 'E-mail vendedor', key: 'email_vendedor', type: 'EMAIL', options: [], order: 16 },
  { tab: 'Financiamento', name: 'Número da proposta', key: 'num_proposta', type: 'TEXT', options: [], order: 17 },
  { tab: 'Financiamento', name: 'Docs pendentes', key: 'docs_pendentes', type: 'TEXT', options: [], order: 18 },
  // Consórcio
  { tab: 'Consórcio', name: 'Administradora', key: 'administradora', type: 'TEXT', options: [], order: 0 },
  { tab: 'Consórcio', name: 'Crédito', key: 'credito_consorcio', type: 'NUMBER', options: [], order: 1 },
  { tab: 'Consórcio', name: 'Parcela', key: 'parcela_consorcio', type: 'NUMBER', options: [], order: 2 },
  { tab: 'Consórcio', name: 'Prazo (meses)', key: 'prazo_consorcio', type: 'NUMBER', options: [], order: 3 },
  { tab: 'Consórcio', name: 'Grupo', key: 'grupo_consorcio', type: 'TEXT', options: [], order: 4 },
];

async function main() {
  const account = await prisma.account.findFirst();
  if (!account) { console.error('Nenhuma conta encontrada'); process.exit(1); }

  await prisma.fieldDefinition.deleteMany({ where: { accountId: account.id } });
  for (const fd of fieldDefs) {
    await prisma.fieldDefinition.create({ data: { ...fd, accountId: account.id } });
  }

  console.log(`✅ ${fieldDefs.length} campos criados para conta "${account.name}"`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
