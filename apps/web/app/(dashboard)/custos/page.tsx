'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, CreditCard, Pencil, Plus, Trash2 } from 'lucide-react';
import { Topbar } from '@/components/ui/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/* Painel de custos (Fabio 22/10): tudo que é pago por causa do CRM, em reais. Só administrador.
 * 14/11: PAGO (cobranças no cartão, com data) × ESTIMADO (consumo projetado), e a fatura do cartão (fecha dia 22, vence dia 27).
 * Dados: GET /api/costs?month=AAAA-MM (costs.service.ts) + GET /api/reports/monthly (leads, aprovados e contratações do mês, pra custo por resultado). */

interface Entry { id: string; provider: string; label: string; amount: number; currency: string; month: string; recurring: boolean; endMonth: string | null; kind: string; campaign: string | null; note: string | null; paidAt: string | null; chargeDay: number | null }
interface Payment { key: string; date: string; approx: boolean; provider: string; label: string; amount: number; currency: string; brl: number; status: 'PAGO' | 'PREVISTO'; source: 'LANCADO' | 'RAILWAY' | 'META'; entryId?: string; campaign?: string | null; note?: string | null }
interface Consumption { kind: 'REAL' | 'ESTIMATIVA'; usedBrl: number; projectedBrl: number; noData?: boolean; error?: string; detail: any }
interface Row { provider: string; label: string; paid: number; scheduled: number; used: number | null; projected: number | null; estimated: number; cost: number; consumption: Consumption | null; payments: Payment[]; manualReplaced: boolean; paymentsError?: string }
interface Period { from: string; to: string; elapsedDays: number; totalDays: number; totals: { paid: number; scheduled: number; estimated: number; cost: number }; providers: Row[] }
interface Overview {
  month: string;
  rate: { usdBrl: number; source: 'MANUAL' | 'AUTO' | 'ESTIMADA'; manual: number | null; iof: number; cardRate: number };
  card: { closingDay: number; dueDay: number };
  selected: Period;
  statement: Period & { month: string; closing: string; due: string; open: boolean };
  trend: { month: string; paid: number; estimated: number; cost: number; byProvider: Record<string, number> }[];
  entries: Entry[];
  providerOptions: { key: string; label: string; auto: boolean }[];
  sources: { railway: boolean; anthropicReal: boolean; metaAds: { ok: true; source: string; accounts: string[] } | { ok: false; reason: string; account: string } };
}
interface MonthRow { month: string; entered: number; approved: number; docsSent: number; contracted: number }

const COLORS: Record<string, string> = {
  WHATSAPP: '#16a34a', ANTHROPIC: '#7c3aed', ANTHROPIC_PLANO: '#a78bfa', RAILWAY: '#0ea5e9', META_ADS: '#2563eb', VOYAGE: '#f59e0b',
  ELEVENLABS: '#ec4899', GOOGLE: '#ef4444', EMAIL: '#14b8a6', DOMINIO: '#64748b', OUTRO: '#94a3b8',
};
const WA_CAT: Record<string, string> = { MARKETING: 'Marketing', UTILITY: 'Utilidade', SERVICE: 'Atendimento', AUTHENTICATION: 'Autenticação', MARKETING_LITE: 'Marketing lite' };

const brl = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const usd = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'USD' });
const money = (v: number, cur: string) => (cur === 'USD' ? usd(v) : brl(v));
const n0 = (v: number) => v.toLocaleString('pt-BR');
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const monthLabel = (m: string, short = false) => {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1, 1);
  return d.toLocaleDateString('pt-BR', short ? { month: 'short' } : { month: 'long', year: 'numeric' }).replace('.', '');
};
const shiftMonth = (m: string, delta: number) => {
  const [y, mm] = m.split('-').map(Number);
  const idx = y * 12 + (mm - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
};
const nowDate = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const nowMonth = () => nowDate().slice(0, 7);
const daysUntil = (d: string) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${nowDate()}T00:00:00Z`)) / 86400_000);

function Kpi({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="bg-white rounded-xl border border-af-border p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={cn('text-2xl font-bold mt-1', cls || 'text-slate-800')}>{value}</p>
      {hint && <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{hint}</p>}
    </div>
  );
}

function Card({ title, sub, children, right }: { title: React.ReactNode; sub?: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-af-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          {sub && <p className="text-[11px] text-slate-400 mb-2">{sub}</p>}
        </div>
        {right}
      </div>
      <div className={sub ? '' : 'mt-2'}>{children}</div>
    </section>
  );
}

const EMPTY_FORM = { id: '', provider: 'ANTHROPIC', label: '', amount: '', currency: 'BRL', paidAt: '', recurring: false, endMonth: '', campaign: '', note: '' };

export default function CustosPage() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(nowMonth());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<typeof EMPTY_FORM | null>(null);
  const [saving, setSaving] = useState(false);
  const [rateInput, setRateInput] = useState('');
  const [editRate, setEditRate] = useState(false);
  const [cardEdit, setCardEdit] = useState<{ closing: string; due: string } | null>(null);
  const [showCharges, setShowCharges] = useState(true);

  const { data, isLoading, error } = useQuery<Overview>({
    queryKey: ['costs', month],
    queryFn: async () => (await api.get('/api/costs', { params: { month, months: 6 } })).data,
    refetchInterval: 120_000,
  });
  const { data: report } = useQuery<{ rows: MonthRow[] }>({
    queryKey: ['costs-report'],
    queryFn: async () => (await api.get('/api/reports/monthly', { params: { months: 12, mode: 'event' } })).data,
    staleTime: 120_000,
  });
  const forbidden = (error as any)?.response?.status === 403;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['costs'] });

  const row = report?.rows.find((r) => r.month === month);
  const sel = data?.selected;
  const cost = sel?.totals.cost ?? 0;
  const per = (count: number | undefined) => (count && count > 0 && cost > 0 ? brl(cost / count) : '—');
  const ads = sel?.providers.find((p) => p.provider === 'META_ADS');
  const isCurrent = month === nowMonth();

  const defaultDate = () => (isCurrent ? nowDate() : `${month}-01`);
  const newPayment = (provider = 'ANTHROPIC') => setForm({ ...EMPTY_FORM, provider, paidAt: defaultDate() });

  async function saveEntry() {
    if (!form) return;
    if (!form.paidAt) { toast(form.recurring ? 'Informe a data da cobrança (o dia se repete todo mês)' : 'Informe a data do pagamento', 'error'); return; }
    setSaving(true);
    const body = {
      provider: form.provider, label: form.label, amount: Number(String(form.amount).replace(/\./g, '').replace(',', '.')), currency: form.currency,
      paidAt: form.paidAt, recurring: form.recurring, endMonth: form.recurring && form.endMonth ? form.endMonth : null, campaign: form.campaign || null, note: form.note || null,
    };
    try {
      if (form.id) await api.put(`/api/costs/entries/${form.id}`, body); else await api.post('/api/costs/entries', body);
      toast('Pagamento salvo', 'success');
      setForm(null);
      refresh();
    } catch (e: any) { toast(e?.response?.data?.error || 'Não consegui salvar', 'error'); }
    finally { setSaving(false); }
  }
  async function removeEntry(e: Entry) {
    if (!window.confirm(`Apagar o lançamento "${e.label}"?${e.recurring ? '\n\nEle é recorrente: some de todos os meses.' : ''}`)) return;
    try { await api.delete(`/api/costs/entries/${e.id}`); toast('Lançamento apagado', 'success'); refresh(); }
    catch (err: any) { toast(err?.response?.data?.error || 'Não consegui apagar', 'error'); }
  }
  function editEntry(e: Entry) {
    setForm({ id: e.id, provider: e.provider, label: e.label, amount: String(e.amount).replace('.', ','), currency: e.currency, paidAt: e.paidAt || '', recurring: e.recurring, endMonth: e.endMonth || '', campaign: e.campaign || '', note: e.note || '' });
  }
  const editById = (id?: string) => { const e = data?.entries.find((x) => x.id === id); if (e) editEntry(e); else toast('Abra o mês desse lançamento para editar', 'warning'); };
  async function saveSettings(body: Record<string, unknown>, ok: string) {
    try { await api.put('/api/costs/settings', body); toast(ok, 'success'); setEditRate(false); setCardEdit(null); refresh(); }
    catch (e: any) { toast(e?.response?.data?.error || 'Valor inválido', 'error'); }
  }

  const maxTrend = Math.max(1, ...(data?.trend.map((t) => Math.max(t.estimated, t.paid)) || [1]));
  const providerKeys = Array.from(new Set((data?.trend || []).flatMap((t) => Object.keys(t.byProvider))));
  const st = data?.statement;
  const stLeft = st ? daysUntil(st.closing) : 0;
  const srcs = data?.sources;
  const stCharges = st ? st.providers.flatMap((p) => p.payments).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) : [];

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Custos do CRM" subtitle="O que já foi cobrado no cartão e o que ainda vai entrar — IA, WhatsApp, hospedagem, campanhas e o resto" />
      <div className="flex-1 overflow-auto px-4 md:px-6 py-4 space-y-4 scrollbar-thin">
        <div className="flex flex-wrap items-center gap-2 bg-white rounded-xl border border-af-border shadow-sm px-3 py-2">
          <button onClick={() => setMonth(shiftMonth(month, -1))} className="p-1.5 rounded-lg border border-af-border text-slate-700 hover:bg-af-light" title="Mês anterior"><ChevronLeft size={16} /></button>
          <span className="text-sm font-semibold text-slate-800 min-w-[150px] text-center">{monthLabel(month).replace(/^./, (c) => c.toUpperCase())}</span>
          <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= nowMonth()} className="p-1.5 rounded-lg border border-af-border text-slate-700 hover:bg-af-light disabled:opacity-30" title="Próximo mês"><ChevronRight size={16} /></button>
          {!isCurrent && <button onClick={() => setMonth(nowMonth())} className="text-xs text-af-mid underline">Mês atual</button>}
          {data && (
            <div className="ml-auto text-[11px] text-slate-500 flex flex-wrap items-center gap-2">
              {editRate ? (
                <>
                  <span>US$ 1 =</span>
                  <input value={rateInput} onChange={(e) => setRateInput(e.target.value)} placeholder="5,40" className="w-16 border border-af-border rounded px-1.5 py-0.5 text-xs" />
                  <button className="text-af-mid font-medium" onClick={() => { const v = Number(rateInput.replace(',', '.')); if (v > 1) saveSettings({ usdBrl: v }, 'Cotação fixada'); else toast('Digite a cotação, ex.: 5,40', 'error'); }}>Fixar</button>
                  <button className="text-slate-500" onClick={() => saveSettings({ usdBrl: null }, 'Cotação automática')}>Automática</button>
                  <button className="text-slate-400" onClick={() => setEditRate(false)}>Cancelar</button>
                </>
              ) : (
                <>
                  <span>Dólar: <b>R$ {data.rate.usdBrl.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> ({data.rate.source === 'MANUAL' ? 'fixo' : data.rate.source === 'AUTO' ? 'cotação do dia' : 'estimado — cotação fora do ar'}) + IOF {(data.rate.iof * 100).toLocaleString('pt-BR')}% = <b>R$ {data.rate.cardRate.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> no cartão</span>
                  <button className="text-af-mid underline" onClick={() => { setRateInput(data.rate.manual ? String(data.rate.manual).replace('.', ',') : ''); setEditRate(true); }}>ajustar</button>
                </>
              )}
            </div>
          )}
        </div>

        {forbidden && <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 text-sm">Só administradores veem os custos.</div>}
        {isLoading && <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>}

        {data && st && sel && (
          <>
            {/* ── fatura do cartão ── */}
            <Card
              title={<span className="flex items-center gap-1.5"><CreditCard size={15} className="text-af-mid" /> Fatura do cartão — {monthLabel(st.month)}</span>}
              sub={<>Compras de {ddmm(st.from)} a {ddmm(st.closing)} · fecha {ddmm(st.closing)} · vence {ddmm(st.due)}{st.open ? (stLeft > 0 ? ` · faltam ${stLeft} dia${stLeft > 1 ? 's' : ''} pra fechar` : ' · fecha hoje') : ' · fechada'}</>}
              right={cardEdit ? (
                <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
                  fecha dia <input value={cardEdit.closing} onChange={(e) => setCardEdit({ ...cardEdit, closing: e.target.value })} className="w-10 border border-af-border rounded px-1 py-0.5 text-xs" />
                  vence dia <input value={cardEdit.due} onChange={(e) => setCardEdit({ ...cardEdit, due: e.target.value })} className="w-10 border border-af-border rounded px-1 py-0.5 text-xs" />
                  <button className="text-af-mid font-medium" onClick={() => saveSettings({ cardClosingDay: Number(cardEdit.closing), cardDueDay: Number(cardEdit.due) }, 'Datas do cartão salvas')}>Salvar</button>
                  <button className="text-slate-400" onClick={() => setCardEdit(null)}>Cancelar</button>
                </div>
              ) : (
                <button className="text-[11px] text-af-mid underline" onClick={() => setCardEdit({ closing: String(data.card.closingDay), due: String(data.card.dueDay) })}>fecha dia {data.card.closingDay} · vence dia {data.card.dueDay} (ajustar)</button>
              )}
            >
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
                <div className="rounded-lg bg-emerald-50 border border-emerald-100 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">Já cobrado</p>
                  <p className="text-2xl font-bold text-emerald-800">{brl(st.totals.paid)}</p>
                  <p className="text-[11px] text-emerald-700/80">{stCharges.filter((x) => x.status === 'PAGO').length} cobranças com data</p>
                </div>
                <div className="rounded-lg bg-amber-50 border border-amber-100 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-amber-700">{st.open ? 'Ainda deve entrar' : 'Consumo sem cobrança lançada'}</p>
                  <p className="text-2xl font-bold text-amber-800">{brl(Math.max(0, st.totals.estimated - st.totals.paid))}</p>
                  <p className="text-[11px] text-amber-700/80">{st.open ? `consumo projetado até ${ddmm(st.closing)} + cobranças previstas` : 'diferença entre o consumo e o pago'}</p>
                </div>
                <div className="rounded-lg bg-af-light border border-af-border p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-af-mid">Estimativa da fatura</p>
                  <p className="text-2xl font-bold text-af-dark">{brl(st.totals.estimated)}</p>
                  <p className="text-[11px] text-slate-500">vence {ddmm(st.due)} · dólar já com IOF</p>
                </div>
              </div>
              <table className="w-full text-xs">
                <thead><tr className="text-[11px] text-slate-400 text-left"><th className="font-medium py-1">Plataforma</th><th className="font-medium text-right">Já cobrado</th><th className="font-medium text-right">Estimado na fatura</th></tr></thead>
                <tbody>
                  {st.providers.filter((p) => p.estimated > 0 || p.paid > 0).map((p) => (
                    <tr key={p.provider} className="border-t border-slate-100">
                      <td className="py-1.5"><span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm" style={{ background: COLORS[p.provider] || '#94a3b8' }} />{p.label}</span></td>
                      <td className="text-right font-medium text-slate-800">{p.paid > 0 ? brl(p.paid) : <span className="text-slate-300">—</span>}</td>
                      <td className="text-right text-slate-600">{brl(p.estimated)}{!p.payments.length && p.projected ? <span className="text-[10px] text-slate-400"> · pelo consumo</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button onClick={() => setShowCharges(!showCharges)} className="mt-3 text-[11px] text-af-mid font-medium flex items-center gap-1"><ChevronDown size={12} className={cn('transition-transform', showCharges && 'rotate-180')} /> Cobranças com data ({stCharges.length})</button>
              {showCharges && (
                <div className="mt-1 divide-y divide-slate-100 text-xs">
                  {stCharges.map((x) => (
                    <div key={x.key} className="flex items-center gap-2 py-1.5">
                      <span className={cn('w-12 font-mono', x.status === 'PREVISTO' ? 'text-amber-700' : 'text-slate-600')} title={x.approx ? 'Lançamento sem o dia da cobrança — edite e informe a data' : undefined}>{ddmm(x.date)}{x.approx ? '?' : ''}</span>
                      <i className="h-2.5 w-2.5 rounded-sm flex-shrink-0" style={{ background: COLORS[x.provider] || '#94a3b8' }} />
                      <span className="flex-1 min-w-0 truncate text-slate-700">{x.label}{x.campaign && x.campaign !== x.label ? ` · ${x.campaign}` : ''}<span className="text-slate-400"> · {x.source === 'LANCADO' ? 'lançado' : x.source === 'RAILWAY' ? 'fatura da Railway' : 'cobrança da Meta'}</span>{x.status === 'PREVISTO' ? <span className="text-amber-700"> · previsto</span> : ''}</span>
                      <span className="text-right">{x.currency === 'USD' ? <span className="text-slate-400">{usd(x.amount)} → </span> : null}<b>{brl(x.brl)}</b></span>
                      {x.entryId && <button onClick={() => editById(x.entryId)} className="p-0.5 text-slate-400 hover:text-af-mid" title="Editar"><Pencil size={12} /></button>}
                    </div>
                  ))}
                  {!stCharges.length && <p className="py-2 text-slate-400">Nenhuma cobrança com data nesse ciclo ainda. Lance os pagamentos do cartão abaixo (ou ligue as cobranças automáticas).</p>}
                </div>
              )}
              {srcs && (
                <div className="mt-3 flex flex-wrap gap-1.5 text-[10px]">
                  <SourceChip ok={srcs.railway} on="Railway: faturas automáticas" off="Railway: lançar à mão (falta RAILWAY_API_TOKEN)" />
                  <SourceChip ok={srcs.metaAds.ok} on="Meta Ads: cobranças automáticas" off={`Meta Ads: lançar à mão (falta META_ADS_TOKEN com ads_read${srcs.metaAds.ok ? '' : ` na ${srcs.metaAds.account}`})`} />
                  <SourceChip ok={srcs.anthropicReal} on="Anthropic: consumo real" off="Anthropic: consumo estimado (falta ANTHROPIC_ADMIN_KEY)" />
                  <SourceChip ok={false} neutral on="" off="Anthropic e WhatsApp: as cobranças no cartão são lançadas à mão" />
                </div>
              )}
            </Card>

            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              <Kpi label={isCurrent ? 'Pago no mês até agora' : 'Pago no mês'} value={brl(sel.totals.paid)} cls="text-emerald-700" hint={sel.totals.scheduled > 0 ? `+ ${brl(sel.totals.scheduled)} previsto até o fim do mês` : 'cobranças no cartão com data no mês'} />
              <Kpi label={isCurrent ? 'Estimado do mês' : 'Custo do mês'} value={brl(sel.totals.estimated)} hint={isCurrent ? `projeção até ${ddmm(sel.to)} pelo consumo de ${sel.elapsedDays} dia${sel.elapsedDays > 1 ? 's' : ''}` : 'maior entre o pago e o consumo de cada plataforma'} />
              <Kpi label="Campanhas (Meta Ads)" value={brl(ads?.estimated ?? 0)} cls="text-[#2563eb]" hint={ads && (ads.paid > 0 || (ads.used ?? 0) > 0) ? `pago ${brl(ads.paid)}${ads.used != null ? ` · veiculado ${brl(ads.used)}` : ''}${row?.entered ? ` · ${brl(Math.max(ads.paid, ads.used ?? 0) / row.entered)} por lead` : ''}` : srcs?.metaAds.ok ? 'nada cobrado no mês' : 'lance as cobranças da Meta'} />
              <Kpi label="Custo por lead" value={per(row?.entered)} hint={row ? `${n0(row.entered)} cards novos · custo ${isCurrent ? 'até agora' : 'do mês'} ${brl(cost)}` : 'carregando…'} />
              <Kpi label="Custo por aprovado" value={per(row?.approved)} hint={row ? `${n0(row.approved)} aprovados (Aguardando Documentação)` : 'carregando…'} />
              <Kpi label="Custo por contratação" value={per(row?.contracted)} hint={row ? `${n0(row.contracted)} chegaram na vistoria` : 'carregando…'} />
            </div>

            <Card title="Últimos 6 meses" sub="Custo por mês (maior entre o pago e o consumo), separado por plataforma — o traço verde é o que foi cobrado no cartão">
              <div className="flex items-end gap-3 h-44">
                {data.trend.map((t) => {
                  const top = Math.max(t.estimated, t.paid);
                  return (
                    <button key={t.month} onClick={() => setMonth(t.month)} className="flex-1 flex flex-col items-center justify-end gap-1 h-full group" title={`${monthLabel(t.month)}: estimado ${brl(t.estimated)} · pago ${brl(t.paid)}`}>
                      <span className="text-[11px] font-medium text-slate-600">{t.estimated > 0 ? brl(t.estimated).replace(/\s/g, ' ') : '—'}</span>
                      <div className="relative w-full max-w-[56px] flex flex-col justify-end" style={{ height: `${Math.max(2, (top / maxTrend) * 100)}%` }}>
                        <div className={cn('w-full flex flex-col-reverse rounded-t overflow-hidden', t.month === month ? 'ring-2 ring-af-mid' : 'group-hover:ring-1 ring-slate-300')} style={{ height: `${top > 0 ? (t.estimated / top) * 100 : 0}%` }}>
                          {Object.entries(t.byProvider).sort((a, b) => b[1] - a[1]).map(([p, v]) => <div key={p} style={{ height: `${(v / t.estimated) * 100}%`, background: COLORS[p] || '#94a3b8' }} />)}
                        </div>
                        {t.paid > 0 && <div className="absolute left-0 right-0 border-t-2 border-emerald-500" style={{ bottom: `${(t.paid / top) * 100}%` }} />}
                      </div>
                      <span className="text-[11px] text-slate-500 capitalize">{monthLabel(t.month, true)}</span>
                    </button>
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3">
                {providerKeys.map((p) => <span key={p} className="text-[11px] text-slate-500 flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COLORS[p] || '#94a3b8' }} />{data.providerOptions.find((o) => o.key === p)?.label || p}</span>)}
                <span className="text-[11px] text-slate-500 flex items-center gap-1"><i className="inline-block h-0.5 w-3 bg-emerald-500" />pago no cartão</span>
              </div>
            </Card>

            <Card title={`Onde o dinheiro vai — ${monthLabel(month)}`} sub="Pago = cobranças no cartão com data no mês · Estimado = o maior entre o pago e o consumo do mês (projetado até o fim do mês, se ainda está correndo). Clique numa linha para ver o detalhe.">
              <div className="flex items-center gap-3 px-1 pb-1 text-[10px] uppercase tracking-wide text-slate-400">
                <span className="w-3" /><span className="flex-1">Plataforma</span><span className="w-24 text-right">Pago</span><span className="w-24 text-right">Estimado</span><span className="w-4" />
              </div>
              <div className="divide-y divide-slate-100">
                {sel.providers.map((b) => {
                  const isOpen = !!open[b.provider];
                  const tag = b.consumption?.error ? 'erro ao ler' : b.consumption ? (b.consumption.kind === 'REAL' ? 'consumo real' : 'consumo estimado') : b.payments.length ? 'lançado' : 'sem dado';
                  return (
                    <div key={b.provider}>
                      <button onClick={() => setOpen({ ...open, [b.provider]: !isOpen })} className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-slate-50 px-1 rounded">
                        <i className="h-3 w-3 rounded-sm flex-shrink-0" style={{ background: COLORS[b.provider] || '#94a3b8' }} />
                        <span className="text-sm text-slate-800 flex-1 min-w-0 truncate">{b.label} <span className={cn('ml-1 text-[10px] px-1.5 py-0.5 rounded-full border align-middle', b.consumption?.error ? 'border-red-200 text-red-600 bg-red-50' : 'border-slate-200 text-slate-500')}>{tag}</span></span>
                        <span className={cn('w-24 text-right text-sm', b.paid > 0 ? 'font-semibold text-emerald-700' : 'text-slate-300')}>{b.paid > 0 ? brl(b.paid) : '—'}</span>
                        <span className="w-24 text-right text-sm font-semibold text-slate-800">{brl(b.estimated)}</span>
                        <ChevronDown size={14} className={cn('w-4 text-slate-400 transition-transform', isOpen && 'rotate-180')} />
                      </button>
                      {isOpen && <BlockDetail b={b} onEditId={editById} onAdd={() => newPayment(b.provider)} metaAds={srcs?.metaAds} />}
                    </div>
                  );
                })}
                <div className="flex items-center gap-3 py-2.5 px-1 border-t-2 border-slate-200">
                  <span className="w-3" /><span className="flex-1 text-sm font-semibold text-slate-800">Total</span>
                  <span className="w-24 text-right text-sm font-bold text-emerald-700">{brl(sel.totals.paid)}</span>
                  <span className="w-24 text-right text-sm font-bold text-slate-800">{brl(sel.totals.estimated)}</span><span className="w-4" />
                </div>
              </div>
            </Card>

            <Card
              title="Pagamentos lançados"
              sub="Cobranças no cartão que o CRM não lê sozinho (compra de crédito da Anthropic, assinatura, WhatsApp, campanhas da Meta sem a chave, domínio…). Recorrente = cobra no mesmo dia todo mês."
              right={<Button size="sm" onClick={() => newPayment()}><Plus size={14} /> Novo pagamento</Button>}
            >
              {form && (
                <div className="border border-af-border rounded-lg p-3 mb-3 bg-slate-50 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <label className="flex flex-col gap-1">Plataforma
                    <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} className="border border-af-border rounded px-2 py-1.5 bg-white text-sm">
                      {data.providerOptions.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                    </select>
                  </label>
                  {form.provider === 'META_ADS' ? (
                    <label className="flex flex-col gap-1 md:col-span-2">Campanha (opcional)
                      <input value={form.campaign} onChange={(e) => setForm({ ...form, campaign: e.target.value })} placeholder="Nome da campanha, ou em branco pra cobrança da conta" className="border border-af-border rounded px-2 py-1.5 bg-white text-sm" />
                    </label>
                  ) : (
                    <label className="flex flex-col gap-1 md:col-span-2">Descrição
                      <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Ex.: Créditos da API, Plano Max, Renovação do domínio…" className="border border-af-border rounded px-2 py-1.5 bg-white text-sm" />
                    </label>
                  )}
                  <label className="flex flex-col gap-1">Valor cobrado
                    <div className="flex gap-1">
                      <input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0,00" inputMode="decimal" className="border border-af-border rounded px-2 py-1.5 bg-white text-sm w-full" />
                      <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className="border border-af-border rounded px-1 bg-white text-sm"><option value="BRL">R$</option><option value="USD">US$</option></select>
                    </div>
                  </label>
                  <label className="flex flex-col gap-1">{form.recurring ? 'Data da 1ª cobrança' : 'Data do pagamento'}
                    <input type="date" value={form.paidAt} onChange={(e) => setForm({ ...form, paidAt: e.target.value })} className="border border-af-border rounded px-2 py-1.5 bg-white text-sm" />
                  </label>
                  <label className="flex items-center gap-2 mt-5"><input type="checkbox" checked={form.recurring} onChange={(e) => setForm({ ...form, recurring: e.target.checked })} /> Todo mês{form.paidAt ? ` (dia ${Number(form.paidAt.slice(8, 10))})` : ''}</label>
                  {form.recurring && (
                    <label className="flex flex-col gap-1">Até (opcional)
                      <input type="month" value={form.endMonth} onChange={(e) => setForm({ ...form, endMonth: e.target.value })} className="border border-af-border rounded px-2 py-1.5 bg-white text-sm" />
                    </label>
                  )}
                  <label className={cn('flex flex-col gap-1', form.recurring ? 'md:col-span-2' : 'md:col-span-3')}>Observação
                    <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="border border-af-border rounded px-2 py-1.5 bg-white text-sm" />
                  </label>
                  {data.providerOptions.find((p) => p.key === form.provider)?.auto && (
                    <p className="md:col-span-4 text-amber-700">Essa plataforma já vem automática: com a cobrança automática respondendo, lançamento manual dela não entra na conta.</p>
                  )}
                  <div className="md:col-span-4 flex gap-2 justify-end">
                    <Button size="sm" variant="ghost" onClick={() => setForm(null)}>Cancelar</Button>
                    <Button size="sm" loading={saving} onClick={saveEntry}>Salvar</Button>
                  </div>
                </div>
              )}
              <div className="divide-y divide-slate-100">
                {data.entries.map((e) => (
                  <div key={e.id} className="flex items-center gap-2 py-2 text-sm">
                    <i className="h-2.5 w-2.5 rounded-sm flex-shrink-0" style={{ background: COLORS[e.provider] || '#94a3b8' }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-slate-800 truncate">{e.label} <span className="text-[11px] text-slate-400">· {data.providerOptions.find((p) => p.key === e.provider)?.label}{e.campaign && e.campaign !== e.label ? ` · ${e.campaign}` : ''}</span></p>
                      <p className="text-[11px] text-slate-400">
                        {e.recurring
                          ? <>todo mês{e.chargeDay ? `, dia ${e.chargeDay}` : <span className="text-amber-700"> — sem o dia da cobrança (edite e informe)</span>}, desde {monthLabel(e.month, true)}{e.endMonth ? ` até ${monthLabel(e.endMonth, true)}` : ''}</>
                          : e.paidAt ? <>pago em {e.paidAt.split('-').reverse().join('/')}</> : <span className="text-amber-700">{monthLabel(e.month)} — sem a data (edite e informe)</span>}
                        {e.note ? ` · ${e.note}` : ''}
                      </p>
                    </div>
                    <span className="font-semibold text-slate-800">{money(e.amount, e.currency)}</span>
                    <button onClick={() => editEntry(e)} className="p-1 text-slate-400 hover:text-af-mid" title="Editar"><Pencil size={14} /></button>
                    <button onClick={() => removeEntry(e)} className="p-1 text-slate-400 hover:text-red-600" title="Apagar"><Trash2 size={14} /></button>
                  </div>
                ))}
                {!data.entries.length && <p className="text-sm text-slate-400 py-3">Nenhum pagamento lançado em {monthLabel(month)}.</p>}
              </div>
            </Card>

            <p className="text-[11px] text-slate-400">
              Como ler: <b>Pago</b> é o que já caiu no cartão, com a data da cobrança (faturas da Railway e cobranças da Meta Ads vêm sozinhas quando a chave está ligada; o resto é lançado).
              <b> Estimado</b> é o maior entre o pago e o consumo medido (WhatsApp e campanhas: valor real da Meta; Anthropic: real com a chave de administrador, senão estimado pelo uso gravado), projetado até o fim do período.
              Valores em dólar usam a cotação + IOF de {(data.rate.iof * 100).toLocaleString('pt-BR')}% do cartão. Custo por lead/aprovado/contratação usa o custo {isCurrent ? 'até agora' : 'do mês'}.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function SourceChip({ ok, on, off, neutral }: { ok: boolean; on: string; off: string; neutral?: boolean }) {
  return <span className={cn('px-2 py-0.5 rounded-full border', ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : neutral ? 'border-slate-200 bg-slate-50 text-slate-500' : 'border-amber-200 bg-amber-50 text-amber-700')}>{ok ? on : off}</span>;
}

function BlockDetail({ b, onEditId, onAdd, metaAds }: { b: Row; onEditId: (id?: string) => void; onAdd: () => void; metaAds?: Overview['sources']['metaAds'] }) {
  const c = b.consumption;
  const d = c?.detail || {};
  return (
    <div className="pl-7 pr-2 pb-3 space-y-2 text-xs text-slate-600">
      {c?.error && <p className="text-red-600">Não consegui ler o consumo: {c.error}</p>}
      {c && !c.error && (
        <p>
          Consumo {c.kind === 'REAL' ? 'real' : 'estimado'} até hoje: <b>{brl(c.usedBrl)}</b>{d.usd != null ? <span className="text-slate-400"> ({usd(d.usd)})</span> : null}
          {c.projectedBrl !== c.usedBrl ? <> · projeção até o fim do mês: <b>{brl(c.projectedBrl)}</b></> : null}
        </p>
      )}
      {b.provider === 'ANTHROPIC' && c && (
        <div className="space-y-1">
          {c.kind === 'REAL' && d.estimativaUsd != null && <p className="text-slate-400">Custo real lido da Anthropic (cost_report); a estimativa pelo uso gravado dava {usd(d.estimativaUsd)}.</p>}
          {d.realError && <p className="text-amber-700">Não consegui ler o custo real na Anthropic ({d.realError}) — mostrando a estimativa.</p>}
          {c.kind !== 'REAL' && <p className="text-slate-400">{c.noData ? 'Sem uso registrado nesse mês (o registro começou em 16/10).' : <>{n0(d.calls || 0)} chamadas{d.errors ? `, ${n0(d.errors)} com erro` : ''} · {n0(d.tokensIn || 0)} tokens de entrada, {n0(d.tokensOut || 0)} de saída — preço de tabela.</>}</p>}
          {!!d.topFeatures?.length && (
            <table className="w-full max-w-xl"><tbody>
              {d.topFeatures.map((f: any) => <tr key={f.feature} className="border-t border-slate-100"><td className="py-1 pr-2 truncate max-w-[260px]">{f.feature}</td><td className="text-right text-slate-400">{n0(f.calls)} chamadas</td><td className="text-right w-20">{usd(f.usd)}</td></tr>)}
            </tbody></table>
          )}
          <p className="text-slate-400">A Anthropic cobra no cartão quando compra crédito: lance cada compra com a data (o pago); o consumo acima é o estimado.</p>
        </div>
      )}
      {b.provider === 'WHATSAPP' && c && !c.error && (
        <div>
          {c.noData ? <p>Sem mensagens cobradas nesse mês.</p> : (
            <>
              <p><b>{n0(d.volume || 0)}</b> mensagens, custo real da Meta ({d.currency}).</p>
              <table className="mt-1 w-full max-w-xl"><tbody>
                {(d.categories || []).map((x: any, i: number) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="py-1 pr-2">{WA_CAT[x.category] || x.category}{/FREE/.test(x.type) ? <span className="text-slate-400"> · grátis</span> : ''}</td>
                    <td className="text-right text-slate-400">{n0(x.volume)} msgs</td>
                    <td className="text-right w-24">{money(x.cost, d.currency)}</td>
                    <td className="text-right w-24 text-slate-400">{brl(x.costBrl)}</td>
                  </tr>
                ))}
              </tbody></table>
              {(() => {
                const mk = (d.categories || []).filter((x: any) => x.category === 'MARKETING').reduce((s: number, x: any) => s + x.costBrl, 0);
                const all = (d.categories || []).reduce((s: number, x: any) => s + x.costBrl, 0);
                return all > 0 && mk / all > 0.5 ? <p className="mt-1 text-amber-700">Mensagens de <b>Marketing</b> respondem por {Math.round((mk / all) * 100)}% do gasto — são as mais caras por mensagem.</p> : null;
              })()}
            </>
          )}
        </div>
      )}
      {b.provider === 'RAILWAY' && c && !c.error && (
        <div>
          {(d.faturas || []).length ? (
            <table className="w-full max-w-xl"><tbody>
              {d.faturas.map((f: any, i: number) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1 pr-2">Fatura {f.de.split('-').reverse().join('/')} a {f.ate.split('-').reverse().join('/')}{f.status !== 'paid' ? <span className="text-amber-700"> · em aberto</span> : ''}</td>
                  <td className="text-right w-24">{usd(f.usd)}</td>
                </tr>
              ))}
            </tbody></table>
          ) : <p>Nenhuma fatura da Railway fechou nesse período.</p>}
          {d.cicloAtualUsd != null && <p className="mt-1">Ciclo atual até agora: <b>{usd(d.cicloAtualUsd)}</b> · projeção {usd(d.cicloProjecaoUsd)} — cobra em {String(d.cicloAte).split('-').reverse().join('/')}.</p>}
        </div>
      )}
      {b.provider === 'VOYAGE' && c && (
        <p className="text-slate-400">{c.noData ? 'Sem uso registrado nesse mês.' : <>{n0(d.tokens || 0)} tokens em {n0(d.calls || 0)} chamadas · a US$ {d.usdPorMilhao}/milhão. A Voyage dá uma franquia grátis grande: o custo real costuma ser zero.</>}</p>
      )}
      {b.provider === 'META_ADS' && (
        <div>
          {c && !c.error ? (
            c.noData ? <p>Nenhum gasto de campanha nesse mês.</p> : (
              <table className="mt-1 w-full max-w-xl"><tbody>
                {(d.campaigns || []).map((x: any, i: number) => (
                  <tr key={x.id || i} className="border-t border-slate-100">
                    <td className="py-1 pr-2 truncate max-w-[300px]">{x.name}</td>
                    <td className="text-right w-24">{brl(x.brl)}</td>
                  </tr>
                ))}
              </tbody></table>
            )
          ) : !c && (
            <p className="text-slate-400">Automático desligado: falta um token da Meta com <b>ads_read</b> na conta de anúncios{metaAds && !metaAds.ok ? ` ${metaAds.account}` : ''}{metaAds && !metaAds.ok && metaAds.reason ? ` (${metaAds.reason})` : ''}. Até lá, lance cada cobrança da Meta com a data.</p>
          )}
          {b.paymentsError && <p className="text-amber-700">Não consegui ler as cobranças: {b.paymentsError}</p>}
        </div>
      )}
      {b.manualReplaced && <p className="text-emerald-700">A cobrança automática está ligada: os lançamentos manuais dessa plataforma saíram da conta.</p>}
      {b.payments.length > 0 && (
        <div>
          <p className="font-medium text-slate-700 mt-1">Cobranças no mês</p>
          {b.payments.map((x) => (
            <div key={x.key} className="flex items-center gap-2 py-0.5">
              <span className={cn('w-12 font-mono', x.status === 'PREVISTO' ? 'text-amber-700' : '')}>{ddmm(x.date)}{x.approx ? '?' : ''}</span>
              <span className="flex-1 truncate">{x.label}{x.campaign && x.campaign !== x.label ? ` · ${x.campaign}` : ''}{x.status === 'PREVISTO' ? ' · previsto' : ''}</span>
              <span>{x.currency === 'USD' ? `${usd(x.amount)} → ` : ''}<b>{brl(x.brl)}</b></span>
              {x.entryId && <button onClick={() => onEditId(x.entryId)} className="p-0.5 text-slate-400 hover:text-af-mid"><Pencil size={12} /></button>}
            </div>
          ))}
        </div>
      )}
      <button onClick={onAdd} className="text-af-mid font-medium flex items-center gap-1"><Plus size={12} /> Lançar pagamento de {b.label}</button>
    </div>
  );
}
