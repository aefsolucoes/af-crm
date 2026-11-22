import { PrismaClient } from '@prisma/client';

/**
 * UM cliente do banco pra API inteira (Fabio 19/10, dívida técnica desde a queda de 09/10). Antes eram 67 `new PrismaClient()` — cada um com o seu próprio pool de conexões
 * (cpus × 2 + 1 cada): num pico elas somavam mais que o limite do Postgres e a API caía. Agora é um só, com o tamanho do pool definido aqui (DB_POOL_SIZE, padrão 20; DB_POOL_TIMEOUT, padrão 20 s).
 * Guardado no `globalThis` pra sobreviver a recarga de módulos. NUNCA chame `$disconnect()` nele (derruba o banco de todo mundo).
 */
function urlComPool(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  const u = new URL(url);
  if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', String(Math.max(2, Number(process.env.DB_POOL_SIZE) || 20)));
  if (!u.searchParams.has('pool_timeout')) u.searchParams.set('pool_timeout', String(Math.max(5, Number(process.env.DB_POOL_TIMEOUT) || 20)));
  return u.toString();
}

/** LIGAÇÃO RECEBIDA DE TESTE (Fabio 21/11, call-simulada.service): aparece na conversa do card como uma ligação de verdade, mas as regras automáticas não podem achar que
 *  o cliente falou com a gente (janela de 24 h, "última conversa" dos lembretes, cliente esperando resposta…). O waCallId dela começa com este prefixo. */
export const LIGACAO_TESTE_PREFIXO = 'simulada_';
/** Filtro de Message que tira as ligações de teste (callWaCallId nulo também passa — NOT sozinho tiraria os nulos). */
export const SEM_LIGACAO_TESTE = { OR: [{ callWaCallId: null }, { NOT: { callWaCallId: { startsWith: LIGACAO_TESTE_PREFIXO } } }] };
const LEITURAS = new Set(['findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);

function criar(): PrismaClient {
  const url = urlComPool();
  const c = url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient();
  // Toda leitura de Message que filtra mensagens RECEBIDAS (direction INBOUND em qualquer ponto do where) ignora as ligações de teste — são ~40 regras
  // (janela de 24 h, última conversa, resposta do cliente…). A conversa da Inbox lê sem filtro de direção, então a ligação de teste continua aparecendo lá.
  c.$use(async (params, next) => {
    if (params.model === 'Message' && LEITURAS.has(params.action) && params.args?.where && JSON.stringify(params.args.where).includes('"INBOUND"')) {
      params.args = { ...params.args, where: { AND: [params.args.where, SEM_LIGACAO_TESTE] } };
    }
    return next(params);
  });
  return c;
}

const g = globalThis as unknown as { __afPrisma?: PrismaClient };
export const prisma: PrismaClient = g.__afPrisma || (g.__afPrisma = criar());
