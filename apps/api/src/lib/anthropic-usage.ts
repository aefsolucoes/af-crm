import type { PrismaClient } from '@prisma/client';
import { prisma as sharedPrisma } from './prisma';

/**
 * Registro de uso da API da Anthropic (Fabio 16/10: "quando iremos ver os números reais?") + cache de prompt.
 *  - recordAnthropicUsage: chamado pelo wrapper de fetch (anthropic-safe-fetch) a cada resposta; agrega em memória e grava a cada minuto em "AiUsage".
 *  - cachedSystem: monta o `system` com a parte FIXA marcada pra cache (lida por ~10% do preço nas chamadas seguintes, dentro de 5 min) e a parte que muda
 *    por cliente depois, sem cache. Só vale quando a parte fixa é idêntica byte a byte entre as chamadas e tem mais de ~1.024 tokens.
 */

type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } };

/** `system` com a parte fixa em cache. Se não houver parte dinâmica, devolve só o bloco fixo.
 *  `ttl: '1h'`: o cache dura 1 hora em vez de 5 min — gravar custa 2× (em vez de 1,25×), mas quase não regrava. Vale pra quem chama várias vezes por hora
 *  (resposta ao cliente: só 6% das respostas vêm mais de 1 h depois da anterior, contra 26% depois de mais de 5 min — medido em 20/11). */
export function cachedSystem(fixed: string, dynamic?: string, ttl?: '1h'): SystemBlock[] {
  const out: SystemBlock[] = [{ type: 'text', text: fixed, cache_control: ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' } }];
  if (dynamic && dynamic.trim()) out.push({ type: 'text', text: dynamic });
  return out;
}

const BRT_MS = 3 * 3600_000;
const dayKey = (ms = Date.now()) => new Date(ms - BRT_MS).toISOString().slice(0, 10);

/** Quem chamou: arquivo + função, lidos da pilha de chamadas no momento do fetch (sem mexer em cada serviço). */
export function featureFromStack(stack: string): string {
  for (const line of String(stack || '').split('\n')) {
    if (/anthropic-(safe-fetch|usage)/.test(line)) continue;
    const m = /at (?:async )?(?:new )?([\w$.<>]+)? ?\(?.*?[\\/](services|routes|lib)[\\/]([\w-]+?)(?:\.service)?\.(?:js|ts)[:)]/.exec(line);
    if (m) {
      const fn = (m[1] || '').replace(/^Object\.|^async /, '');
      return `${m[3]}${fn && !/^<anonymous>$|^\?$/.test(fn) ? ':' + fn : ''}`.slice(0, 80);
    }
  }
  return 'desconhecido';
}

type Acc = { calls: number; errors: number; input: number; output: number; cacheRead: number; cacheWrite: number };
let pending = new Map<string, Acc>();
let timer: NodeJS.Timeout | null = null;

function db(): PrismaClient {
  return sharedPrisma; // um cliente só pra API inteira (lib/prisma.ts); o remendo de 1 conexão de 09/10 não é mais necessário
}

export function recordAnthropicUsage(feature: string, model: string, usage: any | null, ok: boolean): void {
  try {
    const key = JSON.stringify([dayKey(), feature, String(model || 'desconhecido').slice(0, 60)]);
    const a = pending.get(key) || { calls: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    a.calls += 1;
    if (!ok) a.errors += 1;
    if (usage) {
      a.input += Number(usage.input_tokens) || 0;
      a.output += Number(usage.output_tokens) || 0;
      a.cacheRead += Number(usage.cache_read_input_tokens) || 0;
      a.cacheWrite += Number(usage.cache_creation_input_tokens) || 0;
    }
    pending.set(key, a);
    if (!timer) { timer = setInterval(() => { flushAnthropicUsage().catch(() => {}); }, 60_000); timer.unref?.(); }
  } catch { /* o registro é extra: nunca atrapalha a chamada */ }
}

export async function flushAnthropicUsage(): Promise<void> {
  if (!pending.size) return;
  const lote = pending;
  pending = new Map();
  const client = db();
  for (const [key, a] of lote) {
    const [day, feature, model] = JSON.parse(key) as [string, string, string];
    try {
      await client.$executeRaw`INSERT INTO "AiUsage" ("day","feature","model","calls","errors","inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","updatedAt")
        VALUES (${day}, ${feature}, ${model}, ${a.calls}, ${a.errors}, ${a.input}, ${a.output}, ${a.cacheRead}, ${a.cacheWrite}, NOW())
        ON CONFLICT ("day","feature","model") DO UPDATE SET
          "calls" = "AiUsage"."calls" + EXCLUDED."calls", "errors" = "AiUsage"."errors" + EXCLUDED."errors",
          "inputTokens" = "AiUsage"."inputTokens" + EXCLUDED."inputTokens", "outputTokens" = "AiUsage"."outputTokens" + EXCLUDED."outputTokens",
          "cacheReadTokens" = "AiUsage"."cacheReadTokens" + EXCLUDED."cacheReadTokens", "cacheWriteTokens" = "AiUsage"."cacheWriteTokens" + EXCLUDED."cacheWriteTokens",
          "updatedAt" = NOW()`;
    } catch (e: any) {
      // tabela ainda não existe / banco fora: devolve ao lote pra tentar de novo no próximo minuto (sem acumular sem limite)
      if (pending.size < 500) {
        const cur = pending.get(key) || { calls: 0, errors: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
        cur.calls += a.calls; cur.errors += a.errors; cur.input += a.input; cur.output += a.output; cur.cacheRead += a.cacheRead; cur.cacheWrite += a.cacheWrite;
        pending.set(key, cur);
      }
      console.warn('[Uso IA] não gravou:', e?.message?.slice(0, 120));
    }
  }
}

// Preço por 1 milhão de tokens (US$). Leitura de cache = 10% da entrada, gravação (5 min) = 125%.
// Sonnet 5 = 2/10 — CALIBRADO no console da Anthropic (Fabio 20/11, "corrige a estimativa da tela de custos"): 1–20/11 o console mostrou 94,9 mi de entrada,
// 57,4 mi de cache lido, 26,6 mi de cache gravado e 6,5 mi de saída = US$ 328,41 de tokens; com 2/10 dá US$ 332,71 (≈1% acima, a diferença é o Haiku, mais barato).
// O 3/15 suposto antes dava US$ 499 — 46% acima. Os tokens que o CRM grava batem com o console (173 mi × 179 mi de entrada; o console inclui o próprio console).
// Modelo com data no fim (claude-haiku-4-5-20251001) cai no preço da família pelo prefixo.
const PRECO: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};
export const precoDoModelo = (model: string) => {
  const m = String(model || '');
  const k = Object.keys(PRECO).find((x) => m === x || m.startsWith(`${x}-`));
  return PRECO[k || ''] || (/haiku/i.test(m) ? PRECO['claude-haiku-4-5'] : PRECO['claude-sonnet-5']);
};
export const estimarUsd = (model: string, r: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => {
  const p = precoDoModelo(model);
  return (r.inputTokens * p.in + r.cacheReadTokens * p.in * 0.1 + r.cacheWriteTokens * p.in * 1.25 + r.outputTokens * p.out) / 1_000_000;
};

export async function usageReport(days = 7) {
  await flushAnthropicUsage().catch(() => {});
  const desde = dayKey(Date.now() - (Math.max(1, Math.min(days, 60)) - 1) * 86400_000);
  const rows = await db().aiUsage.findMany({ where: { day: { gte: desde } }, orderBy: [{ day: 'desc' }, { feature: 'asc' }] });
  return rows.map((r) => ({ ...r, updatedAt: undefined, estUsd: Math.round(estimarUsd(r.model, r) * 100) / 100 }));
}
