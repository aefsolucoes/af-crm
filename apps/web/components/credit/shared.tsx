import { Star } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
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
  CONDITIONAL: { label: 'Aprovado condicional', cls: 'bg-teal-50 text-teal-700' },
  REJECTED: { label: 'Reprovado', cls: 'bg-red-50 text-red-500' },
  FAILED: { label: 'Falhou', cls: 'bg-orange-50 text-orange-600' },
  CHECK: { label: 'Conferir', cls: 'bg-amber-50 text-amber-600' },
  INCOMPLETE: { label: 'Incompleto', cls: 'bg-amber-50 text-amber-600' },
  TEST: { label: 'Teste', cls: 'bg-slate-100 text-slate-500' },
};
export const MANUAL_STATUS = ['SENT', 'APPROVED', 'CONDITIONAL', 'REJECTED', 'CHECK', 'FAILED'];

export interface Analysis {
  id: string; bank: Bank; status: string; kind?: string; detail: string | null; dryRun: boolean; source: string; chosen: boolean;
  holderName?: string | null; proposalNumber: string | null; approvedValue: number | null; netValue?: number | null; termMonths: number | null; rate: string | null; indexer: string | null;
  firstInstallment: number | null; lastInstallment: number | null; conditions: string | null;
  requestedAt: string; finishedAt: string | null; updatedAt: string; createdAt: string;
}
export interface OverrideData {
  valorImovel?: string; valorEmprestimo?: string; renda?: string; prazo?: string; rendaParticipante?: string; inverter?: boolean;
}
/** 00000000000 / 000.000.000-00 → 000.000.000-00 (outro formato fica como está; vazio = ''). */
export function fmtCpf(v?: string | null): string {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 11 ? d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4') : String(v || '').trim();
}

export interface BoardLead {
  id: string; name: string; stage: string; status: string;
  requested: { creditValue: number; propertyValue: number; term: string | null };
  card: { name1: string; name2: string; cpf1?: string; cpf2?: string; income1: string; income2: string; propertyValue: string; creditValue: string; term: string };
  overrides: Partial<Record<Bank, OverrideData>>;
  inPre: boolean; autoPaused?: boolean; preAnaliseAt?: string | null; ran: boolean; lastRunAt: string | null;
  latest: Partial<Record<Bank, Analysis>>; history: Analysis[]; chosenId: string | null;
  /** Última análise de cada banco por participante (o 2º, rodado no nome dele, não esconde o 1º). */
  latestP1?: Partial<Record<Bank, Analysis>>; latestP2?: Partial<Record<Bank, Analysis>>;
}

/** Resumo curto dos ajustes de um banco, pra mostrar na linha. */
export function overrideSummary(o?: OverrideData): string {
  if (!o) return '';
  return [
    o.valorImovel ? `imóvel ${o.valorImovel}` : '', o.valorEmprestimo ? `financ. ${o.valorEmprestimo}` : '', o.renda ? `renda ${o.renda}` : '',
    o.rendaParticipante ? `renda 2º ${o.rendaParticipante}` : '', o.prazo ? `prazo ${o.prazo}` : '', o.inverter ? 'participantes invertidos' : '',
  ].filter(Boolean).join(' · ');
}

export interface LeadAnalyses {
  eligible: boolean;
  latest: Partial<Record<Bank, Analysis>>;
  latestP1?: Partial<Record<Bank, Analysis>>; latestP2?: Partial<Record<Bank, Analysis>>;
  history: Analysis[];
  chosenId: string | null;
  participants?: { name1: string; name2: string; inverted: boolean };
  extensions: Record<Bank, { online: boolean; lastSeenAt: string | null; extId?: string | null }>;
}

/** Análises de crédito de UM card (compartilhado entre o bloco do card e a barra lateral). */
export function useLeadAnalyses(leadId: string) {
  return useQuery<LeadAnalyses>({
    queryKey: ['credit-lead', leadId],
    queryFn: async () => (await api.get(`/api/credit-analysis/lead/${leadId}`)).data,
    refetchInterval: 30_000,
    retry: false,
  });
}

/** Campos soltos de Financiamento que a "carta de aprovação" (análises) já mostra — somem do card quando o cliente tem análise. */
export const FIELDS_FROM_ANALYSES = ['instituicao', 'num_proposta', 'taxa_efetiva', 'indexador', 'primeira_parcela', 'ultima_parcela'];

export function ago(d: string | null | undefined): string {
  if (!d) return '';
  const min = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 60 * 24) return `há ${Math.round(min / 60)} h`;
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export const isDesqualificado = (detail?: string | null) => /N[ÃA]O RODEI|n[aã]o conformidade|recusou antes de consultar/i.test(detail || '');

export function Badge({ a }: { a?: Analysis }) {
  if (!a) return <span className="text-xs text-slate-300">—</span>;
  const baseStatus = STATUS[a.status] || { label: a.status, cls: 'bg-slate-100 text-slate-500' };
  // Falha por REGRA do banco/imóvel (mínimo do imóvel, terreno, saldo devedor…) aparece como "Desqualificado" (vale como reprovado), não como "Falhou" (Fabio 14/10).
  const desq = a.status === 'FAILED' && isDesqualificado(a.detail);
  // Proposta já enviada ao banco e o resultado final ainda não saiu (a conferência fica lendo o portal): "Em análise" — não "Rodando" nem "Enviada" (Fabio 14/10).
  const emAnalise = a.status === 'SENT' || (a.kind === 'CHECK' && (a.status === 'REQUESTED' || a.status === 'RUNNING'));
  const s = a.status === 'APPROVED' && /aprovad[oa] a menor/i.test(a.detail || '') ? { ...baseStatus, label: 'Aprovado a menor' } : desq ? { label: 'Desqualificado', cls: 'bg-red-50 text-red-500' } : emAnalise ? { label: 'Em análise', cls: 'bg-indigo-50 text-indigo-600' } : baseStatus;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1">
        <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${s.cls}`}>{s.label}</span>
        {a.chosen && <Star size={13} className="text-amber-500 fill-amber-400" />}
      </div>
      <div className="text-[11px] text-slate-400">
        {(a.status === 'APPROVED' || a.status === 'CONDITIONAL') && a.approvedValue ? <span className="text-slate-600 font-medium">{formatCurrency(a.approvedValue)} · </span> : null}
        {ago(a.updatedAt)}
      </div>
    </div>
  );
}

