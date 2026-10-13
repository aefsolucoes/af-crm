'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, UserPlus, BadgeCheck, ThumbsDown, XCircle, ChevronDown } from 'lucide-react';
import api from '@/lib/api';
import { cn, formatCurrency } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Painel do mês (Fabio 13/10): num mês escolhido, quantos leads ENTRARAM,
 * quantos clientes foram APROVADOS (chegaram em "Aguardando Documentação"),
 * REPROVADOS (botão "Reprovado" — passaram pela Pré-Análise e os bancos
 * reprovaram) e PERDIDOS (os reprovados também são Perdidos). Clicar num
 * cartão mostra os clientes e os valores. Usa /api/reports/monthly (modo
 * "no mês em que aconteceu"); a Caixa de Entrada não entra.
 */
interface Person { id: string; name: string; value: number }
interface Row {
  month: string; label: string; entered: number; approved: number; lost: number; rejected: number; lostRejected: number;
  people?: { entered: Person[]; approved: Person[]; lost: Person[]; rejected: Person[] };
}
type Key = 'entered' | 'approved' | 'rejected' | 'lost';

const CARDS: { key: Key; label: string; hint: string; icon: typeof UserPlus; tone: string; ring: string }[] = [
  { key: 'entered', label: 'Entraram', hint: 'cards criados no mês', icon: UserPlus, tone: 'text-sky-700 bg-sky-50', ring: 'ring-sky-300' },
  { key: 'approved', label: 'Aprovados', hint: 'chegaram em Aguardando Documentação', icon: BadgeCheck, tone: 'text-emerald-700 bg-emerald-50', ring: 'ring-emerald-300' },
  { key: 'rejected', label: 'Reprovados', hint: 'passaram pela pré-análise e os bancos reprovaram', icon: ThumbsDown, tone: 'text-orange-700 bg-orange-50', ring: 'ring-orange-300' },
  { key: 'lost', label: 'Perdidos', hint: 'marcados como Perdido no mês', icon: XCircle, tone: 'text-red-700 bg-red-50', ring: 'ring-red-300' },
];

export function MonthPanel() {
  const [month, setMonth] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [open, setOpen] = useState<Key | null>(null);
  const { data: departments = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['departments'],
    queryFn: async () => (await api.get('/api/departments')).data,
  });
  const { data, isLoading } = useQuery<{ rows: Row[] }>({
    queryKey: ['month-panel', departmentId],
    queryFn: async () => (await api.get('/api/reports/monthly', { params: { months: 6, mode: 'event', ...(departmentId ? { departmentId } : {}) } })).data,
  });
  const rows = data?.rows || [];
  useEffect(() => { if (!month && rows.length) setMonth(rows[0].month); }, [rows, month]);
  const row = rows.find((r) => r.month === month) || rows[0];
  const prev = useMemo(() => { const i = rows.findIndex((r) => r.month === row?.month); return i >= 0 ? rows[i + 1] : undefined; }, [rows, row]);

  const count = (r: Row | undefined, k: Key) => (r ? r[k] : 0);
  const people = open && row?.people ? row.people[open] : [];
  const total = people.reduce((s, p) => s + (p.value || 0), 0);
  const openCard = CARDS.find((c) => c.key === open);

  return (
    <div className="bg-white rounded-xl border border-af-border p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <CalendarDays size={16} className="text-af-mid" />
        <h3 className="text-sm font-semibold text-slate-700 mr-auto">Painel do mês</h3>
        <select
          value={row?.month || ''}
          onChange={(e) => { setMonth(e.target.value); setOpen(null); }}
          className="text-xs border border-af-border rounded-lg px-2 py-1.5 bg-white text-slate-700 capitalize focus:outline-none focus:ring-2 focus:ring-af-accent"
        >
          {rows.map((r) => <option key={r.month} value={r.month}>{r.label}</option>)}
        </select>
        <select
          value={departmentId}
          onChange={(e) => { setDepartmentId(e.target.value); setOpen(null); }}
          className="text-xs border border-af-border rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-af-accent"
        >
          <option value="">Todos os setores</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </div>

      {isLoading ? <Skeleton className="h-28" /> : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {CARDS.map((c) => {
            const n = count(row, c.key);
            const before = prev ? count(prev, c.key) : null;
            const diff = before !== null ? n - before : null;
            const Icon = c.icon;
            const clickable = n > 0 && !!row?.people;
            return (
              <button
                key={c.key}
                type="button"
                disabled={!clickable}
                onClick={() => setOpen(open === c.key ? null : c.key)}
                className={cn(
                  'text-left rounded-xl border border-af-border p-4 transition-all',
                  clickable ? 'hover:shadow-md cursor-pointer' : 'cursor-default',
                  open === c.key && `ring-2 ${c.ring}`,
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500">{c.label}</span>
                  <span className={cn('w-7 h-7 rounded-lg flex items-center justify-center', c.tone)}><Icon size={15} /></span>
                </div>
                <div className="text-3xl font-extrabold text-slate-800 mt-1 leading-tight">{n}</div>
                <div className="text-[11px] text-slate-400 mt-1 leading-snug">
                  {c.key === 'lost' && row && row.lostRejected > 0 ? `inclui ${row.lostRejected} reprovado${row.lostRejected === 1 ? '' : 's'}` : c.hint}
                </div>
                <div className="flex items-center justify-between mt-2 text-[11px]">
                  {diff !== null ? (
                    <span className={cn('font-medium', diff === 0 ? 'text-slate-400' : (c.key === 'lost' || c.key === 'rejected') ? (diff > 0 ? 'text-red-500' : 'text-emerald-600') : (diff > 0 ? 'text-emerald-600' : 'text-red-500'))}>
                      {diff === 0 ? 'igual ao mês anterior' : `${diff > 0 ? '+' : ''}${diff} vs. mês anterior`}
                    </span>
                  ) : <span />}
                  {clickable && <span className="text-slate-400 flex items-center gap-0.5">ver <ChevronDown size={11} className={cn('transition-transform', open === c.key && 'rotate-180')} /></span>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {open && openCard && (
        <div className="mt-3 border border-af-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2 bg-slate-50 border-b border-af-border text-xs text-slate-500">
            <span><strong className="text-slate-700">{openCard.label}</strong> — {people.length} cliente{people.length === 1 ? '' : 's'}</span>
            <span className="font-semibold text-slate-700">Total {formatCurrency(total)}</span>
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-af-border/60">
            {people.map((p) => (
              <Link key={p.id} href={`/inbox?leadId=${p.id}`} className="flex items-center justify-between gap-3 px-4 py-2 text-sm hover:bg-slate-50">
                <span className="truncate text-slate-700">{p.name}</span>
                <span className="flex-shrink-0 text-slate-500 text-xs">{p.value ? formatCurrency(p.value) : '—'}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <p className="text-[11px] text-slate-400 mt-3">
        Cada número no mês em que aconteceu. Entraram = card criado no mês. Aprovados = chegaram em &quot;Aguardando Documentação&quot;.
        Reprovados = marcados com o botão &quot;Reprovado&quot; (os dos meses anteriores a 13/10 são uma <strong>estimativa</strong> feita pelo motivo da perda) — eles também contam em Perdidos.
        Valores: valor do crédito do card (sem ele, valor da venda). A Caixa de Entrada (corretores etc.) não entra. Histórico de aprovados e perdidos só existe a partir de 31/08/2026.
      </p>
    </div>
  );
}
