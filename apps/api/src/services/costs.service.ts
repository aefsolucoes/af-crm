import { prisma } from '../lib/prisma';
import { estimarUsd, flushAnthropicUsage } from '../lib/anthropic-usage';
import { flushProviderUsage } from '../lib/provider-usage';

/**
 * PAINEL DE CUSTOS (Fabio 22/10: "API Anthropic, mensagens do WhatsApp, Voyage, Railway, campanha da Meta, tudo que for ligado ao CRM").
 *
 * 14/11 (Fabio): "custos pagos e custos estimados para o mês" · "fazemos pagamentos pelo cartão, ele fecha dia 22" ·
 * "precisa saber a estimativa de quanto já foi para a próxima fatura, vencimento da fatura é dia 27" · Meta: "datas de pagamentos, não estimativas".
 * Cada fornecedor, num período (mês do calendário ou ciclo da fatura do cartão), tem:
 *  - PAGO: cobranças no cartão COM DATA — lançamentos (dia da cobrança; o recorrente cobra no mesmo dia todo mês) e, quando há chave,
 *    as faturas da Railway (RAILWAY_API_TOKEN) e as cobranças da conta de anúncios da Meta (META_ADS_TOKEN, ads_read).
 *    Com a cobrança automática respondendo, os lançamentos manuais daquele fornecedor saem da conta (eram o substituto dela);
 *  - PREVISTO: cobrança com data ainda por vir dentro do período (recorrente, fatura em aberto);
 *  - CONSUMO: uso medido — WhatsApp real (pricing_analytics da Meta), Anthropic real (cost_report com ANTHROPIC_ADMIN_KEY) ou estimado pelo
 *    uso gravado (AiUsage), Voyage (ProviderUsage), campanhas (insights da conta de anúncios), Railway (faturas + uso do ciclo atual);
 *  - ESTIMADO = max(pago + previsto, consumo projetado até o fim do período). CUSTO ATÉ AGORA = max(pago, consumo até hoje) — base do custo por lead.
 * Fatura do cartão: do dia seguinte ao fechamento do mês anterior até o fechamento (padrão 23 → 22), vence no dia 27 (CostSetting).
 * Dólar do cartão = cotação (fixa ou do dia) + IOF de 3,5% das compras internacionais no cartão.
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
const META_ADS_DEFAULT_ACCOUNT = '715653250943529'; // "CA 01 - A&F", do portfólio A&F no Gerenciador de Negócios
const META_ADS_ACCOUNTS = () => {
  const env = (process.env.META_ADS_ACCOUNT_ID || '').split(',').map((s) => s.trim().replace(/^act_/, '')).filter((s) => /^\d+$/.test(s));
  return env.length ? env : [META_ADS_DEFAULT_ACCOUNT];
};
const VOYAGE_USD_POR_MILHAO = 0.06; // voyage-3.5 — preço de tabela SUPOSTO; a Voyage dá centenas de milhões de tokens grátis por conta
const FALLBACK_USD_BRL = 5.5;
const IOF_CARTAO = 0.035; // IOF das compras internacionais no cartão de crédito

const MONTH_RX = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RX = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const BRT_MS = 3 * 3600_000;
export const currentMonth = () => new Date(Date.now() - BRT_MS).toISOString().slice(0, 7);
const todayBrt = () => new Date(Date.now() - BRT_MS).toISOString().slice(0, 10);
const brtDate = (ms: number) => new Date(ms - BRT_MS).toISOString().slice(0, 10);
export const validMonth = (m: unknown): m is string => typeof m === 'string' && MONTH_RX.test(m);
export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}
const lastDayOf = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const dayOf = (month: string, day: number) => `${month}-${String(Math.max(1, Math.min(day, lastDayOf(month)))).padStart(2, '0')}`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const daysFrom = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
const round2 = (n: number) => Math.round(n * 100) / 100;

type Range = { from: string; to: string }; // datas inclusivas, horário de Brasília
const monthRange = (m: string): Range => ({ from: `${m}-01`, to: dayOf(m, 31) });
/** Ciclo da fatura que FECHA no mês m: do dia seguinte ao fechamento do mês anterior até o fechamento. */
const cycleRange = (m: string, closingDay: number): Range => ({ from: addDays(dayOf(addMonths(m, -1), closingDay), 1), to: dayOf(m, closingDay) });
/** Fatura em aberto hoje: a deste mês se ainda não fechou; senão, a do mês que vem. */
const openStatementMonth = (closingDay: number) => {
  const m = currentMonth();
  return todayBrt() <= dayOf(m, closingDay) ? m : addMonths(m, 1);
};

// ── cotação do dólar + fatura do cartão ─────────────────────────────────────
let rateCache: { at: number; rate: number } | null = null;
async function fetchJson(url: string, ms = 4000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); return await r.json(); } finally { clearTimeout(t); }
}
async function autoRate(): Promise<{ rate: number; ok: boolean }> {
  if (rateCache && Date.now() - rateCache.at < 6 * 3600_000) return { rate: rateCache.rate, ok: true };
  // AwesomeAPI às vezes não responde pro servidor da Railway — a segunda fonte cobre
  const sources: [string, (j: any) => number][] = [
    ['https://economia.awesomeapi.com.br/json/last/USD-BRL', (j) => Number(j?.USDBRL?.bid)],
    ['https://open.er-api.com/v6/latest/USD', (j) => Number(j?.rates?.BRL)],
  ];
  for (const [url, pick] of sources) {
    try {
      const bid = pick(await fetchJson(url));
      if (bid > 1 && bid < 50) { rateCache = { at: Date.now(), rate: bid }; return { rate: bid, ok: true }; }
    } catch { /* tenta a próxima */ }
  }
  return { rate: rateCache?.rate || FALLBACK_USD_BRL, ok: false };
}

export type CostSettingsDTO = {
  usdBrl: number; source: 'MANUAL' | 'AUTO' | 'ESTIMADA'; manual: number | null;
  iof: number; cardRate: number; closingDay: number; dueDay: number;
};
export async function getSettings(accountId: string): Promise<CostSettingsDTO> {
  const s = await prisma.costSetting.findUnique({ where: { accountId } });
  let usdBrl: number, source: CostSettingsDTO['source'], manual: number | null = null;
  if (s?.usdBrl && s.usdBrl > 0) { usdBrl = s.usdBrl; source = 'MANUAL'; manual = s.usdBrl; }
  else { const a = await autoRate(); usdBrl = a.rate; source = a.ok ? 'AUTO' : 'ESTIMADA'; }
  return { usdBrl, source, manual, iof: IOF_CARTAO, cardRate: Math.round(usdBrl * (1 + IOF_CARTAO) * 10000) / 10000, closingDay: s?.cardClosingDay ?? 22, dueDay: s?.cardDueDay ?? 27 };
}

/** Atualiza só o que veio: usdBrl (número = fixa; null = automática), cardClosingDay, cardDueDay. */
export async function setSettings(accountId: string, b: { usdBrl?: number | null; cardClosingDay?: number; cardDueDay?: number }): Promise<void> {
  const data: { usdBrl?: number | null; cardClosingDay?: number; cardDueDay?: number } = {};
  if (b.usdBrl !== undefined) {
    if (b.usdBrl != null && !(b.usdBrl > 1 && b.usdBrl < 50)) throw new Error('Cotação inválida (use algo entre 1 e 50).');
    data.usdBrl = b.usdBrl;
  }
  for (const k of ['cardClosingDay', 'cardDueDay'] as const) {
    if (b[k] === undefined) continue;
    const d = Number(b[k]);
    if (!(Number.isInteger(d) && d >= 1 && d <= 31)) throw new Error('Dia inválido (1 a 31).');
    data[k] = d;
  }
  await prisma.costSetting.upsert({ where: { accountId }, create: { accountId, ...data }, update: data });
}

// ── WhatsApp (Meta): custo real por categoria ────────────────────────────────
type WaCat = { category: string; type: string; volume: number; cost: number };
type WaResult = { currency: string; total: number; volume: number; categories: WaCat[]; error?: string };
const waCache = new Map<string, { at: number; data: WaResult }>();

async function whatsappCost(accountId: string, r: Range): Promise<WaResult> {
  const key = `${accountId}:${r.from}:${r.to}`;
  const live = r.to >= todayBrt();
  const hit = waCache.get(key);
  if (hit && Date.now() - hit.at < (live ? 10 * 60_000 : 6 * 3600_000)) return hit.data;

  const empty: WaResult = { currency: 'USD', total: 0, volume: 0, categories: [] };
  const cfgs = await prisma.whatsAppConfig.findMany({ where: { accountId }, select: { wabaId: true, accessToken: true } });
  const wabas = new Map<string, string>();
  for (const c of cfgs) if (c.wabaId && c.accessToken && !wabas.has(c.wabaId)) wabas.set(c.wabaId, c.accessToken);
  if (!wabas.size) return { ...empty, error: 'API Oficial do WhatsApp não configurada (sem WABA).' };

  const start = Math.floor(Date.parse(`${r.from}T00:00:00-03:00`) / 1000);
  const next = Math.floor(Date.parse(`${addDays(r.to, 1)}T00:00:00-03:00`) / 1000);
  const end = Math.min(next, Math.floor(Date.now() / 1000));
  if (end <= start) { waCache.set(key, { at: Date.now(), data: empty }); return empty; }

  const agg = new Map<string, WaCat>();
  let currency = 'USD';
  let error: string | undefined;
  for (const [waba, token] of wabas) {
    try {
      const url = `https://graph.facebook.com/v20.0/${waba}?fields=currency,pricing_analytics.start(${start}).end(${end}).granularity(DAILY).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])`;
      const g = await graphGet(url, token);
      if (!g.ok) { error = g.j?.error?.error_user_msg || g.j?.error?.message || 'erro'; continue; }
      if (g.j.currency) currency = String(g.j.currency);
      for (const p of g.j.pricing_analytics?.data?.[0]?.data_points || []) {
        const k = `${p.pricing_category}|${p.pricing_type}`;
        const a = agg.get(k) || { category: String(p.pricing_category || ''), type: String(p.pricing_type || ''), volume: 0, cost: 0 };
        a.volume += Number(p.volume) || 0;
        a.cost += Number(p.cost) || 0;
        agg.set(k, a);
      }
    } catch (e: any) { error = String(e?.message || e).slice(0, 160); }
  }
  const categories = [...agg.values()].sort((a, b) => b.cost - a.cost);
  const data: WaResult = { currency, total: categories.reduce((s, c) => s + c.cost, 0), volume: categories.reduce((s, c) => s + c.volume, 0), categories, ...(error && !categories.length ? { error } : {}) };
  if (!data.error) waCache.set(key, { at: Date.now(), data }); // não guarda falha (tenta de novo na próxima abertura)
  return data;
}

// ── Railway: faturas (GraphQL público da Railway) ────────────────────────────
type RwInvoice = { periodStart: string; periodEnd: string; total: number; amountPaid: number; status: string };
type RwData = { invoices: RwInvoice[]; currentUsage: number; periodStart: string | null; periodEnd: string | null };
let rwCache: { at: number; data: RwData } | null = null;

async function railwayData(): Promise<RwData | { error: string }> {
  if (rwCache && Date.now() - rwCache.at < 30 * 60_000) return rwCache.data;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15_000);
    const r = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RAILWAY_TOKEN()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query($id:String!){ workspace(workspaceId:$id){ customer { currentUsage billingPeriod { start end } invoices { periodStart periodEnd total amountPaid status } } } }',
        variables: { id: RAILWAY_WORKSPACE() },
      }),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const j: any = await r.json().catch(() => ({}));
    const c = j?.data?.workspace?.customer;
    if (!r.ok || !c) return { error: j?.errors?.[0]?.message || `HTTP ${r.status}` };
    const data: RwData = { invoices: (c.invoices || []).filter((i: any) => i?.periodEnd), currentUsage: Number(c.currentUsage) || 0, periodStart: c.billingPeriod?.start || null, periodEnd: c.billingPeriod?.end || null };
    rwCache = { at: Date.now(), data };
    return data;
  } catch (e: any) { return { error: e?.name === 'AbortError' ? 'A Railway demorou demais pra responder.' : String(e?.message || e).slice(0, 160) }; }
}
const rwCents = (i: RwInvoice) => (i.status === 'paid' ? i.amountPaid : i.total);

// ── Anthropic: custo real (Admin API cost_report, valores em centavos de dólar) ─
const antCache = new Map<string, { at: number; usd: number }>();

async function anthropicRealCost(r: Range): Promise<{ usd: number } | { error: string } | null> {
  if (!ANTHROPIC_ADMIN_KEY()) return null;
  const key = `${r.from}:${r.to}`;
  const live = r.to >= todayBrt();
  const hit = antCache.get(key);
  if (hit && Date.now() - hit.at < (live ? 30 * 60_000 : 12 * 3600_000)) return { usd: hit.usd };
  const start = new Date(`${r.from}T00:00:00Z`);
  const end = new Date(Math.min(Date.parse(`${addDays(r.to, 1)}T00:00:00Z`), Date.now()));
  if (end <= start) return { usd: 0 };
  try {
    let cents = 0;
    let page: string | null = null;
    for (let i = 0; i < 5; i++) {
      const qs = new URLSearchParams({ starting_at: start.toISOString(), ending_at: end.toISOString(), bucket_width: '1d', limit: '31' });
      if (page) qs.set('page', page);
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15_000);
      const res = await fetch(`https://api.anthropic.com/v1/organizations/cost_report?${qs}`, {
        headers: { 'x-api-key': ANTHROPIC_ADMIN_KEY(), 'anthropic-version': '2023-06-01' },
        signal: ctl.signal,
      });
      clearTimeout(t);
      const j: any = await res.json().catch(() => ({}));
      if (!res.ok) return { error: j?.error?.message || `HTTP ${res.status}` };
      for (const b of j.data || []) for (const it of b.results || []) if (!it.currency || it.currency === 'USD') cents += Number(it.amount) || 0;
      if (!j.has_more || !j.next_page) break;
      page = j.next_page;
    }
    const usd = cents / 100;
    antCache.set(key, { at: Date.now(), usd });
    return { usd };
  } catch (e: any) { return { error: e?.name === 'AbortError' ? 'A Anthropic demorou demais pra responder.' : String(e?.message || e).slice(0, 160) }; }
}

// ── Meta Ads: acesso, gasto por campanha (insights) e cobranças no cartão ────
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

type AdsAccount = { id: string; name: string; currency: string };
type AdsAccess = { ok: true; token: string; source: 'META_ADS_TOKEN' | 'WHATSAPP'; accounts: AdsAccount[] } | { ok: false; reason: string };
const adsAccessCache = new Map<string, { at: number; p: Promise<AdsAccess> }>();

/** Token que enxerga a conta de anúncios: META_ADS_TOKEN ou, se tiver ads_read, o do WhatsApp. Cache de 1 h (inclusive do "sem acesso"). */
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
      const accounts: AdsAccount[] = [];
      for (const id of META_ADS_ACCOUNTS()) {
        const r = await graphGet(`https://graph.facebook.com/v20.0/act_${id}?fields=name,currency`, c.token);
        if (r.ok) accounts.push({ id, name: String(r.j.name || `act_${id}`), currency: String(r.j.currency || 'BRL') });
        else reasons.push(`${c.source === 'WHATSAPP' ? 'token do WhatsApp' : 'META_ADS_TOKEN'}: ${r.j?.error?.message || 'sem acesso'}`);
      }
      if (accounts.length) return { ok: true, token: c.token, source: c.source, accounts };
    }
    return { ok: false, reason: [...new Set(reasons)].join(' · ').slice(0, 400) };
  })().catch((e: any) => ({ ok: false as const, reason: String(e?.message || e).slice(0, 200) }));
  adsAccessCache.set(accountId, { at: Date.now(), p });
  return p;
}

type AdsCampaign = { id: string; name: string; account: string; currency: string; spend: number };
const adsSpendCache = new Map<string, { at: number; data: { campaigns: AdsCampaign[]; error?: string } }>();

async function metaAdsSpend(acc: Extract<AdsAccess, { ok: true }>, accountId: string, r: Range): Promise<{ campaigns: AdsCampaign[]; error?: string }> {
  const key = `${accountId}:${r.from}:${r.to}`;
  const live = r.to >= todayBrt();
  const hit = adsSpendCache.get(key);
  if (hit && Date.now() - hit.at < (live ? 30 * 60_000 : 6 * 3600_000)) return hit.data;
  const campaigns: AdsCampaign[] = [];
  const errors: string[] = [];
  for (const a of acc.accounts) {
    const qs = new URLSearchParams({ fields: 'campaign_id,campaign_name,spend', level: 'campaign', time_range: JSON.stringify({ since: r.from, until: r.to }), limit: '200' });
    let url: string | null = `https://graph.facebook.com/v20.0/act_${a.id}/insights?${qs}`;
    for (let i = 0; url && i < 5; i++) {
      const g = await graphGet(url, acc.token);
      if (!g.ok) { errors.push(`${a.name}: ${g.j?.error?.error_user_msg || g.j?.error?.message || 'erro'}`); break; }
      for (const row of g.j.data || []) {
        const spend = Number(row.spend) || 0;
        if (spend > 0) campaigns.push({ id: String(row.campaign_id || ''), name: String(row.campaign_name || 'Campanha'), account: a.name, currency: a.currency, spend });
      }
      url = g.j.paging?.next || null;
    }
  }
  campaigns.sort((x, y) => y.spend - x.spend);
  const data = { campaigns, ...(errors.length ? { error: errors.join(' · ').slice(0, 300) } : {}) };
  if (!errors.length) adsSpendCache.set(key, { at: Date.now(), data });
  return data;
}

type AdsCharge = { id: string; date: string; amount: number; currency: string; status: string; account: string };
const adsChargesCache = new Map<string, { at: number; data: { charges: AdsCharge[]; error?: string } }>();
const parseMoney = (v: any): number => {
  if (v == null) return 0;
  if (typeof v === 'object') return v.amount_in_hundredths != null ? Number(v.amount_in_hundredths) / 100 : Number(v.amount ?? v.total_amount ?? 0) || 0;
  return Number(v) || 0;
};
const toMs = (t: any) => (typeof t === 'number' || /^\d+$/.test(String(t)) ? Number(t) * 1000 : Date.parse(String(t)));

/** Cobranças da conta de anúncios no cartão (data + valor), dos últimos ~13 meses. Lê /transactions; se a Meta recusar, o histórico de atividades (ad_account_billing_charge). */
const adsChargesInflight = new Map<string, Promise<{ charges: AdsCharge[]; error?: string }>>();
function metaAdsCharges(acc: Extract<AdsAccess, { ok: true }>, accountId: string): Promise<{ charges: AdsCharge[]; error?: string }> {
  const hit = adsChargesCache.get(accountId);
  if (hit && Date.now() - hit.at < 30 * 60_000) return Promise.resolve(hit.data);
  let p = adsChargesInflight.get(accountId);
  if (!p) { p = fetchMetaAdsCharges(acc, accountId).finally(() => adsChargesInflight.delete(accountId)); adsChargesInflight.set(accountId, p); }
  return p;
}
async function fetchMetaAdsCharges(acc: Extract<AdsAccess, { ok: true }>, accountId: string): Promise<{ charges: AdsCharge[]; error?: string }> {
  const charges: AdsCharge[] = [];
  const errors: string[] = [];
  const since = Math.floor((Date.now() - 400 * 86400_000) / 1000);
  for (const a of acc.accounts) {
    let ok = false;
    let url: string | null = `https://graph.facebook.com/v20.0/act_${a.id}/transactions?${new URLSearchParams({ fields: 'id,time,amount,status,charge_type,billing_start_time,billing_end_time', time_start: String(since), limit: '100' })}`;
    for (let i = 0; url && i < 10; i++) {
      const g = await graphGet(url, acc.token);
      if (!g.ok) { if (i === 0) errors.push(`${a.name} (cobranças): ${g.j?.error?.message || 'erro'}`); break; }
      ok = true;
      for (const t of g.j.data || []) {
        const ms = toMs(t.time);
        if (!ms || /fail|declin|cancel|void/i.test(String(t.status || ''))) continue;
        const amount = parseMoney(t.amount);
        if (amount > 0) charges.push({ id: String(t.id || `${a.id}-${ms}`), date: brtDate(ms), amount, currency: String(t.amount?.currency || a.currency), status: String(t.status || ''), account: a.name });
      }
      url = g.j.paging?.next || null;
    }
    if (ok) continue;
    // plano B: histórico de atividades da conta
    url = `https://graph.facebook.com/v20.0/act_${a.id}/activities?${new URLSearchParams({ fields: 'event_type,event_time,extra_data', since: String(since), limit: '200' })}`;
    for (let i = 0; url && i < 10; i++) {
      const g = await graphGet(url, acc.token);
      if (!g.ok) { errors.push(`${a.name} (atividades): ${g.j?.error?.message || 'erro'}`); break; }
      if (i === 0) { const k = errors.findIndex((e) => e.startsWith(`${a.name} (cobranças)`)); if (k >= 0) errors.splice(k, 1); }
      for (const ev of g.j.data || []) {
        if (ev.event_type !== 'ad_account_billing_charge') continue;
        let x: any = {};
        try { x = typeof ev.extra_data === 'string' ? JSON.parse(ev.extra_data) : ev.extra_data || {}; } catch { /* sem detalhe */ }
        const raw = Number(x.new_value ?? x.amount ?? 0);
        const amount = Number.isInteger(raw) ? raw / 100 : raw; // a Meta manda em centavos
        const ms = toMs(ev.event_time);
        if (amount > 0 && ms) charges.push({ id: String(x.transaction_id || `${a.id}-${ms}`), date: brtDate(ms), amount, currency: String(x.currency || a.currency), status: 'charged', account: a.name });
      }
      url = g.j.paging?.next || null;
    }
  }
  charges.sort((x, y) => (x.date < y.date ? -1 : 1));
  const data = { charges, ...(errors.length ? { error: errors.join(' · ').slice(0, 300) } : {}) };
  if (!errors.length) adsChargesCache.set(accountId, { at: Date.now(), data });
  return data;
}

// ── lançamentos (pagamentos no cartão) ───────────────────────────────────────
export type EntryDTO = {
  id: string; provider: string; label: string; amount: number; currency: string; month: string; recurring: boolean; endMonth: string | null;
  kind: string; campaign: string | null; note: string | null; paidAt: string | null; chargeDay: number | null;
};
const toDto = (e: any): EntryDTO => ({
  id: e.id, provider: e.provider, label: e.label, amount: e.amountCents / 100, currency: e.currency, month: e.month, recurring: !!e.recurring, endMonth: e.endMonth || null,
  kind: e.kind, campaign: e.campaign || null, note: e.note || null, paidAt: e.paidAt || null, chargeDay: e.chargeDay ?? null,
});
const appliesTo = (e: { month: string; recurring: boolean; endMonth: string | null }, month: string) =>
  e.recurring ? e.month <= month && (!e.endMonth || e.endMonth >= month) : e.month === month;

/** Datas de cobrança do lançamento dentro do período. Sem o dia informado (lançamentos antigos), usa o dia 1º e marca como aproximado. */
function entryDates(e: EntryDTO, r: Range): { date: string; approx: boolean }[] {
  if (!e.recurring) {
    const date = e.paidAt || `${e.month}-01`;
    return date >= r.from && date <= r.to ? [{ date, approx: !e.paidAt }] : [];
  }
  const day = e.chargeDay || (e.paidAt ? Number(e.paidAt.slice(8, 10)) : 0);
  const out: { date: string; approx: boolean }[] = [];
  for (let m = r.from.slice(0, 7); m <= r.to.slice(0, 7); m = addMonths(m, 1)) {
    if (m < e.month || (e.endMonth && m > e.endMonth)) continue;
    const date = day ? dayOf(m, day) : `${m}-01`;
    if (date >= r.from && date <= r.to) out.push({ date, approx: !day });
  }
  return out;
}

export type EntryInput = {
  provider: string; label: string; amount: number; currency?: string; month?: string; paidAt?: string | null;
  recurring?: boolean; endMonth?: string | null; kind?: string; campaign?: string | null; note?: string | null;
};
function cleanEntry(b: Partial<EntryInput>) {
  const provider = String(b.provider || '').toUpperCase();
  if (!PROVIDERS[provider]) throw new Error('Fornecedor inválido.');
  const amount = Number(b.amount);
  if (!(amount > 0) || amount > 10_000_000) throw new Error('Informe um valor maior que zero.');
  const currency = String(b.currency || 'BRL').toUpperCase();
  if (currency !== 'BRL' && currency !== 'USD') throw new Error('Moeda inválida (BRL ou USD).');
  const paidAt = b.paidAt ? String(b.paidAt).slice(0, 10) : null;
  if (paidAt && !DATE_RX.test(paidAt)) throw new Error('Data do pagamento inválida.');
  const month = paidAt ? paidAt.slice(0, 7) : b.month;
  if (!validMonth(month)) throw new Error('Informe a data do pagamento.');
  const recurring = !!b.recurring;
  const endMonth = recurring && b.endMonth ? String(b.endMonth) : null;
  if (endMonth && (!validMonth(endMonth) || endMonth < month)) throw new Error('O mês final precisa ser igual ou depois do mês inicial.');
  const kind = String(b.kind || 'EXTRA').toUpperCase() === 'ACTUAL' ? 'ACTUAL' : 'EXTRA';
  const campaign = provider === 'META_ADS' && b.campaign ? String(b.campaign).trim().slice(0, 120) || null : null;
  const label = String(b.label || '').trim().slice(0, 120) || campaign || PROVIDERS[provider];
  return {
    provider, label, amountCents: Math.round(amount * 100), currency, month, recurring, endMonth, kind, campaign,
    paidAt, chargeDay: recurring && paidAt ? Number(paidAt.slice(8, 10)) : null,
    note: b.note ? String(b.note).trim().slice(0, 300) || null : null,
  };
}

export async function createEntry(accountId: string, userId: string, body: Partial<EntryInput>): Promise<EntryDTO> {
  if (!body.paidAt) throw new Error('Informe a data do pagamento.');
  return toDto(await prisma.costEntry.create({ data: { accountId, createdById: userId, ...cleanEntry(body) } }));
}
export async function updateEntry(accountId: string, id: string, body: Partial<EntryInput>): Promise<EntryDTO> {
  const cur = await prisma.costEntry.findFirst({ where: { id, accountId } });
  if (!cur) throw new Error('Lançamento não encontrado.');
  const merged: Partial<EntryInput> = {
    provider: cur.provider, label: cur.label, amount: cur.amountCents / 100, currency: cur.currency, month: cur.month, paidAt: cur.paidAt,
    recurring: cur.recurring, endMonth: cur.endMonth, kind: cur.kind, campaign: cur.campaign, note: cur.note, ...body,
  };
  return toDto(await prisma.costEntry.update({ where: { id }, data: cleanEntry(merged) }));
}
export async function deleteEntry(accountId: string, id: string): Promise<void> {
  const r = await prisma.costEntry.deleteMany({ where: { id, accountId } });
  if (!r.count) throw new Error('Lançamento não encontrado.');
}

// ── o período (mês ou ciclo da fatura) ──────────────────────────────────────
export type Payment = {
  key: string; date: string; approx: boolean; provider: string; label: string; amount: number; currency: string; brl: number;
  status: 'PAGO' | 'PREVISTO'; source: 'LANCADO' | 'RAILWAY' | 'META'; entryId?: string; campaign?: string | null; note?: string | null;
};
export type Consumption = { kind: 'REAL' | 'ESTIMATIVA'; usedBrl: number; projectedBrl: number; noData?: boolean; error?: string; detail: Record<string, unknown> };
export type ProviderRow = {
  provider: string; label: string;
  paid: number; scheduled: number; used: number | null; projected: number | null; estimated: number; cost: number;
  consumption: Consumption | null; payments: Payment[];
  /** a cobrança automática respondeu e os lançamentos manuais desse fornecedor saíram da conta */
  manualReplaced: boolean; paymentsError?: string;
};
export type PeriodCosts = {
  from: string; to: string; elapsedDays: number; totalDays: number;
  totals: { paid: number; scheduled: number; estimated: number; cost: number };
  providers: ProviderRow[];
};
type Ctx = { rate: number; entries: EntryDTO[]; withDetail: boolean; ads: AdsAccess; rw: RwData | { error: string } | null };

async function periodCosts(accountId: string, r: Range, ctx: Ctx): Promise<PeriodCosts> {
  const today = todayBrt();
  const totalDays = daysFrom(r.from, r.to) + 1;
  const elapsedDays = today < r.from ? 0 : Math.min(totalDays, daysFrom(r.from, today) + 1);
  const factor = elapsedDays > 0 ? totalDays / elapsedDays : 0;
  const upTo = r.to < today ? r.to : today; // consumo medido só até hoje
  const used: Range = { from: r.from, to: upTo };
  const toBrl = (amount: number, currency: string) => (currency === 'USD' ? amount * ctx.rate : amount);
  const cons = new Map<string, Consumption>();
  const setCons = (p: string, kind: Consumption['kind'], usedBrl: number, detail: Record<string, unknown>, extra: { noData?: boolean; error?: string; projectedBrl?: number } = {}) =>
    cons.set(p, { kind, usedBrl: round2(usedBrl), projectedBrl: round2(extra.projectedBrl ?? usedBrl * factor), noData: extra.noData, error: extra.error, detail });

  if (elapsedDays > 0) {
    // Anthropic — real (cost_report) ou estimado pelo uso gravado
    const ai = await prisma.aiUsage.findMany({ where: { day: { gte: used.from, lte: used.to } } });
    const byFeature = new Map<string, { usd: number; calls: number }>();
    let estUsd = 0, calls = 0, errors = 0, tokensIn = 0, tokensOut = 0;
    for (const row of ai) {
      const u = estimarUsd(row.model, row);
      estUsd += u; calls += row.calls; errors += row.errors; tokensIn += row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens; tokensOut += row.outputTokens;
      const f = byFeature.get(row.feature) || { usd: 0, calls: 0 }; f.usd += u; f.calls += row.calls; byFeature.set(row.feature, f);
    }
    const detail: Record<string, unknown> = { calls, errors, tokensIn, tokensOut, firstDay: ai.length ? ai.reduce((m, x) => (x.day < m ? x.day : m), ai[0].day) : null };
    if (ctx.withDetail) detail.topFeatures = [...byFeature].sort((a, b) => b[1].usd - a[1].usd).slice(0, 10).map(([feature, v]) => ({ feature, usd: round2(v.usd), calls: v.calls }));
    const real = await anthropicRealCost(used);
    if (real && 'usd' in real) { detail.usd = round2(real.usd); detail.estimativaUsd = round2(estUsd); setCons('ANTHROPIC', 'REAL', real.usd * ctx.rate, detail, { noData: real.usd === 0 && !ai.length }); }
    else { if (real?.error) detail.realError = real.error; detail.usd = round2(estUsd); setCons('ANTHROPIC', 'ESTIMATIVA', estUsd * ctx.rate, detail, { noData: !ai.length }); }

    // Voyage — tokens × preço de tabela
    const vr = await prisma.providerUsage.findMany({ where: { provider: 'VOYAGE', day: { gte: used.from, lte: used.to } } });
    const tokens = vr.reduce((s, x) => s + x.units, 0);
    const vUsd = (tokens / 1_000_000) * VOYAGE_USD_POR_MILHAO;
    setCons('VOYAGE', 'ESTIMATIVA', vUsd * ctx.rate, { usd: round2(vUsd), tokens, calls: vr.reduce((s, x) => s + x.calls, 0), usdPorMilhao: VOYAGE_USD_POR_MILHAO }, { noData: !vr.length });

    // WhatsApp — custo real da Meta
    const wa = await whatsappCost(accountId, used);
    setCons('WHATSAPP', 'REAL', toBrl(wa.total, wa.currency), {
      currency: wa.currency, total: round2(wa.total), volume: wa.volume,
      categories: wa.categories.map((c) => ({ ...c, cost: Math.round(c.cost * 10000) / 10000, costBrl: round2(toBrl(c.cost, wa.currency)) })),
    }, { noData: !wa.categories.length && !wa.error, error: wa.error });

    // Campanhas — gasto por campanha (insights)
    if (ctx.ads.ok) {
      const sp = await metaAdsSpend(ctx.ads, accountId, used);
      const brl = sp.campaigns.reduce((s, c) => s + toBrl(c.spend, c.currency), 0);
      setCons('META_ADS', 'REAL', brl, {
        accounts: ctx.ads.accounts.map((a) => ({ id: `act_${a.id}`, name: a.name, currency: a.currency })),
        campaigns: sp.campaigns.map((c) => ({ ...c, spend: round2(c.spend), brl: round2(toBrl(c.spend, c.currency)) })),
      }, { noData: !sp.campaigns.length && !sp.error, error: sp.error && !sp.campaigns.length ? sp.error : undefined });
    }
  }

  // Railway — faturas do período + uso do ciclo atual (vira fatura no fim do ciclo)
  const rwOk = ctx.rw && !('error' in ctx.rw) ? ctx.rw : null;
  if (ctx.rw && 'error' in ctx.rw) cons.set('RAILWAY', { kind: 'REAL', usedBrl: 0, projectedBrl: 0, error: ctx.rw.error, detail: {} });
  else if (rwOk) {
    const inR = rwOk.invoices.filter((i) => { const d = brtDate(Date.parse(i.periodEnd)); return d >= r.from && d <= r.to; });
    const usdInvoices = inR.reduce((s, i) => s + rwCents(i), 0) / 100;
    const detail: Record<string, unknown> = { faturas: inR.map((i) => ({ de: i.periodStart.slice(0, 10), ate: i.periodEnd.slice(0, 10), usd: round2(rwCents(i) / 100), status: i.status })) };
    let projUsd = usdInvoices;
    if (rwOk.periodEnd) {
      const endD = brtDate(Date.parse(rwOk.periodEnd));
      if (endD >= r.from && endD <= r.to && endD >= today && !inR.some((i) => brtDate(Date.parse(i.periodEnd)) === endD)) {
        const len = rwOk.periodStart ? Math.max(1, daysFrom(brtDate(Date.parse(rwOk.periodStart)), endD)) : 30;
        const gone = rwOk.periodStart ? Math.max(1, daysFrom(brtDate(Date.parse(rwOk.periodStart)), today) + 1) : len;
        const proj = rwOk.currentUsage * Math.max(1, len / gone);
        projUsd += proj;
        detail.cicloAtualUsd = round2(rwOk.currentUsage); detail.cicloProjecaoUsd = round2(proj); detail.cicloAte = endD;
      }
    }
    cons.set('RAILWAY', { kind: 'REAL', usedBrl: round2(usdInvoices * ctx.rate), projectedBrl: round2(projUsd * ctx.rate), noData: !inR.length && !detail.cicloAtualUsd, detail });
  }

  // pagamentos com data
  const payments: Payment[] = [];
  const apiPayments = new Set<string>();
  const paymentsError: Record<string, string> = {};
  if (rwOk) {
    apiPayments.add('RAILWAY');
    for (const i of rwOk.invoices) {
      const date = brtDate(Date.parse(i.periodEnd));
      if (date < r.from || date > r.to) continue;
      const usd = rwCents(i) / 100;
      if (usd <= 0) continue;
      payments.push({ key: `rw-${i.periodEnd}`, date, approx: false, provider: 'RAILWAY', label: `Fatura Railway ${i.periodStart.slice(8, 10)}/${i.periodStart.slice(5, 7)} a ${i.periodEnd.slice(8, 10)}/${i.periodEnd.slice(5, 7)}`, amount: round2(usd), currency: 'USD', brl: round2(usd * ctx.rate), status: i.status === 'paid' ? 'PAGO' : 'PREVISTO', source: 'RAILWAY' });
    }
  }
  if (ctx.ads.ok) {
    const ch = await metaAdsCharges(ctx.ads, accountId);
    if (ch.error && !ch.charges.length) paymentsError.META_ADS = ch.error;
    else {
      apiPayments.add('META_ADS');
      for (const c of ch.charges) {
        if (c.date < r.from || c.date > r.to) continue;
        payments.push({ key: `meta-${c.id}`, date: c.date, approx: false, provider: 'META_ADS', label: `Cobrança Meta Ads${ctx.ads.accounts.length > 1 ? ` · ${c.account}` : ''}`, amount: round2(c.amount), currency: c.currency, brl: round2(toBrl(c.amount, c.currency)), status: 'PAGO', source: 'META' });
      }
    }
  }
  const replaced = new Set<string>();
  for (const e of ctx.entries) {
    for (const d of entryDates(e, r)) {
      if (apiPayments.has(e.provider)) { replaced.add(e.provider); continue; }
      payments.push({
        key: `e-${e.id}-${d.date}`, date: d.date, approx: d.approx, provider: e.provider, label: e.label, amount: e.amount, currency: e.currency,
        brl: round2(toBrl(e.amount, e.currency)), status: d.date <= today ? 'PAGO' : 'PREVISTO', source: 'LANCADO', entryId: e.id, campaign: e.campaign, note: e.note,
      });
    }
  }
  payments.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const keys = new Set<string>(['ANTHROPIC', 'WHATSAPP', 'META_ADS', ...cons.keys(), ...payments.map((p) => p.provider)]);
  const providers: ProviderRow[] = [...keys].map((p) => {
    const c = cons.get(p) || null;
    const pays = payments.filter((x) => x.provider === p);
    const paid = round2(pays.filter((x) => x.status === 'PAGO').reduce((s, x) => s + x.brl, 0));
    const scheduled = round2(pays.filter((x) => x.status === 'PREVISTO').reduce((s, x) => s + x.brl, 0));
    const usedBrl = c && !c.error ? c.usedBrl : null;
    const projected = c && !c.error ? c.projectedBrl : null;
    return {
      provider: p, label: PROVIDERS[p] || p, paid, scheduled, used: usedBrl, projected,
      estimated: round2(Math.max(paid + scheduled, projected ?? 0)), cost: round2(Math.max(paid, usedBrl ?? 0)),
      consumption: c, payments: pays, manualReplaced: replaced.has(p), ...(paymentsError[p] ? { paymentsError: paymentsError[p] } : {}),
    };
  }).filter((b) => b.estimated > 0 || b.paid > 0 || b.payments.length || (b.consumption && !b.consumption.noData) || b.consumption?.error || ['ANTHROPIC', 'WHATSAPP', 'META_ADS'].includes(b.provider));
  providers.sort((a, b) => b.estimated - a.estimated);
  const sum = (k: 'paid' | 'scheduled' | 'estimated' | 'cost') => round2(providers.reduce((s, b) => s + b[k], 0));
  return { from: r.from, to: r.to, elapsedDays, totalDays, totals: { paid: sum('paid'), scheduled: sum('scheduled'), estimated: sum('estimated'), cost: sum('cost') }, providers };
}

export async function costsOverview(accountId: string, month: string, months = 6) {
  await Promise.all([flushAnthropicUsage().catch(() => {}), flushProviderUsage().catch(() => {})]);
  const settings = await getSettings(accountId);
  const all = await prisma.costEntry.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } });
  const entries = all.map(toDto);
  const [ads, rw] = await Promise.all([adsAccess(accountId), RAILWAY_TOKEN() ? railwayData() : Promise.resolve(null)]);
  const base = { rate: settings.cardRate, entries, ads, rw };
  const n = Math.max(1, Math.min(months, 12));
  const monthsList = Array.from({ length: n }, (_, i) => addMonths(month, -(n - 1 - i)));
  // fatura do cartão: no mês atual, a que está aberta (depois do fechamento já é a do mês que vem); nos outros, a que fechou naquele mês
  const stmtMonth = month === currentMonth() ? openStatementMonth(settings.closingDay) : month;
  const cr = cycleRange(stmtMonth, settings.closingDay);
  const [results, stmt] = await Promise.all([
    Promise.all(monthsList.map((m) => periodCosts(accountId, monthRange(m), { ...base, withDetail: m === month }))),
    periodCosts(accountId, cr, { ...base, withDetail: false }),
  ]);
  const selected = results[results.length - 1];
  const due = settings.dueDay > settings.closingDay ? dayOf(stmtMonth, settings.dueDay) : dayOf(addMonths(stmtMonth, 1), settings.dueDay);
  return {
    month,
    rate: { usdBrl: settings.usdBrl, source: settings.source, manual: settings.manual, iof: settings.iof, cardRate: settings.cardRate },
    card: { closingDay: settings.closingDay, dueDay: settings.dueDay },
    selected,
    statement: { month: stmtMonth, closing: cr.to, due, open: todayBrt() <= cr.to, ...stmt },
    trend: results.map((x, i) => ({
      month: monthsList[i], paid: x.totals.paid, estimated: x.totals.estimated, cost: x.totals.cost,
      byProvider: Object.fromEntries(x.providers.filter((p) => p.estimated > 0).map((p) => [p.provider, p.estimated])),
    })),
    entries: entries.filter((e) => appliesTo(e, month)),
    providerOptions: Object.entries(PROVIDERS).map(([key, label]) => ({ key, label, auto: (key === 'RAILWAY' && !!RAILWAY_TOKEN()) || (key === 'META_ADS' && ads.ok) })),
    sources: {
      railway: !!RAILWAY_TOKEN(),
      anthropicReal: !!ANTHROPIC_ADMIN_KEY(),
      metaAds: ads.ok ? { ok: true as const, source: ads.source, accounts: ads.accounts.map((a) => `${a.name} (act_${a.id})`) } : { ok: false as const, reason: ads.reason, account: `act_${META_ADS_ACCOUNTS()[0]}` },
    },
  };
}

// ── WhatsApp: envios por template no mês (Fabio 20/11, "tem como reduzir mais, alterando só templates e colocando utilidades?") ──
/** Quantos envios cada template teve no mês (mensagens do CRM com templateName) + a categoria dele na Meta (MARKETING custa ~10× a UTILITY). */
export async function whatsappTemplateSends(accountId: string, month: string): Promise<{ name: string; category: string | null; sent: number; failed: number }[]> {
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1, 3));
  const to = new Date(Date.UTC(y, m, 1, 3));
  const rows = await prisma.$queryRaw<{ name: string; sent: bigint; failed: bigint }[]>`
    SELECT m."templateName" AS name, count(*) AS sent, count(*) FILTER (WHERE m.status = 'FAILED') AS failed
    FROM "Message" m JOIN "Lead" l ON l.id = m."leadId"
    WHERE l."accountId" = ${accountId} AND m.direction = 'OUTBOUND' AND m."templateName" IS NOT NULL AND m."createdAt" >= ${from} AND m."createdAt" < ${to}
    GROUP BY 1 ORDER BY 2 DESC`;
  const cats = new Map<string, string>();
  try {
    const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
    for (const t of await listMetaTemplates(accountId)) cats.set(String(t.name), String(t.category || ''));
  } catch { /* sem a Meta: categoria fica vazia */ }
  return rows.map((r) => ({ name: r.name, category: cats.get(r.name) || null, sent: Number(r.sent), failed: Number(r.failed) }));
}
