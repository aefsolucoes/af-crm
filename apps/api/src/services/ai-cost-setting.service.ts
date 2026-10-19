import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';

/** Chaves de economia da IA (Fabio 19/10). Lidas a cada chamada da IA — cache de 60 s; mudar na página Medição vale na hora (o cache da conta é limpo). Sem linha no banco = Haiku nas sugestões ligado e Base enxuta desligada. */

export interface AiCostSettings { kbLean: boolean; suggestHaiku: boolean }
const DEFAULTS: AiCostSettings = { kbLean: false, suggestHaiku: true };
const cache = new Map<string, { at: number; v: AiCostSettings }>();
const TTL_MS = 60_000;

export async function getAiCostSettings(accountId: string): Promise<AiCostSettings> {
  const hit = cache.get(accountId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.v;
  let v = DEFAULTS;
  try {
    const row = await prisma.aiCostSetting.findUnique({ where: { accountId } });
    if (row) v = { kbLean: row.kbLean, suggestHaiku: row.suggestHaiku };
  } catch { /* sem a tabela/banco fora: segue com o padrão */ }
  cache.set(accountId, { at: Date.now(), v });
  return v;
}

export async function setAiCostSettings(accountId: string, patch: Partial<AiCostSettings>, userId: string): Promise<AiCostSettings> {
  const cur = await getAiCostSettings(accountId);
  const next: AiCostSettings = { kbLean: typeof patch.kbLean === 'boolean' ? patch.kbLean : cur.kbLean, suggestHaiku: typeof patch.suggestHaiku === 'boolean' ? patch.suggestHaiku : cur.suggestHaiku };
  await prisma.aiCostSetting.upsert({ where: { accountId }, create: { accountId, ...next, updatedById: userId }, update: { ...next, updatedById: userId } });
  cache.delete(accountId);
  return next;
}
