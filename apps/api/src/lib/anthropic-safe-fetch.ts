/** A API da Anthropic recusa (HTTP 400 "unexpected end of hex escape") o corpo com "metade de emoji" — um .slice(0, N) que corta um par substituto
 *  (😀 = 😀) deixa só \ud83d no JSON. Cada serviço que mandava histórico de conversa cortado caía nisso e a função devolvia null em silêncio
 *  (conferência de documentos da Maria Antônia nunca avaliava, 15/10/2026). Em vez de caçar cada slice, tira os substitutos soltos de TODO corpo enviado
 *  pra api.anthropic.com. */
import { featureFromStack, recordAnthropicUsage } from './anthropic-usage';

const LONE_HIGH = /\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})/g;
const LONE_LOW = /(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}/g;

export function stripLoneSurrogates(json: string): string {
  return json.replace(LONE_HIGH, '').replace(LONE_LOW, '');
}

/** A Anthropic recusou por LIMITE DE USO ou SALDO (16/10: "You have reached your specified API usage limits… regain access on 2026-11-01"): toda IA do CRM para em silêncio.
 *  Avisa a equipe por push (no máximo 1 vez a cada 6 h) pra alguém aumentar o limite/colocar crédito no console da Anthropic. */
let ultimoAlerta = 0;
export function alertAnthropicDown(detalhe: string): void {
  if (Date.now() - ultimoAlerta < 6 * 3_600_000) return;
  ultimoAlerta = Date.now();
  console.error('[ANTHROPIC SEM LIMITE/CRÉDITO] a IA do CRM parou:', detalhe);
  (async () => {
    try {
      const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
      const prisma = new PrismaClient();
      const contas = await prisma.account.findMany({ select: { id: true } });
      const { sendPushToAccount } = require('../services/push.service') as typeof import('../services/push.service');
      const quando = /regain access on ([^.]+)\./i.exec(detalhe)?.[1];
      for (const c of contas) await sendPushToAccount(c.id, { title: '🚨 A IA do CRM parou', body: `A Anthropic recusou por limite de uso/saldo${quando ? ` (volta em ${quando})` : ''}. Aumente o limite no console da Anthropic (Settings → Limits).` }).catch(() => {});
      await prisma.$disconnect();
    } catch { /* push é extra */ }
  })();
}

export function installAnthropicSafeFetch(): void {
  const original = globalThis.fetch;
  if (!original || (original as any).__anthropicSafe) return;
  const wrapped = ((input: any, init?: any) => {
    try {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.includes('api.anthropic.com') && init && typeof init.body === 'string') init = { ...init, body: stripLoneSurrogates(init.body) };
    } catch { /* se algo estranho, manda como veio */ }
    // quem está chamando (arquivo:função) — lido já, enquanto a pilha ainda tem o serviço
    let feature = 'desconhecido', model = 'desconhecido';
    try {
      const url0 = typeof input === 'string' ? input : input?.url || String(input);
      if (url0.includes('api.anthropic.com')) {
        feature = featureFromStack(new Error().stack || '');
        if (init && typeof init.body === 'string') model = (/"model":"([^"]+)"/.exec(init.body) || [])[1] || model;
      }
    } catch { /* ignora */ }
    const out = original(input, init);
    try {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.includes('api.anthropic.com')) {
        return out.then(async (res) => {
          // uso (tokens) por função — em segundo plano, sem atrasar quem chamou
          res.clone().json().then((j: any) => recordAnthropicUsage(feature, j?.model || model, j?.usage || null, res.ok)).catch(() => recordAnthropicUsage(feature, model, null, res.ok));
          if (!res.ok && (res.status === 400 || res.status === 402 || res.status === 429)) {
            const txt = await res.clone().text().catch(() => '');
            if (/usage limits|credit balance|billing|quota/i.test(txt)) alertAnthropicDown(txt.slice(0, 220));
          }
          return res;
        });
      }
    } catch { /* o alerta é extra */ }
    return out;
  }) as typeof fetch;
  (wrapped as any).__anthropicSafe = true;
  globalThis.fetch = wrapped;
}
