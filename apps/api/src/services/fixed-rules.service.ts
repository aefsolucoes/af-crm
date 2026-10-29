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
  ROLE_FRAMING: '[REGRA FIXA] IA do cliente — quem ela é (ROLE_FRAMING)',
  HANDOFF_RULES: '[REGRA FIXA] IA do cliente — WhatsApp único / passar pra equipe (HANDOFF_RULES)',
  ASK_TEAM_RULES: '[REGRA FIXA] IA do cliente — perguntar à equipe (ASK_TEAM_RULES)',
  MOVE_STAGE_RULES: '[REGRA FIXA] IA do cliente — mudar o card de etapa (MOVE_STAGE_RULES)',
  NEW_VALUE_RULES: '[REGRA FIXA] IA do cliente — valor novo pedido (NEW_VALUE_RULES)',
  PROPERTY_DOCS_RULES: '[REGRA FIXA] IA do cliente — documentos do imóvel (PROPERTY_DOCS_RULES)',
  RETENTION_RULES: '[REGRA FIXA] IA do cliente — retenção / cliente desistindo (RETENTION_RULES)',
  OUTRO_CANAL_RULES: '[REGRA FIXA] IA do cliente — outro canal (OUTRO_CANAL_RULES)',
  APARTMENT_APPRAISAL_RULES: '[REGRA FIXA] IA do cliente — laudo do apartamento (APARTMENT_APPRAISAL_RULES)',
  MARK_LOST_RULES: '[REGRA FIXA] IA do cliente — marcar Perdido (MARK_LOST_RULES)',
  STOP_FOLLOWUP_RULES: '[REGRA FIXA] IA do cliente — parar o follow-up (STOP_FOLLOWUP_RULES)',
  FORM_FIRST_RULES: '[REGRA FIXA] IA do cliente — formulário primeiro (FORM_FIRST_RULES)',
  CONVERSE_BEFORE_LINK_RULES: '[REGRA FIXA] IA do cliente — conversar antes do link (CONVERSE_BEFORE_LINK_RULES)',
  PROPOSAL_REVIEW_RULES: '[REGRA FIXA] IA do cliente — revisar a proposta (PROPOSAL_REVIEW_RULES)',
  CREDIT_ANALYSIS_RULES: '[REGRA FIXA] IA do cliente — análise de crédito (CREDIT_ANALYSIS_RULES)',
  NO_RECEIPT_LIST_RULES: '[REGRA FIXA] IA do cliente — não listar o que recebeu (NO_RECEIPT_LIST_RULES)',
  NO_REPLY_RULES: '[REGRA FIXA] IA do cliente — quando não responder (NO_REPLY_RULES)',
  DOCS_ARRIVING_RULES: '[REGRA FIXA] IA do cliente — documentos chegando (DOCS_ARRIVING_RULES)',
  EMAIL_RELAY_RULES: '[REGRA FIXA] IA — e-mails do processo (EMAIL_RELAY_RULES)',
  DOCS_CHECKER_RULES: '[REGRA FIXA] Conferência de documentos (DOCS_CHECKER_RULES) — não mude o formato JSON',
  EMAIL_SUGGESTION_RULES: '[REGRA FIXA] Sugestão de e-mail (EMAIL_SUGGESTION_RULES)',
  SUGGESTION_ROLE_FRAMING: '[REGRA FIXA] Sugestão de resposta — quem ela é (SUGGESTION_ROLE_FRAMING)',
  TEMPLATE_ROLE: '[REGRA FIXA] Sugestão de template (TEMPLATE_ROLE)',
};

/** Vários blocos de uma vez: { CHAVE: texto do código } → { CHAVE: texto vigente }. */
export async function fixedRules<T extends Record<string, string>>(accountId: string, defaults: T): Promise<T> {
  const keys = Object.keys(defaults);
  const vals = await Promise.all(keys.map((k) => fixedRule(accountId, k, defaults[k])));
  return Object.fromEntries(keys.map((k, i) => [k, vals[i]])) as T;
}

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
