import { prisma } from '../lib/prisma';
import { estimarUsd, flushAnthropicUsage } from '../lib/anthropic-usage';
import { flushProviderUsage } from '../lib/provider-usage';

/**
 * PAINEL DE CUSTOS (Fabio 22/10: "API Anthropic, mensagens do WhatsApp, Voyage, Railway, campanha da Meta, tudo que for ligado ao CRM").
 * Por mês (horário de Brasília), em reais:
 *  - Anthropic: ESTIMATIVA pelo uso gravado em AiUsage (tokens × preço de tabela) — a fatura real entra como lançamento "fatura real" e substitui a estimativa;
 *  - WhatsApp: valor REAL cobrado pela Meta (pricing_analytics da conta do WhatsApp Business: categoria, volume e custo por dia);
 *  - Voyage: tokens gravados em ProviderUsage × preço de tabela (estimativa; a Voyage tem uma franquia grátis grande);
 *  - Railway: fatura REAL lida da API da Railway (RAILWAY_API_TOKEN, token do workspace) — cada fatura cai no mês em que foi cobrada (fim do ciclo, dia 18); sem o token, lançamento manual;
 *  - Anthropic com ANTHROPIC_ADMIN_KEY (chave de administrador do Console): custo REAL do cost_report no lugar da estimativa (Fabio 30/10);
 *  - Campanhas (Meta Ads): gasto REAL por campanha pelo insights da conta de anúncios (Fabio 14/11: "incluir no Custos os valores pagos de campanha") —
 *    usa META_ADS_TOKEN/META_ADS_ACCOUNT_ID se existirem, senão tenta o token do WhatsApp (só funciona se ele tiver ads_read). Sem acesso: lançamento manual por campanha;
 *  - ElevenLabs, domínio, e-mail, Google…: lançamentos manuais (CostEntry), únicos ou recorrentes.
 * Dólar: cotação fixa definida à mão (CostSetting.usdBrl) ou a do dia (AwesomeAPI, cache de 6 h; se cair, usa a última conhecida / 5,50).
 */

export const PROVIDERS: Record<string, string> = {
  RAILWAY: 'Railway (hospedagem)',
  META_ADS: 'Campanhas (Meta Ads)',
  ANTHROPIC: 'Anthropic (API da IA)',
  ANTHROPIC_PLANO: 'Anthropic (assinatura mensal)',
  WHATSAPP: 'WhatsApp (Meta)',
  VOYAGE: 'Voyage (busca da Base)',
  ELEVENLABS: 'ElevenLabs (voz)',
  GOOGLE: 'Google (Drive / Workspace)',
  EMAIL: 'E-mail (Titan)',
  DOMINIO: 'Domínio / Cloudflare',
  OUTRO: 'Outros',
};
const RAILWAY_TOKEN = () => process.env.RAILWAY_API_TOKEN || '';
const RAILWAY_WORKSPACE = () => process.env.RAILWAY_WORKSPACE_ID || '79b43c9c-8d5f-4d38-86cd-e9a4b994847c'; // "aefsolucoes's Projects"
const ANTHROPIC_ADMIN_KEY = () => process.env.ANTHROPIC_ADMIN_KEY || '';
const META_ADS_TOKEN = () => process.env.META_ADS_TOKEN || '';
const META_ADS_ACCOUNTS = () => (process.env.META_ADS_ACCOUNT_ID || '').split(',').map((s) => s.trim().replace(/^act_/, '')).filter((s) => /^\d+$/.test(s));
const autoProviders = () => ['ANTHROPIC', 'WHATSAPP', 'VOYAGE', ...(RAILWAY_TOKEN() ? ['RAILWAY'] : [])];
const VOYAGE_USD_POR_MILHAO = 0.06; // voyage-3.5 — preço de tabela SUPOSTO; a Voyage dá centenas de milhões de tokens grátis por conta
const FALLBACK_USD_BRL = 5.5;

const MONTH_RX = /^\d{4}-(0[1-9]|1[0-2])$/;
const BRT_MS = 3 * 3600_000;
export const currentMonth = () => new Date(Date.now() - BRT_MS).toISOString().slice(0, 7);
export const validMonth = (m: unknown): m is string => typeof m === 'string' && MONTH_RX.test(m);
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}
const round2 = (n: number) => Math.round(n * 100) / 100;

// ── cotação do dólar ─────────────────────────────────────────────────────────
let rateCache: { at: number; rate: number } | null = null;
async function autoRate(): Promise<{ rate: number; ok: boolean }> {
  if (rateCache && Date.now() - rateCache.at < 6 * 3600_000) return { rate: rateCache.rate, ok: true };
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 4000);
    const r = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', { signal: ctl.signal });
    clearTimeout(t);
    const j: any = await r.json();
    const bid = Number(j?.USDBRL?.bid);
    if (bid > 1 && bid < 50) { rateCache = { at: Date.now(), rate: bid }; return { rate: bid, ok: true }; }
  } catch { /* usa a última conhecida */ }
  return { rate: rateCache?.rate || FALLBACK_USD_BRL, ok: false };
}

export async function getRate(accountId: string): Promise<{ usdBrl: number; source: 'MANUAL' | 'AUTO' | 'ESTIMADA'; manual: number | null }> {
  const s = await prisma.costSetting.findUnique({ where: { accountId } });
  if (s?.usdBrl && s.usdBrl > 0) return { usdBrl: s.usdBrl, source: 'MANUAL', manual: s.usdBrl };
  const a = await autoRate();
  return { usdBrl: a.rate, source: a.ok ? 'AUTO' : 'ESTIMADA', manual: null };
}

export async function setRate(accountId: string, usdBrl: number | null): Promise<void> {
  if (usdBrl != null && !(usdBrl > 1 && usdBrl < 50)) throw new Error('Cotação inválida (use algo entre 1 e 50).');
  await prisma.costSetting.upsert({ where: { accountId }, create: { accountId, usdBrl }, update: { usdBrl } });
}

// ── WhatsApp (Meta): custo real por categoria ────────────────────────────────
type WaCat = { category: string; type: string; volume: number; cost: number };
type WaResult = { currency: string; total: number; volume: number; categories: WaCat[]; error?: string };
const waCache = new Map<string, { at: number; data: WaResult }>();

async function whatsappCost(accountId: string, month: string): Promise<WaResult> {
  const key = `${accountId}:${month}`;
  const cur = month === currentMonth();
  const hit = waCache.get(key);
  if (hit && Date.now() - hit.at < (cur ? 10 * 60_000 : 6 * 3600_000)) return hit.data;

  const empty: WaResult = { currency: 'USD', total: 0, volume: 0, categories: [] };
  const cfgs = await prisma.whatsAppConfig.findMany({ where: { accountId }, select: { wabaId: true, accessToken: true } });
  const wabas = new Map<string, string>();
  for (const c of cfgs) if (c.wabaId && c.accessToken && !wabas.has(c.wabaId)) wabas.set(c.wabaId, c.accessToken);
  if (!wabas.size) return { ...empty, error: 'API Oficial do WhatsApp não configurada (sem WABA).' };

  const start = Math.floor(new Date(`${month}-01T00:00:00-03:00`).getTime() / 1000);
  const next = Math.floor(new Date(`${addMonths(month, 1)}-01T00:00:00-03:00`).getTime() / 1000);
  const end = Math.min(next, Math.floor(Date.now() / 1000));
  if (end <= start) { waCache.set(key, { at: Date.now(), data: empty }); return empty; }

  const agg = new Map<string, WaCat>();
  let currency = 'USD';
  let error: string | undefined;
  for (const [waba, token] of wabas) {
    try {
      const url = `https://graph.facebook.com/v20.0/${waba}?fields=currency,pricing_analytics.start(${start}).end(${end}).granularity(DAILY).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])`;
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15_000);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
      clearTimeout(t);
      const j: any = await r.json();
      if (!r.ok || j.error) { error = j.error?.error_user_msg || j.error?.message || `HTTP ${r.status}`; continue; }
      if (j.currency) currency = String(j.currency);
      for (const p of j.pricing_analytics?.data?.[0]?.data_points || []) {
        const k = `${p.pricing_category}|${p.pricing_type}`;
        const a = agg.get(k) || { category: String(p.pricing_category || ''), type: String(p.pricing_type || ''), volume: 0, cost: 0 };
        a.volume += Number(p.volume) || 0;
        a.cost += Number(p.cost) || 0;
        agg.set(k, a);
      }
    } catch (e: any) { error = e?.name === 'AbortError' ? 'A Meta demorou demais pra responder.' : String(e?.message || e).slice(0, 160); }
  }
  const categories = [...agg.values()].sort((a, b) => b.cost - a.cost);
  const data: WaResult = { currency, total: categories.reduce((s, c) => s + c.cost, 0), volume: categories.reduce((s, c) => s + c.volume, 0), categories, ...(error && !categories.length ? { error } : {}) };
  if (!data.error) waCache.set(key, { at: Date.now(), data }); // não guarda falha (tenta de novo na próxima abertura)
  return data;
}

// ── Railway: faturas (GraphQL público da Railway) ────────────────────────────
type RwInvoice = { periodStart: string; periodEnd: string; total: number; amountPaid: number; status: string };
type RwData = { invoices: RwInvoice[]; currentUsage: number; periodEnd: string | null };
let rwCache: { at: number; data: RwData } | null = null;
const brtMonth = (iso: string) => new Date(new Date(iso).getTime() - BRT_MS).toISOString().slice(0, 7);

async function railwayData(): Promise<RwData | { error: string }> {
  if (rwCache && Date.now() - rwCache.at < 30 * 60_000) return rwCache.data;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    const r = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RAILWAY_TOKEN()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($id:String!){ workspace(workspaceId:$id){ customer { currentUsage billingPeriod { end } invoices { periodStart periodEnd total amountPaid status } } } }',
        variables: { id: RAILWAY_WORKSPACE() },
      }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const j: any = await r.json().catch(() => ({}));
    const c = j?.data?.workspace?.customer;
    if (!r.ok || !c) return { error: j?.errors?.[0]?.message || `HTTP ${r.status}` };
    const data: RwData = { invoices: (c.invoices || []).filter((i: any) => i?.periodEnd), currentUsage: Number(c.currentUsage) || 0, periodEnd: c.billingPeriod?.end || null };
    rwCache = { at: Date.now(), data };
    return data;
  } catch (e: any) { return { error: e?.name === 'AbortError' ? 'A Railway demorou demais pra responder.' : String(e?.message || e).slice(0, 160) }; }
}

// ── Anthropic: custo real (Admin API cost_report, valores em centavos de dólar) ─
const antCache = new Map<string, { at: number; usd: number }>();

async function anthropicRealCost(month: string): Promise<{ usd: number } | { error: string } | null> {
  if (!ANTHROPIC_ADMIN_KEY()) return null;
  const cur = month === currentMonth();
  const hit = antCache.get(month);
  if (hit && Date.now() - hit.at < (cur ? 30 * 60_000 : 12 * 3600_000)) return { usd: hit.usd };
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(Math.min(new Date(`${addMonths(month, 1)}-01T00:00:00Z`).getTime(), Date.now()));
  if (end <= start) return { usd: 0 };
  try {
    let cents = 0;
    let page: string | null = null;
    for (let i = 0; i < 5; i++) {
      const qs = new URLSearchParams({ starting_at: start.toISOString(), ending_at: end.toISOString(), bucket_width: '1d', limit: '31' });
      if (page) qs.set('page', page);
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15_000);
      const r = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?${qs}`, {
        headers: { 'x-api-key': ANTHROPIC_ADMIN_KEY(), 'anthropic-version': '2023-06-01' },
        signal: ctl.signal,
      });
      clearTimeout(t);
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j?.error?.message || `HTTP ${r.status}` };
      for (const b of j.data || []) for (const it of b.results || []) if (!it.currency || it.currency === 'USD') cents += Number(it.amount) || 0;
      if (!j.has_more || !j.next_page) break;
      page = j.next_page;
    }
    const usd = cents / 100;
    antCache.set(month, { at: Date.now(), usd });
    return { usd };
  } catch (e: any) { return { error: e?.name === 'AbortError' ? 'A Anthropic demorou demais pra responder.' : String(e?.message || e).slice(0, 160) }; }
}

// ── Campanhas (Meta Ads): gasto real por campanha (Graph API /act_{id}/insights) ─
type AdsAccount = { id: string; name: string; currency: string };
type AdsAccess = { ok: true; token: string; source: 'META_ADS_TOKEN' | 'WHATSAPP'; accounts: AdsAccount[] } | { ok: false; reason: string };
export type AdsCampaign = { id: string; name: string; account: string; currency: string; spend: number };
type AdsResult = { ok: true; source: string; accounts: AdsAccount[]; campaigns: AdsCampaign[]; error?: string } | { ok: false; reason: string };
const adsAccessCache = new Map<string, { at: number; p: Promise<AdsAccess> }>();
const adsCache = new Map<string, { at: number; data: AdsResult }>();

async function graphGet(url: string, token: string): Promise<{ ok: boolean; j: any }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctl.signal });
    const j: any = await r.json().catch(() => ({}));
    return { ok: r.ok && !j?.error, j };
  } catch (e: any) {
    return { ok: false, j: { error: { message: e?.name === 'AbortError' ? 'A Meta demorou demais pra responder.' : String(e?.message || e).slice(0, 160) } } };
  } finally { clearTimeout(t); }
}

/** Acha um token que enxergue a conta de anúncios: META_ADS_TOKEN (se o Fabio criar) ou o token do WhatsApp, se ele tiver ads_read. Cache de 1 h (inclusive do "sem acesso"). */
function adsAccess(accountId: string): Promise<AdsAccess> {
  const hit = adsAccessCache.get(accountId);
  if (hit && Date.now() - hit.at < 3600_000) return hit.p;
  const p = (async (): Promise<AdsAccess> => {
    const cands: { token: string; source: 'META_ADS_TOKEN' | 'WHATSAPP' }[] = [];
    if (META_ADS_TOKEN()) cands.push({ token: META_ADS_TOKEN(), source: 'META_ADS_TOKEN' });
    const cfgs = await prisma.whatsAppConfig.findMany({ where: { accountId }, select: { accessToken: true } });
    for (const c of cfgs) if (c.accessToken && !cands.some((x) => x.token === c.accessToken)) cands.push({ token: c.accessToken, source: 'WHATSAPP' });
    if (!cands.length) return { ok: false, reason: 'Nenhum token da Meta no CRM.' };
    const reasons: string[] = [];
    for (const c of cands) {
      const fixed = META_ADS_ACCOUNTS();
      if (fixed.length) {
        const accounts: AdsAccount[] = [];
        for (const id of fixed) {
          const r = await graphGet(`https://graph.facebook.com/v20.0/act_${id}?fields=name,currency`, c.token);
          if (r.ok) accounts.push({ id, name: String(r.j.name || `act_${id}`), currency: String(r.j.currency || 'BRL') });
          else reasons.push(`${c.source === 'WHATSAPP' ? 'token do WhatsApp' : 'META_ADS_TOKEN'}: ${r.j?.error?.message || 'sem acesso'}`);
        }
        if (accounts.length) return { ok: true, token: c.token, source: c.source, accounts };
        continue;
      }
      const r = await graphGet('https://graph.facebook.com/v20.0/me/adaccounts?fields=account_id,name,currency,account_status&limit=50', c.token);
      if (!r.ok) { reasons.push(`${c.source === 'WHATSAPP' ? 'token do WhatsApp' : 'META_ADS_TOKEN'}: ${r.j?.error?.message || 'sem acesso'}`); continue; }
      const accounts: AdsAccount[] = (r.j.data || []).filter((a: any) => a?.account_id).map((a: any) => ({ id: String(a.account_id), name: String(a.name || `act_${a.account_id}`), currency: String(a.currency || 'BRL') }));
      if (accounts.length) return { ok: true, token: c.token, source: c.source, accounts };
      reasons.push(`${c.source === 'WHATSAPP' ? 'token do WhatsApp' : 'META_ADS_TOKEN'}: não enxerga nenhuma conta de anúncios`);
    }
    return { ok: false, reason: reasons.join(' · ').slice(0, 400) };
  })().catch((e: any) => ({ ok: false as const, reason: String(e?.message || e).slice(0, 200) }));
  adsAccessCache.set(accountId, { at: Date.now(), p });
  return p;
}

async function metaAdsCost(accountId: string, month: string): Promise<AdsResult> {
  const key = `${accountId}:${month}`;
  const cur = month === currentMonth();
  const hit = adsCache.get(key);
  if (hit && Date.now() - hit.at < (cur ? 30 * 60_000 : 6 * 3600_000)) return hit.data;
  const acc = await adsAccess(accountId);
  if (!acc.ok) return { ok: false, reason: acc.reason };
  const since = `${month}-01`;
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const today = new Date(Date.now() - BRT_MS).toISOString().slice(0, 10);
  const until = lastDay < today ? lastDay : today;
  if (until < since) return { ok: true, source: acc.source, accounts: acc.accounts, campaigns: [] };
  const campaigns: AdsCampaign[] = [];
  const errors: string[] = [];
  for (const a of acc.accounts) {
    const qs = new URLSearchParams({ fields: 'campaign_id,campaign_name,spend', level: 'campaign', time_range: JSON.stringify({ since, until }), limit: '200' });
    let url: string | null = `https://graph.facebook.com/v20.0/act_${a.id}/insights?${qs}`;
    for (let i = 0; url && i < 5; i++) {
      const r = await graphGet(url, acc.token);
      if (!r.ok) { errors.push(`${a.name}: ${r.j?.error?.error_user_msg || r.j?.error?.message || 'erro'}`); break; }
      for (const row of r.j.data || []) {
        const spend = Number(row.spend) || 0;
        if (spend > 0) campaigns.push({ id: String(row.campaign_id || ''), name: String(row.campaign_name || 'Campanha'), account: a.name, currency: a.currency, spend });
      }
      url = r.j.paging?.next || null;
    }
  }
  campaigns.sort((x, y) => y.spend - x.spend);
  const data: AdsResult = { ok: true, source: acc.source, accounts: acc.accounts, campaigns, ...(errors.length ? { error: errors.join(' · ').slice(0, 300) } : {}) };
  if (!errors.length) adsCache.set(key, { at: Date.now(), data });
  return data;
}

// ── lançamentos manuais ──────────────────────────────────────────────────────
export type EntryDTO = {
  id: string; provider: string; label: string; amount: number; currency: string; month: string; recurring: boolean; endMonth: string | null; kind: string; campaign: string | null; note: string | null;
};
const toDto = (e: any): EntryDTO => ({ id: e.id, provider: e.provider, label: e.label, amount: e.amountCents / 100, currency: e.currency, month: e.month, recurring: !!e.recurring, endMonth: e.endMonth || null, kind: e.kind, campaign: e.campaign || null, note: e.note || null });
const appliesTo = (e: { month: string; recurring: boolean; endMonth: string | null }, month: string) =>
  e.recurring ? e.month <= month && (!e.endMonth || e.endMonth >= month) : e.month === month;

export async function listEntries(accountId: string, month: string): Promise<EntryDTO[]> {
  const rows = await prisma.costEntry.findMany({ where: { accountId, month: { lte: month } }, orderBy: [{ createdAt: 'asc' }] });
  return rows.map(toDto).filter((e) => appliesTo(e, month));
}

export type EntryInput = { provider: string; label: string; amount: number; currency?: string; month: string; recurring?: boolean; endMonth?: string | null; kind?: string; campaign?: string | null; note?: string | null };
function cleanEntry(b: Partial<EntryInput>): { provider: string; label: string; amountCents: number; currency: string; month: string; recurring: boolean; endMonth: string | null; kind: string; campaign: string | null; note: string | null } {
  const provider = String(b.provider || '').toUpperCase();
  if (!PROVIDERS[provider]) throw new Error('Fornecedor inválido.');
  const amount = Number(b.amount);
  if (!(amount > 0) || amount > 10_000_000) throw new Error('Informe um valor maior que zero.');
  const currency = String(b.currency || 'BRL').toUpperCase();
  if (currency !== 'BRL' && currency !== 'USD') throw new Error('Moeda inválida (BRL ou USD).');
  if (!validMonth(b.month)) throw new Error('Mês inválido (use AAAA-MM).');
  const recurring = !!b.recurring;
  const endMonth = recurring && b.endMonth ? String(b.endMonth) : null;
  if (endMonth && (!validMonth(endMonth) || endMonth < b.month)) throw new Error('O mês final precisa ser igual ou depois do mês inicial.');
  const kind = String(b.kind || 'EXTRA').toUpperCase() === 'ACTUAL' ? 'ACTUAL' : 'EXTRA';
  const campaign = provider === 'META_ADS' && b.campaign ? String(b.campaign).trim().slice(0, 120) || null : null;
  const label = String(b.label || '').trim().slice(0, 120) || campaign || PROVIDERS[provider];
  return { provider, label, amountCents: Math.round(amount * 100), currency, month: b.month, recurring, endMonth, kind, campaign, note: b.note ? String(b.note).trim().slice(0, 300) || null : null };
}

export async function createEntry(accountId: string, userId: string, body: Partial<EntryInput>): Promise<EntryDTO> {
  return toDto(await prisma.costEntry.create({ data: { accountId, createdById: userId, ...cleanEntry(body) } }));
}
export async function updateEntry(accountId: string, id: string, body: Partial<EntryInput>): Promise<EntryDTO> {
  const cur = await prisma.costEntry.findFirst({ where: { id, accountId } });
  if (!cur) throw new Error('Lançamento não encontrado.');
  const merged: Partial<EntryInput> = { provider: cur.provider, label: cur.label, amount: cur.amountCents / 100, currency: cur.currency, month: cur.month, recurring: cur.recurring, endMonth: cur.endMonth, kind: cur.kind, campaign: cur.campaign, note: cur.note, ...body };
  return toDto(await prisma.costEntry.update({ where: { id }, data: cleanEntry(merged) }));
}
export async function deleteEntry(accountId: string, id: string): Promise<void> {
  const r = await prisma.costEntry.deleteMany({ where: { id, accountId } });
  if (!r.count) throw new Error('Lançamento não encontrado.');
}

// ── o mês ────────────────────────────────────────────────────────────────────
export type ProviderBlock = {
  provider: string; label: string; brl: number; usd: number;
  /** origem do número: automático (estimativa/real lido da API) e/ou lançamentos manuais */
  auto: null | { kind: 'ESTIMATIVA' | 'REAL'; brl: number; usd: number; noData?: boolean; error?: string; detail: Record<string, unknown> };
  manual: (EntryDTO & { brl: number })[];
  replacedAuto: boolean; // há uma fatura real que substituiu a estimativa
};
export type MonthCosts = { month: string; totalBrl: number; providers: ProviderBlock[]; metaAds: { auto: true; source: string; accounts: number } | { auto: false; reason: string } };

async function monthCosts(accountId: string, month: string, usdBrl: number, entries: EntryDTO[], withDetail: boolean): Promise<MonthCosts> {
  const from = `${month}-01`;
  const toExcl = `${addMonths(month, 1)}-01`;
  const ads = await metaAdsCost(accountId, month);
  const AUTO = [...autoProviders(), ...(ads.ok ? ['META_ADS'] : [])];
  const blocks = new Map<string, ProviderBlock>();
  const block = (p: string): ProviderBlock => {
    let b = blocks.get(p);
    if (!b) { b = { provider: p, label: PROVIDERS[p] || p, brl: 0, usd: 0, auto: null, manual: [], replacedAuto: false }; blocks.set(p, b); }
    return b;
  };

  // Anthropic — estimativa pelo uso gravado
  const ai = await prisma.aiUsage.findMany({ where: { day: { gte: from, lt: toExcl } } });
  {
    const byFeature = new Map<string, { usd: number; calls: number }>();
    let usd = 0, calls = 0, errors = 0, tokensIn = 0, tokensOut = 0;
    for (const r of ai) {
      const u = estimarUsd(r.model, r);
      usd += u; calls += r.calls; errors += r.errors; tokensIn += r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens; tokensOut += r.outputTokens;
      const f = byFeature.get(r.feature) || { usd: 0, calls: 0 }; f.usd += u; f.calls += r.calls; byFeature.set(r.feature, f);
    }
    const detail: Record<string, unknown> = { calls, errors, tokensIn, tokensOut, firstDay: ai.length ? ai.reduce((m, r) => (r.day < m ? r.day : m), ai[0].day) : null };
    if (withDetail) detail.topFeatures = [...byFeature].sort((a, b) => b[1].usd - a[1].usd).slice(0, 10).map(([feature, v]) => ({ feature, usd: round2(v.usd), calls: v.calls }));
    const real = await anthropicRealCost(month);
    if (real && 'usd' in real) {
      detail.estimativaUsd = round2(usd);
      block('ANTHROPIC').auto = { kind: 'REAL', usd: round2(real.usd), brl: round2(real.usd * usdBrl), noData: real.usd === 0 && !ai.length, detail };
    } else {
      if (real?.error) detail.realError = real.error;
      block('ANTHROPIC').auto = { kind: 'ESTIMATIVA', usd: round2(usd), brl: round2(usd * usdBrl), noData: !ai.length, detail };
    }
  }

  // Railway — fatura real (só com RAILWAY_API_TOKEN)
  if (RAILWAY_TOKEN()) {
    const rw = await railwayData();
    if ('error' in rw) block('RAILWAY').auto = { kind: 'REAL', usd: 0, brl: 0, error: rw.error, detail: {} };
    else {
      const faturas = rw.invoices.filter((i) => brtMonth(i.periodEnd) === month);
      const cents = faturas.reduce((s, i) => s + (i.status === 'paid' ? i.amountPaid : i.total), 0);
      const usd = Math.max(0, cents) / 100;
      const detail: Record<string, unknown> = {
        faturas: faturas.map((i) => ({ de: i.periodStart.slice(0, 10), ate: i.periodEnd.slice(0, 10), usd: round2((i.status === 'paid' ? i.amountPaid : i.total) / 100), status: i.status })),
      };
      if (month === currentMonth()) { detail.cicloAtualUsd = round2(rw.currentUsage); detail.cicloAte = rw.periodEnd?.slice(0, 10) || null; }
      block('RAILWAY').auto = { kind: 'REAL', usd: round2(usd), brl: round2(usd * usdBrl), noData: !faturas.length && month !== currentMonth(), detail };
    }
  }

  // Voyage — tokens × preço de tabela
  {
    const rows = await prisma.providerUsage.findMany({ where: { provider: 'VOYAGE', day: { gte: from, lt: toExcl } } });
    const tokens = rows.reduce((s, r) => s + r.units, 0);
    const usd = (tokens / 1_000_000) * VOYAGE_USD_POR_MILHAO;
    block('VOYAGE').auto = { kind: 'ESTIMATIVA', usd: round2(usd), brl: round2(usd * usdBrl), noData: !rows.length, detail: { tokens, calls: rows.reduce((s, r) => s + r.calls, 0), usdPorMilhao: VOYAGE_USD_POR_MILHAO } };
  }

  // WhatsApp — custo real da Meta
  {
    const wa = await whatsappCost(accountId, month);
    const rate = wa.currency === 'BRL' ? 1 : usdBrl;
    const brl = wa.total * rate;
    block('WHATSAPP').auto = {
      kind: 'REAL', usd: wa.currency === 'BRL' ? round2(brl / usdBrl) : round2(wa.total), brl: round2(brl), error: wa.error, noData: !wa.categories.length && !wa.error,
      detail: { currency: wa.currency, volume: wa.volume, categories: wa.categories.map((c) => ({ ...c, cost: Math.round(c.cost * 10000) / 10000, costBrl: round2(c.cost * rate) })) },
    };
  }

  // Campanhas (Meta Ads) — gasto real por campanha; sem acesso, fica só o manual (a linha aparece sempre)
  {
    const b = block('META_ADS');
    if (ads.ok) {
      const toBrl = (c: { currency: string; spend: number }) => (c.currency === 'BRL' ? c.spend : c.currency === 'USD' ? c.spend * usdBrl : c.spend);
      const brl = ads.campaigns.reduce((s, c) => s + toBrl(c), 0);
      b.auto = {
        kind: 'REAL', brl: round2(brl), usd: usdBrl > 0 ? round2(brl / usdBrl) : 0, error: ads.error && !ads.campaigns.length ? ads.error : undefined, noData: !ads.campaigns.length && !ads.error,
        detail: { source: ads.source, accounts: ads.accounts.map((a) => ({ id: `act_${a.id}`, name: a.name, currency: a.currency })), campaigns: ads.campaigns.map((c) => ({ ...c, spend: round2(c.spend), brl: round2(toBrl(c)) })), ...(ads.error && ads.campaigns.length ? { partialError: ads.error } : {}) },
      };
    }
  }

  // lançamentos manuais
  for (const e of entries) {
    if (!appliesTo(e, month)) continue;
    const eBrl = e.currency === 'USD' ? e.amount * usdBrl : e.amount;
    block(e.provider).manual.push({ ...e, brl: round2(eBrl) });
  }

  // totais por fornecedor: fatura real substitui a estimativa automática
  for (const b of blocks.values()) {
    const actual = b.manual.filter((m) => m.kind === 'ACTUAL');
    const rest = b.manual.filter((m) => m.kind !== 'ACTUAL' || !AUTO.includes(b.provider));
    const manualBrl = b.manual.reduce((s, m) => s + m.brl, 0);
    if (b.auto && actual.length && AUTO.includes(b.provider)) {
      b.replacedAuto = true;
      b.brl = round2(actual.reduce((s, m) => s + m.brl, 0) + rest.reduce((s, m) => s + m.brl, 0));
    } else {
      b.brl = round2((b.auto?.brl || 0) + manualBrl);
    }
    b.usd = usdBrl > 0 ? round2(b.brl / usdBrl) : 0;
  }
  const providers = [...blocks.values()].filter((b) => b.brl > 0 || b.manual.length || (b.auto && !b.auto.noData) || b.auto?.error || AUTO.includes(b.provider) || b.provider === 'META_ADS');
  providers.sort((a, b) => b.brl - a.brl);
  return { month, totalBrl: round2(providers.reduce((s, b) => s + b.brl, 0)), providers, metaAds: ads.ok ? { auto: true as const, source: ads.source, accounts: ads.accounts.length } : { auto: false as const, reason: ads.reason } };
}

export async function costsOverview(accountId: string, month: string, months = 6) {
  await Promise.all([flushAnthropicUsage().catch(() => {}), flushProviderUsage().catch(() => {})]);
  const rate = await getRate(accountId);
  const all = await prisma.costEntry.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } });
  const entries = all.map(toDto);
  const monthsList = Array.from({ length: Math.max(1, Math.min(months, 12)) }, (_, i) => addMonths(month, -(Math.max(1, Math.min(months, 12)) - 1 - i)));
  const results = await Promise.all(monthsList.map((m) => monthCosts(accountId, m, rate.usdBrl, entries, m === month)));
  const selected = results[results.length - 1];
  const adsAuto = selected.metaAds.auto;
  return {
    month,
    rate,
    selected,
    metaAds: selected.metaAds,
    trend: results.map((r) => ({ month: r.month, totalBrl: r.totalBrl, byProvider: Object.fromEntries(r.providers.filter((p) => p.brl > 0).map((p) => [p.provider, p.brl])) })),
    entries: entries.filter((e) => appliesTo(e, month)),
    providerOptions: Object.entries(PROVIDERS).map(([key, label]) => ({ key, label, auto: autoProviders().includes(key) || (key === 'META_ADS' && adsAuto) })),
  };
}
