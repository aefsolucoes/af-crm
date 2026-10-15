'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Landmark, Users, BadgeCheck, Percent, Timer, X, MessageSquare } from 'lucide-react';
import api from '@/lib/api';
import { cn, formatCurrency } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Análises de crédito (Fabio 14/10): aprovados por banco, taxa de aprovação e tempo até o resultado, tirados da aba
 * "Análise de Crédito" (extensões do Chrome). Conta uma vez cada cliente×banco (resultado mais recente já decidido).
 * "Aprovada" inclui a aprovação condicional (o banco pede documentos). Teste/modo teste não entra.
 */
interface BankStats {
  analyzed: number; approved: number; conditional: number; rejected: number; pending: number; failed: number;
  decided: number; approvalRate: number | null; medianMinutes: number | null; avgMinutes: number | null;
}
interface Person { leadId: string; name: string; status: string; approvedValue: number | null; termMonths: number | null; rate: string | null; holder: string | null; at: string }
interface MetricsRow {
  month: string; label: string; clientsAnalyzed: number; clientsApproved: number; clientsRejected: number; clientsPending: number;
  approvalRate: number | null; medianMinutes: number | null; banks: Record<string, BankStats>;
  /** Clientes por banco e categoria (pra abrir a lista) e quem aprovou em algum banco. */
  people?: Record<string, { approved: Person[]; rejected: Person[]; pending: Person[] }>;
  approvedAny?: { leadId: string; name: string; banks: { bank: string; status: string; approvedValue: number | null }[]; at: string }[];
}
interface ListItem { leadId: string; name: string; detail: string; at: string }

const BANKS: { key: string; label: string }[] = [
  { key: 'CREDIMORAR', label: 'Santander (Credimorar)' },
  { key: 'CREDITAS', label: 'Creditas' },
  { key: 'INTER', label: 'Banco Inter' },
];

function fmtMin(m: number | null): string {
  if (m === null) return '—';
  if (m < 1) return '< 1 min';
  if (m < 90) return `${Math.round(m)} min`;
  if (m < 60 * 36) return `${(m / 60).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`;
  return `${(m / 1440).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dias`;
}
const pct = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`);

const shortBank = (k: string) => ({ CREDIMORAR: 'Santander', CREDITAS: 'Creditas', INTER: 'Inter' } as Record<string, string>)[k] || k;
const fmtDay = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function CreditMetricsPanel() {
  const [month, setMonth] = useState('');
  const [lista, setLista] = useState<{ title: string; items: ListItem[] } | null>(null);
  const [departmentId, setDepartmentId] = useState('');
  const { data: departments = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['departments'],
    queryFn: async () => (await api.get('/api/departments')).data,
  });
  const { data, isLoading } = useQuery<{ rows: MetricsRow[] }>({
    queryKey: ['credit-metrics', departmentId],
    queryFn: async () => (await api.get('/api/credit-analysis/metrics', { params: { months: 6, ...(departmentId ? { departmentId } : {}) } })).data,
    refetchInterval: 60_000,
  });
  const rows = data?.rows || [];
  useEffect(() => { if (!month && rows.length) setMonth(rows[0].month); }, [rows, month]);
  const row = rows.find((r) => r.month === month) || rows[0];
  const empty = !row || row.clientsAnalyzed === 0;

  function abrirBanco(bankKey: string, cat: 'approved' | 'rejected' | 'pending', title: string) {
    const items = (row?.people?.[bankKey]?.[cat] || []).map((p) => ({
      leadId: p.leadId, name: p.name || 'Sem nome', at: p.at,
      detail: [
        cat === 'approved' ? (p.status === 'CONDITIONAL' ? 'aprovado condicional' : 'aprovado') : '',
        p.approvedValue ? formatCurrency(p.approvedValue) : '', p.termMonths ? `${p.termMonths} meses` : '', p.rate || '',
        p.holder && p.holder.trim().toLowerCase() !== (p.name || '').trim().toLowerCase() ? `no nome de ${p.holder}` : '',
      ].filter(Boolean).join(' · '),
    }));
    setLista({ title: `${title} — ${shortBank(bankKey)} (${row?.label || ''})`, items });
  }
  function abrirAprovadosAlgumBanco() {
    const items = (row?.approvedAny || []).map((a) => ({
      leadId: a.leadId, name: a.name || 'Sem nome', at: a.at,
      detail: a.banks.map((b) => `${shortBank(b.bank)}${b.status === 'CONDITIONAL' ? ' (condicional)' : ''}${b.approvedValue ? ` ${formatCurrency(b.approvedValue)}` : ''}`).join(' · '),
    }));
    setLista({ title: `Aprovados em algum banco (${row?.label || ''})`, items });
  }

  const kpis = [
    { label: 'Clientes analisados', value: row ? String(row.clientsAnalyzed) : '0', hint: 'em pelo menos um banco', icon: Users, tone: 'text-sky-700 bg-sky-50' },
    { label: 'Aprovados em algum banco', value: row ? String(row.clientsApproved) : '0', hint: row && row.clientsPending ? `${row.clientsPending} ainda aguardando resultado` : 'inclui aprovação condicional', icon: BadgeCheck, tone: 'text-emerald-700 bg-emerald-50' },
    { label: 'Taxa de aprovação', value: pct(row?.approvalRate ?? null), hint: row ? `${row.clientsApproved} aprovados · ${row.clientsRejected} reprovados em todos` : '', icon: Percent, tone: 'text-violet-700 bg-violet-50' },
    { label: 'Tempo até o resultado', value: fmtMin(row?.medianMinutes ?? null), hint: 'mediana, da 1ª solicitação ao resultado', icon: Timer, tone: 'text-amber-700 bg-amber-50' },
  ];

  return (
    <div className="bg-white rounded-xl border border-af-border p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Landmark size={16} className="text-af-mid" />
        <h3 className="text-sm font-semibold text-slate-700 mr-auto">Análises de crédito</h3>
        <select
          value={row?.month || ''}
          onChange={(e) => setMonth(e.target.value)}
          className="text-xs border border-af-border rounded-lg px-2 py-1.5 bg-white text-slate-700 capitalize focus:outline-none focus:ring-2 focus:ring-af-accent"
        >
          {rows.map((r) => <option key={r.month} value={r.month}>{r.label}</option>)}
        </select>
        <select
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
          className="text-xs border border-af-border rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-af-accent"
        >
          <option value="">Todos os setores</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <Link href="/analise-credito" className="text-xs text-af-mid hover:underline">Abrir análises</Link>
      </div>

      {isLoading ? <Skeleton className="h-28" /> : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {kpis.map((k) => {
              const Icon = k.icon;
              return (
                <div key={k.label} onClick={k.label === 'Aprovados em algum banco' && row?.clientsApproved ? abrirAprovadosAlgumBanco : undefined} className={cn('rounded-xl border border-af-border p-4', k.label === 'Aprovados em algum banco' && row?.clientsApproved ? 'cursor-pointer hover:bg-slate-50' : '')} title={k.label === 'Aprovados em algum banco' && row?.clientsApproved ? 'Ver a lista de clientes' : undefined}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-slate-500">{k.label}</span>
                    <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center', k.tone)}><Icon size={15} /></span>
                  </div>
                  <div className="text-3xl font-extrabold text-slate-800 mt-1 leading-tight">{k.value}</div>
                  <div className="text-[11px] text-slate-400 mt-1 leading-snug">{k.hint}</div>
                </div>
              );
            })}
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm min-w-[620px]">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-af-border">
                  <th className="py-2 pr-3 font-medium">Banco</th>
                  <th className="py-2 px-3 font-medium text-right">Analisadas</th>
                  <th className="py-2 px-3 font-medium text-right">Aprovadas</th>
                  <th className="py-2 px-3 font-medium text-right">Reprovadas</th>
                  <th className="py-2 px-3 font-medium text-right">Aguardando</th>
                  <th className="py-2 px-3 font-medium text-right">Taxa de aprovação</th>
                  <th className="py-2 pl-3 font-medium text-right">Tempo até o resultado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-af-border">
                {BANKS.map((b) => {
                  const s = row?.banks?.[b.key];
                  return (
                    <tr key={b.key}>
                      <td className="py-2.5 pr-3 font-medium text-slate-700">{b.label}</td>
                      <td className="py-2.5 px-3 text-right text-slate-600">{s?.analyzed ?? 0}</td>
                      <td className="py-2.5 px-3 text-right text-emerald-600 font-medium">
                        {s?.approved ? <button onClick={() => abrirBanco(b.key, 'approved', 'Aprovaram')} className="underline decoration-dotted underline-offset-2 hover:text-emerald-700" title="Ver os clientes">{s.approved}</button> : (s?.approved ?? 0)}
                        {s && s.conditional > 0 && <span className="block text-[10px] font-normal text-teal-700">{s.conditional} condicional{s.conditional === 1 ? '' : 'is'}</span>}
                      </td>
                      <td className="py-2.5 px-3 text-right text-red-500">{s?.rejected ? <button onClick={() => abrirBanco(b.key, 'rejected', 'Reprovaram')} className="underline decoration-dotted underline-offset-2" title="Ver os clientes">{s.rejected}</button> : (s?.rejected ?? 0)}</td>
                      <td className="py-2.5 px-3 text-right text-slate-500">{s?.pending ? <button onClick={() => abrirBanco(b.key, 'pending', 'Aguardando')} className="underline decoration-dotted underline-offset-2" title="Ver os clientes">{s.pending}</button> : (s?.pending ?? 0)}</td>
                      <td className="py-2.5 px-3 text-right text-slate-700 font-medium">{pct(s?.approvalRate ?? null)}</td>
                      <td className="py-2.5 pl-3 text-right text-slate-600">
                        {fmtMin(s?.medianMinutes ?? null)}
                        {s && s.avgMinutes !== null && <span className="block text-[10px] text-slate-400">média {fmtMin(s.avgMinutes)}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {empty && <p className="text-xs text-slate-400 mt-3">Ainda sem análises neste mês. Os números aparecem conforme as extensões (Santander, Creditas, Inter) devolvem os resultados.</p>}
        </>
      )}

      {lista && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => setLista(null)}>
          <div className="w-[560px] max-w-full max-h-[80vh] flex flex-col rounded-2xl bg-white shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-4 py-3 border-b border-af-border">
              <h4 className="text-sm font-semibold text-slate-800 mr-auto">{lista.title} · {lista.items.length}</h4>
              <button onClick={() => setLista(null)} className="p-1 rounded-md hover:bg-slate-100 text-slate-500" aria-label="Fechar"><X size={16} /></button>
            </div>
            <ul className="overflow-y-auto divide-y divide-af-border">
              {lista.items.length === 0 && <li className="px-4 py-6 text-sm text-slate-400 text-center">Nenhum cliente.</li>}
              {lista.items.map((it) => (
                <li key={`${it.leadId}-${it.at}`} className="px-4 py-2.5 flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-slate-800 truncate">{it.name}</p>
                    {it.detail && <p className="text-[11px] text-slate-500">{it.detail}</p>}
                  </div>
                  <span className="text-[11px] text-slate-400 flex-shrink-0">{fmtDay(it.at)}</span>
                  <Link href={`/inbox?leadId=${it.leadId}`} className="text-af-mid hover:underline flex-shrink-0" title="Abrir a conversa"><MessageSquare size={14} /></Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-400 mt-3">
        Conta uma vez cada cliente em cada banco (o resultado mais recente já decidido). Aprovada inclui a aprovação condicional (o banco pede documentos).
        Taxa de aprovação = aprovadas ÷ (aprovadas + reprovadas); quem ainda aguarda resultado fica de fora. Tempo = da 1ª solicitação ao resultado.
        Só vale a partir de 14/10/2026, quando as análises passaram a ser registradas no CRM; modo teste não conta.
      </p>
    </div>
  );
}
