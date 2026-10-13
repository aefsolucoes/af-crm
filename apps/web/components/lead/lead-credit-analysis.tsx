'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { ExternalLink, Landmark, Play, Star } from 'lucide-react';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { toast } from '@/components/ui/toast';
import { pingExtensions } from '@/lib/credit-extensions';
import { BANKS, Badge, STATUS, type Analysis, type Bank } from '@/components/credit/shared';

/* Bloco "Análises de crédito" dentro do card (aba Financiamento). Mostra o último resultado de
 * cada banco, dispara nova análise e escolhe a proposta. Ver a aba /analise-credito. */

interface LeadAnalyses {
  eligible: boolean;
  latest: Partial<Record<Bank, Analysis>>;
  history: Analysis[];
  chosenId: string | null;
  extensions: Record<Bank, { online: boolean; lastSeenAt: string | null; extId?: string | null }>;
}

export function LeadCreditAnalysis({ leadId, onChanged }: { leadId: string; onChanged?: () => void }) {
  const queryClient = useQueryClient();
  const { data } = useQuery<LeadAnalyses>({
    queryKey: ['credit-lead', leadId],
    queryFn: async () => (await api.get(`/api/credit-analysis/lead/${leadId}`)).data,
    refetchInterval: 30_000,
    retry: false,
  });
  const [running, setRunning] = useState(false);
  const [banks, setBanks] = useState<Bank[]>(['CREDIMORAR', 'CREDITAS', 'INTER']);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const socket = getSocket();
    const on = () => queryClient.invalidateQueries({ queryKey: ['credit-lead', leadId] });
    socket.on('credit_analysis_updated', on);
    return () => { socket.off('credit_analysis_updated', on); };
  }, [leadId, queryClient]);

  if (!data || (!data.eligible && data.history.length === 0)) return null;

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['credit-lead', leadId] });
    queryClient.invalidateQueries({ queryKey: ['credit-board'] });
  };
  const sentBefore = banks.filter((b) => {
    const a = data.latest[b];
    return a && ['SENT', 'APPROVED', 'CONDITIONAL', 'REJECTED', 'CHECK'].includes(a.status);
  });
  const offline = banks.filter((b) => !data.extensions?.[b]?.online);

  async function run() {
    setBusy(true);
    try {
      const { data: r } = await api.post('/api/credit-analysis/requests', { leadIds: [leadId], banks });
      pingExtensions(data?.extensions, banks);
      toast(r.created ? `${r.created} análise(s) na fila` : 'Já estava rodando', 'success');
      setRunning(false);
      refresh();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir a análise', 'error');
    } finally { setBusy(false); }
  }

  async function choose(a: Analysis) {
    const bank = BANKS.find((b) => b.key === a.bank)?.short;
    if (!window.confirm(`Escolher a proposta ${bank}? Isso preenche os campos do Financiamento deste card com ela.`)) return;
    try {
      await api.post(`/api/credit-analysis/${a.id}/choose`);
      toast('Proposta escolhida — Financiamento preenchido', 'success');
      refresh();
      onChanged?.();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao escolher', 'error');
    }
  }

  return (
    <div className="mb-3 rounded-lg border border-af-border bg-slate-50/60 p-3">
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600"><Landmark size={12} /> Análises de crédito</span>
        <Link href={`/analise-credito?leadId=${leadId}`} className="flex items-center gap-1 text-[11px] text-af-mid hover:underline" title="Abrir na aba Análise de Crédito (resultado manual e histórico)">
          Abrir aba <ExternalLink size={10} />
        </Link>
      </div>

      <div className="space-y-2">
        {BANKS.map((b) => {
          const a = data.latest[b.key];
          const nums = a?.status === 'APPROVED' || a?.status === 'CONDITIONAL'
            ? [a.termMonths ? `${a.termMonths} meses` : '', a.rate || ''].filter(Boolean).join(' · ')
            : '';
          return (
            <div key={b.key} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-600 font-medium">{b.short}</span>
                <div className="flex items-center gap-1.5">
                  <Badge a={a} />
                </div>
              </div>
              {nums && <div className="text-[11px] text-slate-500 mt-0.5">{nums}</div>}
              {a && a.status !== 'APPROVED' && a.detail && ['CONDITIONAL', 'REJECTED', 'FAILED', 'CHECK', 'INCOMPLETE'].includes(a.status) && (
                <div className="text-[11px] text-slate-400 mt-0.5 line-clamp-2" title={a.detail}>{a.detail}</div>
              )}
              {(a?.status === 'APPROVED' || a?.status === 'CONDITIONAL') && (
                <div className="mt-1">
                  {a.chosen
                    ? <span className="flex items-center gap-1 text-[11px] text-amber-600"><Star size={10} className="fill-amber-400" /> Proposta escolhida</span>
                    : <button onClick={() => choose(a)} className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-af-mid text-white hover:bg-af-dark"><Star size={10} /> Escolher esta proposta</button>}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 pt-2 border-t border-af-border">
        {!running ? (
          <button onClick={() => setRunning(true)} className="flex items-center gap-1 text-xs text-af-mid hover:text-af-dark"><Play size={11} /> Rodar análise</button>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {BANKS.map((b) => (
                <label key={b.key} className="flex items-center gap-1 text-xs text-slate-600 cursor-pointer">
                  <input type="checkbox" checked={banks.includes(b.key)} onChange={() => setBanks((p) => p.includes(b.key) ? p.filter((x) => x !== b.key) : [...p, b.key])} />
                  {b.short}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-slate-400">A extensão envia a proposta de verdade ao banco.</p>
            {sentBefore.length > 0 && (
              <p className="text-[11px] text-amber-600">Já tem análise em {sentBefore.map((b) => `${BANKS.find((x) => x.key === b)!.short} (${STATUS[data.latest[b]!.status].label.toLowerCase()})`).join(', ')} — rodar de novo pode duplicar a proposta.</p>
            )}
            {offline.length > 0 && (
              <p className="text-[11px] text-amber-600">Extensão sem sinal: {offline.map((b) => BANKS.find((x) => x.key === b)!.short).join(', ')}. O pedido espera na fila até ela abrir no Chrome.</p>
            )}
            <div className="flex gap-2">
              <button onClick={run} disabled={busy || !banks.length} className="text-xs bg-af-mid text-white rounded px-3 py-1 hover:bg-af-dark disabled:opacity-50">{busy ? 'Enviando…' : 'Enviar aos bancos'}</button>
              <button onClick={() => setRunning(false)} className="text-xs text-slate-500 hover:text-slate-700 px-2">Cancelar</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
