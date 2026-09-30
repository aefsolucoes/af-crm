'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarRange } from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Relatório mensal (Fabio 30/09): quantos clientes entraram, foram aprovados
 * na pré-análise, mandaram a documentação e foram perdidos. Só cards num
 * setor — a Caixa de Entrada (corretores etc.) fica de fora.
 */
interface Row { month: string; label: string; entered: number; approved: number; docsSent: number; lost: number }

export function MonthlyReport() {
  const [mode, setMode] = useState<'event' | 'cohort'>('event');
  const [departmentId, setDepartmentId] = useState('');
  const { data: departments = [] } = useQuery<{ id: string; name: string }[]>({
    queryKey: ['departments'],
    queryFn: async () => (await api.get('/api/departments')).data,
  });
  const { data, isLoading } = useQuery<{ rows: Row[] }>({
    queryKey: ['reports-monthly', mode, departmentId],
    queryFn: async () => (await api.get('/api/reports/monthly', { params: { months: 6, mode, ...(departmentId ? { departmentId } : {}) } })).data,
  });
  const pct = (a: number, b: number) => (b > 0 ? `${String(Math.round((a / b) * 1000) / 10).replace('.', ',')}%` : '—');

  return (
    <div className="bg-white rounded-xl border border-af-border p-5 shadow-sm">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <CalendarRange size={16} className="text-af-mid" />
        <h3 className="text-sm font-semibold text-slate-700 mr-auto">Relatório mensal</h3>
        <select
          value={departmentId}
          onChange={(e) => setDepartmentId(e.target.value)}
          className="text-xs border border-af-border rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-af-accent"
        >
          <option value="">Todos os setores</option>
          {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        <div className="flex rounded-lg border border-af-border overflow-hidden text-xs">
          <button
            onClick={() => setMode('event')}
            className={cn('px-2.5 py-1.5', mode === 'event' ? 'bg-af-mid text-white' : 'bg-white text-slate-600 hover:bg-slate-50')}
            title="Cada coisa contada no mês em que aconteceu"
          >
            No mês em que aconteceu
          </button>
          <button
            onClick={() => setMode('cohort')}
            className={cn('px-2.5 py-1.5 border-l border-af-border', mode === 'cohort' ? 'bg-af-mid text-white' : 'bg-white text-slate-600 hover:bg-slate-50')}
            title="Dos clientes que entraram no mês, quantos já foram aprovados, mandaram a documentação ou foram perdidos"
          >
            Por mês de entrada
          </button>
        </div>
      </div>

      {isLoading ? <Skeleton className="h-48" /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-af-border">
                <th className="py-2 pr-3 font-medium">Mês</th>
                <th className="py-2 px-3 font-medium text-right">Entraram</th>
                <th className="py-2 px-3 font-medium text-right">Aprovados</th>
                <th className="py-2 px-3 font-medium text-right">Mandaram a documentação</th>
                <th className="py-2 px-3 font-medium text-right">Perdidos</th>
                <th className="py-2 pl-3 font-medium text-right" title="Mandaram a documentação ÷ entraram">Conversão</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows || []).map((r) => (
                <tr key={r.month} className="border-b border-af-border/60 last:border-b-0">
                  <td className="py-2 pr-3 text-slate-700 capitalize">{r.label}</td>
                  <td className="py-2 px-3 text-right font-semibold text-slate-800">{r.entered}</td>
                  <td className="py-2 px-3 text-right text-slate-700">{r.approved}</td>
                  <td className="py-2 px-3 text-right text-emerald-700 font-medium">{r.docsSent}</td>
                  <td className="py-2 px-3 text-right text-red-600">{r.lost}</td>
                  <td className="py-2 pl-3 text-right text-slate-600">{pct(r.docsSent, r.entered)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-400 mt-3">
        {mode === 'event'
          ? 'Cada número no mês em que aconteceu. '
          : 'Dos clientes que entraram em cada mês, quantos já foram aprovados, mandaram a documentação ou foram perdidos (até hoje). '}
        Aprovado = foi pra "Aprovado Pré-Análise"/"Aguardando Documentação"; documentação = foi pra "Fechado"/contratação.
        A Caixa de Entrada (corretores etc.) não entra. Aprovados, documentação e perdidos só existem no histórico a partir de 31/08/2026.
      </p>
    </div>
  );
}
