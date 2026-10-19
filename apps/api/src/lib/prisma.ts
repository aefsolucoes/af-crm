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

const g = globalThis as unknown as { __afPrisma?: PrismaClient };
const url = urlComPool();
export const prisma: PrismaClient = g.__afPrisma || (g.__afPrisma = url ? new PrismaClient({ datasources: { db: { url } } }) : new PrismaClient());
