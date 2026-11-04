/** DOIS CAMINHOS ATÉ O SERVIDOR (Fabio 04/11: "coloca as duas pontes, caso falhe uma terá o outro"). Em 04/11 o IPv4 da Onitel caiu
 *  no escritório e o endereço direto da Railway (só IPv4) parou de abrir — a tela vinha vazia no computador e no celular. A ponte na
 *  Cloudflare (Worker af-api-proxy) entra por IPv6 e repassa tudo pro mesmo servidor. O DIRETO é o preferido (sem limite; a ponte é o
 *  plano grátis, 100 mil requisições/dia) — a ponte só entra quando o direto não responde. A escolha fica guardada no navegador e é
 *  reconferida a cada 2 min, a cada erro de rede e quando a aba/rede volta; com o direto de volta, o CRM volta pra ele sozinho. */
const DIRECT = 'https://af-crm-production.up.railway.app';
const BRIDGE = 'https://af-api-proxy.fbn-fabin.workers.dev';
const ENV = process.env.NEXT_PUBLIC_API_URL || '';
/** Desenvolvimento local (NEXT_PUBLIC_API_URL=http://localhost:3001) usa só o endereço do .env. */
export const API_BASES: string[] = /localhost|127\.0\.0\.1/.test(ENV) ? [ENV] : [DIRECT, BRIDGE];
const KEY = 'af_api_base';

function stored(): string | null {
  try { const v = localStorage.getItem(KEY); return v && API_BASES.includes(v) ? v : null; } catch { return null; }
}

let current: string = stored() || API_BASES[0];
const listeners = new Set<(base: string) => void>();

export function apiBase(): string { return current; }

export function onApiBaseChange(fn: (base: string) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function setBase(base: string) {
  if (base === current) return;
  current = base;
  try { localStorage.setItem(KEY, base); } catch { /* aba anônima */ }
  listeners.forEach((fn) => { try { fn(base); } catch { /* ignora */ } });
}

async function ping(base: string, ms = 4000): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return (await fetch(`${base}/health`, { signal: ctl.signal, cache: 'no-store' })).ok; } catch { return false; } finally { clearTimeout(t); }
}

let probing: Promise<string> | null = null;
/** Confere os dois caminhos ao mesmo tempo: o direto respondeu → direto; senão, a ponte respondeu → ponte; nenhum → fica como está.
 *  Uma conferência por vez (chamadas simultâneas esperam a mesma). */
export function probeApiBase(): Promise<string> {
  if (API_BASES.length < 2) return Promise.resolve(current);
  if (!probing) {
    probing = (async () => {
      const [direct, bridge] = API_BASES;
      const okBridge = ping(bridge);
      if (await ping(direct)) setBase(direct);
      else if (await okBridge) setBase(bridge);
      return current;
    })().finally(() => { setTimeout(() => { probing = null; }, 0); });
  }
  return probing;
}

/** Primeira visita (nada guardado): as chamadas esperam a 1ª conferência (até ~4 s) pra não ficarem presas num caminho fora do ar. */
export const firstProbe: Promise<string> | null = typeof window !== 'undefined' && API_BASES.length > 1
  ? (stored() ? null : probeApiBase())
  : null;

if (typeof window !== 'undefined' && API_BASES.length > 1) {
  if (stored()) probeApiBase();
  setInterval(() => { if (document.visibilityState === 'visible') probeApiBase(); }, 120_000);
  window.addEventListener('online', () => { probeApiBase(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') probeApiBase(); });
}
