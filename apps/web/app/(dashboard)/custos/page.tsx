'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { Topbar } from '@/components/ui/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

/* Painel de custos (Fabio 22/10): tudo que é pago por causa do CRM, mês a mês, em reais. Só administrador.
 * Dados: GET /api/costs?month=AAAA-MM (costs.service.ts) + GET /api/reports/monthly (leads, aprovados e contratações do mês, pra custo por resultado). */

interface Entry { id: string; provider: string; label: string; amount: number; currency: string; month: string; recurring: boolean; endMonth: string | null; kind: string; campaign: string | null; note: string | null }
interface Block {
  provider: string; label: string; brl: number; usd: number; replacedAuto: boolean;
  auto: null | { kind: 'ESTIMATIVA' | 'REAL'; brl: number; usd: number; noData?: boolean; error?: string; detail: any };
  manual: (Entry & { brl: number })[];
}
interface Overview {
  month: string;
  rate: { usdBrl: number; source: 'MANUAL' | 'AUTO' | 'ESTIMADA'; manual: number | null };
  selected: { month: string; totalBrl: number; providers: Block[] };
  trend: { month: string; totalBrl: number; byProvider: Record<string, number> }[];
  entries: Entry[];
  providerOptions: { key: string; label: string; auto: boolean }[];
}
interface MonthRow { month: string; entered: number; approved: number; docsSent: number; contracted: number }

const COLORS: Record<string, string> = {
  WHATSAPP: '#16a34a', ANTHROPIC: '#7c3aed', RAILWAY: '#0ea5e9', META_ADS: '#2563eb', VOYAGE: '#f59e0b',
  ELEVENLABS: '#ec4899', GOOGLE: '#ef4444', EMAIL: '#14b8a6', DOMINIO: '#64748b', OUTRO: '#94a3b8',
};
const WA_CAT: Record<string, string> = { MARKETING: 'Marketing', UTILITY: 'Utilidade', SERVICE: 'Atendimento', AUTHENTICATION: 'Autenticação', MARKETING_LITE: 'Marketing lite' };

const brl = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const usd = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'USD' });
const n0 = (v: number) => v.toLocaleString('pt-BR');
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
const nowMonth = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7);

function Kpi({ label, value, hint, cls }: { label: string; value: string; hint?: string; cls?: string }) {
  return (
    <div className="bg-white rounded-xl border border-af-border p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={cn('text-2xl font-bold mt-1', cls || 'text-slate-800')}>{value}</p>
      {hint && <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">{hint}</p>}
    </div>
  );
}

function Card({ title, sub, children, right }: { title: string; sub?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="bg-white rounded-xl border border-af-border p-4">
      <div className="flex items-start justify-between gap-2">
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

const EMPTY_FORM = { id: '', provider: 'RAILWAY', label: '', amount: '', currency: 'BRL', month: '', recurring: false, endMonth: '', kind: 'EXTRA', campaign: '', note: '' };

export default function CustosPage() {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(nowMonth());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [form, setForm] = useState<typeof EMPTY_FORM | null>(null);
  const [saving, setSaving] = useState(false);
  const [rateInput, setRateInput] = useState('');
  const [editRate, setEditRate] = useState(false);

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
  const prevTotal = data?.trend.length && data.trend.length > 1 ? data.trend[data.trend.length - 2].totalBrl : null;
  const total = data?.selected.totalBrl ?? 0;
  const per = (count: number | undefined) => (count && count > 0 && total > 0 ? brl(total / count) : '—');

  async function saveEntry() {
    if (!form) return;
    setSaving(true);
    const body = {
      provider: form.provider, label: form.label, amount: Number(String(form.amount).replace(/\./g, '').replace(',', '.')), currency: form.currency,
      month: form.month || month, recurring: form.recurring, endMonth: form.recurring && form.endMonth ? form.endMonth : null, kind: form.kind, campaign: form.campaign || null, note: form.note || null,
    };
    try {
      if (form.id) await api.put(`/api/costs/entries/${form.id}`, body); else await api.post('/api/costs/entries', body);
      toast('Lançamento salvo', 'success');
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
    setForm({ id: e.id, provider: e.provider, label: e.label, amount: String(e.amount).replace('.', ','), currency: e.currency, month: e.month, recurring: e.recurring, endMonth: e.endMonth || '', kind: e.kind, campaign: e.campaign || '', note: e.note || '' });
  }
  async function saveRate(value: number | null) {
    try { await api.put('/api/costs/settings', { usdBrl: value }); toast(value ? 'Cotação fixada' : 'Cotação automática', 'success'); setEditRate(false); refresh(); }
    catch (e: any) { toast(e?.response?.data?.error || 'Cotação inválida', 'error'); }
  }

  const maxTrend = Math.max(1, ...(data?.trend.map((t) => t.totalBrl) || [1]));
  const providerKeys = Array.from(new Set((data?.trend || []).flatMap((t) => Object.keys(t.byProvider))));
  const autoOption = data?.providerOptions.find((p) => p.key === form?.provider)?.auto;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Custos do CRM" subtitle="Tudo que é pago por causa do CRM, mês a mês — IA, WhatsApp, hospedagem, campanhas e o resto" />
      <div className="flex-1 overflow-auto px-4 md:px-6 py-4 space-y-4 scrollbar-thin">
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => setMonth(shiftMonth(month, -1))} className="p-1.5 rounded-lg border border-af-border hover:bg-af-light" title="Mês anterior"><ChevronLeft size={16} /></button>
          <span className="text-sm font-semibold text-slate-800 capitalize min-w-[150px] text-center">{monthLabel(month)}</span>
          <button onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= nowMonth()} className="p-1.5 rounded-lg border border-af-border hover:bg-af-light disabled:opacity-30" title="Próximo mês"><ChevronRight size={16} /></button>
          {month !== nowMonth() && <button onClick={() => setMonth(nowMonth())} className="text-xs text-af-mid underline">Mês atual</button>}
          {data && (
            <div className="ml-auto text-[11px] text-slate-500 flex items-center gap-2">
              {editRate ? (
                <>
                  <span>US$ 1 =</span>
                  <input value={rateInput} onChange={(e) => setRateInput(e.target.value)} placeholder="5,40" className="w-16 border border-af-border rounded px-1.5 py-0.5 text-xs" />
                  <button className="text-af-mid font-medium" onClick={() => { const v = Number(rateInput.replace(',', '.')); if (v > 1) saveRate(v); else toast('Digite a cotação, ex.: 5,40', 'error'); }}>Fixar</button>
                  <button className="text-slate-500" onClick={() => saveRate(null)}>Automática</button>
                  <button className="text-slate-400" onClick={() => setEditRate(false)}>Cancelar</button>
                </>
              ) : (
                <>
                  <span>Dólar: <b>R$ {data.rate.usdBrl.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b> ({data.rate.source === 'MANUAL' ? 'fixo' : data.rate.source === 'AUTO' ? 'cotação do dia' : 'estimado — cotação fora do ar'})</span>
                  <button className="text-af-mid underline" onClick={() => { setRateInput(data.rate.manual ? String(data.rate.manual).replace('.', ',') : ''); setEditRate(true); }}>ajustar</button>
                </>
              )}
            </div>
          )}
        </div>

        {forbidden && <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-4 text-sm">Só administradores veem os custos.</div>}
        {isLoading && <div className="grid grid-cols-2 md:grid-cols-4 gap-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}</div>}

        {data && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Kpi
                label={month === nowMonth() ? 'Total até agora' : 'Total do mês'}
                value={brl(total)}
                hint={prevTotal != null && prevTotal > 0 ? `${total >= prevTotal ? '▲' : '▼'} ${brl(Math.abs(total - prevTotal))} contra ${monthLabel(shiftMonth(month, -1), true)} (${brl(prevTotal)})` : `${usd(data.selected.providers.reduce((s, p) => s + p.usd, 0))} no câmbio usado`}
              />
              <Kpi label="Custo por lead" value={per(row?.entered)} hint={row ? `${n0(row.entered)} cards novos no mês` : 'carregando…'} />
              <Kpi label="Custo por aprovado" value={per(row?.approved)} hint={row ? `${n0(row.approved)} aprovados (chegaram em Aguardando Documentação)` : 'carregando…'} />
              <Kpi label="Custo por contratação" value={per(row?.contracted)} hint={row ? `${n0(row.contracted)} chegaram na vistoria do imóvel` : 'carregando…'} />
            </div>

            <Card title="Últimos 6 meses" sub="Total por mês, em reais, separado por fornecedor">
              <div className="flex items-end gap-3 h-44">
                {data.trend.map((t) => (
                  <button key={t.month} onClick={() => setMonth(t.month)} className={cn('flex-1 flex flex-col items-center justify-end gap-1 h-full group', t.month === month && 'opacity-100')} title={`${monthLabel(t.month)}: ${brl(t.totalBrl)}`}>
                    <span className="text-[11px] font-medium text-slate-600">{t.totalBrl > 0 ? brl(t.totalBrl).replace(/\s/g, ' ') : '—'}</span>
                    <div className={cn('w-full max-w-[56px] flex flex-col-reverse rounded-t overflow-hidden', t.month === month ? 'ring-2 ring-af-mid' : 'group-hover:ring-1 ring-slate-300')} style={{ height: `${Math.max(2, (t.totalBrl / maxTrend) * 100)}%` }}>
                      {Object.entries(t.byProvider).sort((a, b) => b[1] - a[1]).map(([p, v]) => <div key={p} style={{ height: `${(v / t.totalBrl) * 100}%`, background: COLORS[p] || '#94a3b8' }} />)}
                    </div>
                    <span className="text-[11px] text-slate-500 capitalize">{monthLabel(t.month, true)}</span>
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1 mt-3">
                {providerKeys.map((p) => <span key={p} className="text-[11px] text-slate-500 flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: COLORS[p] || '#94a3b8' }} />{data.providerOptions.find((o) => o.key === p)?.label || p}</span>)}
              </div>
              <p className="text-[11px] text-slate-400 mt-2">Meses antes de 16/10 não têm a estimativa da IA (a coleta começou nessa data): lance a fatura real da Anthropic pra completar.</p>
            </Card>

            <Card title={`Onde o dinheiro vai — ${monthLabel(month)}`} sub="Clique numa linha para ver o detalhe">
              <div className="divide-y divide-slate-100">
                {data.selected.providers.map((b) => {
                  const isOpen = !!open[b.provider];
                  const pct = total > 0 ? (b.brl / total) * 100 : 0;
                  const tag = b.replacedAuto ? 'fatura real' : b.auto ? (b.auto.kind === 'REAL' ? 'real (Meta)' : 'estimativa') : 'manual';
                  return (
                    <div key={b.provider}>
                      <button onClick={() => setOpen({ ...open, [b.provider]: !isOpen })} className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-slate-50 px-1 rounded">
                        <i className="h-3 w-3 rounded-sm flex-shrink-0" style={{ background: COLORS[b.provider] || '#94a3b8' }} />
                        <span className="text-sm text-slate-800 flex-1 min-w-0 truncate">{b.label}</span>
                        <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full border', b.auto?.error ? 'border-red-200 text-red-600 bg-red-50' : 'border-slate-200 text-slate-500')}>{b.auto?.error ? 'erro ao ler' : tag}</span>
                        <div className="hidden sm:block w-32 h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: COLORS[b.provider] || '#94a3b8' }} /></div>
                        <span className="text-sm font-semibold text-slate-800 w-28 text-right">{brl(b.brl)}</span>
                        <span className="text-[11px] text-slate-400 w-10 text-right">{pct >= 1 ? `${Math.round(pct)}%` : pct > 0 ? '<1%' : ''}</span>
                        <ChevronDown size={14} className={cn('text-slate-400 transition-transform', isOpen && 'rotate-180')} />
                      </button>
                      {isOpen && <BlockDetail b={b} onEdit={editEntry} onDelete={removeEntry} />}
                    </div>
                  );
                })}
                {!data.selected.providers.length && <p className="text-sm text-slate-400 py-4">Sem custos nesse mês.</p>}
              </div>
            </Card>

            <Card
              title="Lançamentos manuais"
              sub="Custos que o CRM não lê sozinho (Railway, campanhas da Meta, domínio…) e a fatura real de quem o CRM só estima (Anthropic). Recorrente = vale todo mês."
              right={<Button size="sm" onClick={() => setForm({ ...EMPTY_FORM, month })}><Plus size={14} /> Novo lançamento</Button>}
            >
              {form && (
                <div className="border border-af-border rounded-lg p-3 mb-3 bg-slate-50 grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                  <label className="flex flex-col gap-1">Fornecedor
                    <select value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value, kind: 'EXTRA' })} className="border border-af-border rounded px-2 py-1.5 bg-white text-sm">
                      {data.providerOptions.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1 md:col-span-2">Descrição
                    <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Ex.: Plano Pro, Campanha Home Equity…" className="border border-af-border rounded px-2 py-1.5 bg-white text-sm" />
                  </label>
                  <label className="flex flex-col gap-1">Valor
                    <div className="flex gap-1">
                      <input value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0,00" inputMode="decimal" className="border border-af-border rounded px-2 py-1.5 bg-white text-sm w-full" />
                      <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })} className="border border-af-border rounded px-1 bg-white text-sm"><option value="BRL">R$</option><option value="USD">US$</option></select>
                    </div>
                  </label>
                  <label className="flex flex-col gap-1">{form.recurring ? 'A partir de' : 'Mês'}
                    <input type="month" value={form.month || month} onChange={(e) => setForm({ ...form, month: e.target.value })} className="border border-af-border rounded px-2 py-1.5 bg-white text-sm" />
                  </label>
                  <label className="flex items-center gap-2 mt-5"><input type="checkbox" checked={form.recurring} onChange={(e) => setForm({ ...form, recurring: e.target.checked })} /> Todo mês</label>
                  {form.recurring && (
                    <label className="flex flex-col gap-1">Até (opcional)
                      <input type="month" value={form.endMonth} onChange={(e) => setForm({ ...form, endMonth: e.target.value })} className="border border-af-border rounded px-2 py-1.5 bg-white text-sm" />
                    </label>
                  )}
                  {autoOption && (
                    <label className="flex flex-col gap-1 md:col-span-2">Tipo
                      <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className="border border-af-border rounded px-2 py-1.5 bg-white text-sm">
                        <option value="EXTRA">Custo adicional (soma ao automático)</option>
                        <option value="ACTUAL">Fatura real (substitui a estimativa do mês)</option>
                      </select>
                    </label>
                  )}
                  {form.provider === 'META_ADS' && (
                    <label className="flex flex-col gap-1 md:col-span-2">Campanha
                      <input value={form.campaign} onChange={(e) => setForm({ ...form, campaign: e.target.value })} placeholder="Nome da campanha" className="border border-af-border rounded px-2 py-1.5 bg-white text-sm" />
                    </label>
                  )}
                  <label className="flex flex-col gap-1 md:col-span-4">Observação
                    <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className="border border-af-border rounded px-2 py-1.5 bg-white text-sm" />
                  </label>
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
                      <p className="text-slate-800 truncate">{e.label} <span className="text-[11px] text-slate-400">· {data.providerOptions.find((p) => p.key === e.provider)?.label}{e.campaign ? ` · ${e.campaign}` : ''}</span></p>
                      <p className="text-[11px] text-slate-400">{e.recurring ? `todo mês desde ${monthLabel(e.month, true)}${e.endMonth ? ` até ${monthLabel(e.endMonth, true)}` : ''}` : monthLabel(e.month)}{e.kind === 'ACTUAL' ? ' · fatura real' : ''}{e.note ? ` · ${e.note}` : ''}</p>
                    </div>
                    <span className="font-semibold text-slate-800">{e.currency === 'USD' ? usd(e.amount) : brl(e.amount)}</span>
                    <button onClick={() => editEntry(e)} className="p-1 text-slate-400 hover:text-af-mid" title="Editar"><Pencil size={14} /></button>
                    <button onClick={() => removeEntry(e)} className="p-1 text-slate-400 hover:text-red-600" title="Apagar"><Trash2 size={14} /></button>
                  </div>
                ))}
                {!data.entries.length && <p className="text-sm text-slate-400 py-3">Nenhum lançamento em {monthLabel(month)}. Comece por Railway (assinatura/uso do mês) e pelas campanhas da Meta.</p>}
              </div>
            </Card>

            <p className="text-[11px] text-slate-400">
              Como ler: <b>WhatsApp</b> é o valor real cobrado pela Meta (pode atrasar até 1 dia); <b>Anthropic</b> e <b>Voyage</b> são estimativas pelo uso gravado pelo CRM, a preço de tabela — confira com a fatura e lance a real aqui; o resto é o que você lançar.
              Meses passados usam a cotação de hoje.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function BlockDetail({ b, onEdit, onDelete }: { b: Block; onEdit: (e: Entry) => void; onDelete: (e: Entry) => void }) {
  const d = b.auto?.detail || {};
  return (
    <div className="pl-7 pr-2 pb-3 space-y-2 text-xs text-slate-600">
      {b.auto?.error && <p className="text-red-600">Não consegui ler o valor: {b.auto.error}</p>}
      {b.provider === 'ANTHROPIC' && b.auto && (
        <div>
          <p>{b.auto.noData ? 'Sem uso registrado nesse mês (o registro começou em 16/10).' : <>Estimativa <b>{usd(b.auto.usd)}</b> ({brl(b.auto.brl)}) · {n0(d.calls || 0)} chamadas{d.errors ? `, ${n0(d.errors)} com erro` : ''} · {n0(d.tokensIn || 0)} tokens de entrada, {n0(d.tokensOut || 0)} de saída{d.firstDay ? ` · dados desde ${d.firstDay.split('-').reverse().join('/')}` : ''}</>}</p>
          {b.replacedAuto && <p className="text-emerald-700">Substituída pela fatura real lançada.</p>}
          {!!d.topFeatures?.length && (
            <table className="mt-1 w-full max-w-xl"><tbody>
              {d.topFeatures.map((f: any) => <tr key={f.feature} className="border-t border-slate-100"><td className="py-1 pr-2 truncate max-w-[260px]">{f.feature}</td><td className="text-right text-slate-400">{n0(f.calls)} chamadas</td><td className="text-right w-20">{usd(f.usd)}</td></tr>)}
            </tbody></table>
          )}
        </div>
      )}
      {b.provider === 'WHATSAPP' && b.auto && !b.auto.error && (
        <div>
          {b.auto.noData ? <p>Sem mensagens cobradas nesse mês.</p> : (
            <>
              <p><b>{n0(d.volume || 0)}</b> mensagens no mês, custo real da Meta ({d.currency}).</p>
              <table className="mt-1 w-full max-w-xl"><tbody>
                {(d.categories || []).map((c: any, i: number) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="py-1 pr-2">{WA_CAT[c.category] || c.category}{/FREE/.test(c.type) ? <span className="text-slate-400"> · grátis</span> : ''}</td>
                    <td className="text-right text-slate-400">{n0(c.volume)} msgs</td>
                    <td className="text-right w-24">{d.currency === 'USD' ? usd(c.cost) : brl(c.cost)}</td>
                    <td className="text-right w-24 text-slate-400">{brl(c.costBrl)}</td>
                  </tr>
                ))}
              </tbody></table>
              {(() => {
                const mk = (d.categories || []).filter((c: any) => c.category === 'MARKETING').reduce((s: number, c: any) => s + c.costBrl, 0);
                const all = (d.categories || []).reduce((s: number, c: any) => s + c.costBrl, 0);
                return all > 0 && mk / all > 0.5 ? <p className="mt-1 text-amber-700">Mensagens de <b>Marketing</b> (templates de follow-up, remarketing, boas-vindas) respondem por {Math.round((mk / all) * 100)}% do gasto — são as mais caras por mensagem.</p> : null;
              })()}
            </>
          )}
        </div>
      )}
      {b.provider === 'VOYAGE' && b.auto && (
        <p>{b.auto.noData ? 'Sem uso registrado nesse mês (o registro começa agora).' : <>{n0(d.tokens || 0)} tokens em {n0(d.calls || 0)} chamadas · estimativa a US$ {d.usdPorMilhao}/milhão. A Voyage dá uma franquia grátis grande por conta: o custo real costuma ser zero.</>}</p>
      )}
      {b.manual.length > 0 && (
        <div>
          {b.manual.map((m) => (
            <div key={m.id} className="flex items-center gap-2 py-0.5">
              <span className="flex-1 truncate">{m.label}{m.campaign ? ` · ${m.campaign}` : ''}{m.recurring ? ' · todo mês' : ''}{m.kind === 'ACTUAL' ? ' · fatura real' : ''}</span>
              <span>{m.currency === 'USD' ? `${usd(m.amount)} → ` : ''}<b>{brl(m.brl)}</b></span>
              <button onClick={() => onEdit(m)} className="p-0.5 text-slate-400 hover:text-af-mid"><Pencil size={12} /></button>
              <button onClick={() => onDelete(m)} className="p-0.5 text-slate-400 hover:text-red-600"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}
      {!b.auto && !b.manual.length && <p>Nada lançado.</p>}
    </div>
  );
}
