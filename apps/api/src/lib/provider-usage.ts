import { prisma } from './prisma';

/**
 * Uso de fornecedores que cobram por volume e não passam pelo registro da Anthropic (AiUsage). Hoje: Voyage (tokens de embedding).
 * Agrega em memória e grava a cada minuto em "ProviderUsage" (dia no horário de Brasília × fornecedor × função). Nunca atrapalha a chamada.
 */
const BRT_MS = 3 * 3600_000;
const dayKey = () => new Date(Date.now() - BRT_MS).toISOString().slice(0, 10);

type Acc = { calls: number; units: number };
let pending = new Map<string, Acc>();
let timer: NodeJS.Timeout | null = null;

export function recordProviderUsage(provider: string, feature: string, units: number): void {
  try {
    const key = JSON.stringify([dayKey(), provider, feature]);
    const a = pending.get(key) || { calls: 0, units: 0 };
    a.calls += 1;
    a.units += Math.max(0, Math.round(Number(units) || 0));
    pending.set(key, a);
    if (!timer) { timer = setInterval(() => { flushProviderUsage().catch(() => {}); }, 60_000); timer.unref?.(); }
  } catch { /* o registro é extra */ }
}

export async function flushProviderUsage(): Promise<void> {
  if (!pending.size) return;
  const lote = pending;
  pending = new Map();
  for (const [key, a] of lote) {
    const [day, provider, feature] = JSON.parse(key) as [string, string, string];
    try {
      await prisma.$executeRaw`INSERT INTO "ProviderUsage" ("day","provider","feature","calls","units","updatedAt")
        VALUES (${day}, ${provider}, ${feature}, ${a.calls}, ${a.units}, NOW())
        ON CONFLICT ("day","provider","feature") DO UPDATE SET "calls" = "ProviderUsage"."calls" + EXCLUDED."calls", "units" = "ProviderUsage"."units" + EXCLUDED."units", "updatedAt" = NOW()`;
    } catch (e: any) {
      if (pending.size < 200) {
        const cur = pending.get(key) || { calls: 0, units: 0 };
        cur.calls += a.calls; cur.units += a.units;
        pending.set(key, cur);
      }
      console.warn('[Uso fornecedor] não gravou:', e?.message?.slice(0, 120));
    }
  }
}
