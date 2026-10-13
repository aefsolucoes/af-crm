import { Star } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';

/* Pedaços compartilhados entre a aba Análise de Crédito e o bloco de análises dentro do card. */

export type Bank = 'CREDIMORAR' | 'CREDITAS' | 'INTER';
export const BANKS: { key: Bank; label: string; short: string }[] = [
  { key: 'CREDIMORAR', label: 'Santander (Credimorar)', short: 'Santander' },
  { key: 'CREDITAS', label: 'Creditas', short: 'Creditas' },
  { key: 'INTER', label: 'Banco Inter', short: 'Inter' },
];

export const STATUS: Record<string, { label: string; cls: string }> = {
  REQUESTED: { label: 'Na fila', cls: 'bg-slate-100 text-slate-600' },
  RUNNING: { label: 'Rodando', cls: 'bg-blue-50 text-blue-600' },
  SENT: { label: 'Enviada', cls: 'bg-indigo-50 text-indigo-600' },
  APPROVED: { label: 'Aprovado', cls: 'bg-emerald-50 text-emerald-600' },
  REJECTED: { label: 'Reprovado', cls: 'bg-red-50 text-red-500' },
  FAILED: { label: 'Falhou', cls: 'bg-orange-50 text-orange-600' },
  CHECK: { label: 'Conferir', cls: 'bg-amber-50 text-amber-600' },
  INCOMPLETE: { label: 'Incompleto', cls: 'bg-amber-50 text-amber-600' },
  TEST: { label: 'Teste', cls: 'bg-slate-100 text-slate-500' },
};
export const MANUAL_STATUS = ['SENT', 'APPROVED', 'REJECTED', 'CHECK', 'FAILED'];

export interface Analysis {
  id: string; bank: Bank; status: string; detail: string | null; dryRun: boolean; source: string; chosen: boolean;
  proposalNumber: string | null; approvedValue: number | null; termMonths: number | null; rate: string | null; indexer: string | null;
  firstInstallment: number | null; lastInstallment: number | null; conditions: string | null;
  requestedAt: string; finishedAt: string | null; updatedAt: string; createdAt: string;
}
export interface BoardLead {
  id: string; name: string; stage: string; status: string;
  requested: { creditValue: number; propertyValue: number; term: string | null };
  latest: Partial<Record<Bank, Analysis>>; history: Analysis[]; chosenId: string | null;
}

export function ago(d: string | null | undefined): string {
  if (!d) return '';
  const min = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 60 * 24) return `há ${Math.round(min / 60)} h`;
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function Badge({ a }: { a?: Analysis }) {
  if (!a) return <span className="text-xs text-slate-300">—</span>;
  const s = STATUS[a.status] || { label: a.status, cls: 'bg-slate-100 text-slate-500' };
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1">
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${s.cls}`}>{s.label}</span>
        {a.chosen && <Star size={13} className="text-amber-500 fill-amber-400" />}
      </div>
      <div className="text-[11px] text-slate-400">
        {a.status === 'APPROVED' && a.approvedValue ? <span className="text-slate-600 font-medium">{formatCurrency(a.approvedValue)} · </span> : null}
        {ago(a.updatedAt)}
      </div>
    </div>
  );
}

