import { prisma } from '../lib/prisma';

/**
 * REGRAS FIXAS DO PROMPT NA BASE DE CONHECIMENTO (Fabio 29/10: "todo o prompt ligado em uma só fonte"). Cada bloco de regras que antes ficava só no código (CORE_RULES…) passa a viver numa
 * entrada da Base com `fixedKey`: a equipe e o Jarvis editam ali (Configurações → Base de Conhecimento / alterar_regra_ia) e o prompt lê dali. O texto do código é só a SEMENTE (criada na 1ª vez)
 * e o PLANO B (se a leitura falhar ou a entrada for apagada): o comportamento de antes é preservado. Entradas fixas não entram na busca comum (knowledge.service) — vão inteiras, sempre, no lugar do bloco.
 */

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; text: string }>();

export const FIXED_RULE_TITLES: Record<string, string> = {
  CORE_RULES: '[REGRA FIXA] Regras gerais da IA com o cliente (CORE_RULES)',
};

export function invalidateFixedRules(accountId?: string): void {
  if (!accountId) { cache.clear(); return; }
  for (const k of Array.from(cache.keys())) if (k.startsWith(`${accountId}:`)) cache.delete(k);
}

/** Texto vigente do bloco `key` desta conta: o da Base; sem entrada, semeia com `fallback` (o texto do código) e devolve ele. Nunca lança. */
export async function fixedRule(accountId: string, key: string, fallback: string): Promise<string> {
  const ck = `${accountId}:${key}`;
  const hit = cache.get(ck);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.text;
  let text = fallback;
  try {
    const row = await prisma.knowledgeEntry.findFirst({ where: { accountId, fixedKey: key }, select: { content: true } });
    if (row) text = row.content.trim() ? row.content : fallback;
    else await prisma.knowledgeEntry.create({ data: { accountId, fixedKey: key, title: FIXED_RULE_TITLES[key] || `[REGRA FIXA] ${key}`, content: fallback, embedding: [] } }).catch(() => {});
  } catch { /* plano B: texto do código */ }
  cache.set(ck, { at: Date.now(), text });
  return text;
}
