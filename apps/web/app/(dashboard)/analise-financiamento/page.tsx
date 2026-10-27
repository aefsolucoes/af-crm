'use client';
import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { formatCurrency } from '@/lib/utils';
import { ago } from '@/components/credit/shared';
import { pingExtensions } from '@/lib/credit-extensions';
import { ChevronDown, ChevronRight, MessageSquare, Play, RefreshCw, AlertTriangle } from 'lucide-react';
import api from '@/lib/api';

/* Análise de Crédito — Financiamento Imobiliário (Fabio 27/10). Os 6 bancos do Financiamento Habitacional:
 * Bradesco, Itaú, Santander e Inter rodam juntos numa simulação do Credimorar (extensão do Credimorar, fila CREDIMORAR_FH);
 * CAIXA (Caixa Aqui) e BRB (PCN) rodam só com a documentação completa. Ver fhBoard em apps/api/src/services/credit-analysis.service.ts. */

const BANCOS = ['Bradesco', 'Itaú', 'Santander', 'Inter', 'CAIXA', 'BRB'] as const;
const SO_COM_DOCUMENTACAO = new Set(['CAIXA', 'BRB']);

interface FhLead {
  id: string; name: string; status: string; stage: string; pipeline: string; stageEnteredAt: string | null;
  valores: { imovel: number | null; financia: number | null; entrada: number | null; renda: number | null };
  participante2: string | null;
  restricaoSerasa: boolean | null;
  simulacao: string | null;
  last: { id: string; kind: string; status: string; detail: string | null; updatedAt: string; notBefore: string | null } | null;
  leituraEm: string | null;
  active: boolean;
  bancos: Record<string, { status: string; texto: string }>;
}
interface FhBoard { leads: FhLead[]; extension: { lastSeenAt: string | null; online: boolean; extId?: string | null; loginNeeded?: boolean } | null }

/** Cor do status de cada banco (texto que o Credimorar mostra). */
function tom(status: string): string {
  const s = status.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (/aprovad/.test(s)) return 'bg-emerald-100 text-emerald-700';
  if (/rejeit|reprov|negad|recusad|cancel/.test(s)) return 'bg-red-100 text-red-700';
  if (/enviar documentos|incomplet|pend/.test(s)) return 'bg-amber-100 text-amber-700';
  if (/an[aá]lise|analise|aguard|enviad/.test(s)) return 'bg-blue-100 text-blue-700';
  return 'bg-slate-100 text-slate-500';
}

function BancoCell({ nome, lead }: { nome: string; lead: FhLead }) {
  const b = lead.bancos[nome];
  if (b) return (
    <div className="space-y-0.5" title={b.texto}>
      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${tom(b.status)}`}>{b.status}</span>
      {/proposta (\S+)/.exec(b.texto)?.[1] && <div className="text-[10px] text-slate-400">nº {/proposta (\S+)/.exec(b.texto)![1].replace(/,$/, '')}</div>}
    </div>
  );
  if (SO_COM_DOCUMENTACAO.has(nome)) return <span className="text-[11px] text-slate-400 leading-tight block">com a documentação completa</span>;
  if (lead.active) return <span className="inline-block px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-600">{lead.last?.status === 'RUNNING' ? 'Rodando' : 'Na fila'}</span>;
  return <span className="text-xs text-slate-300">—</span>;
}

export default function AnaliseFinanciamentoPage() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<FhBoard>({
    queryKey: ['credit-fh-board'],
    queryFn: async () => (await api.get('/api/credit-analysis/fh-board')).data,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function pedir(l: FhLead, kind: 'RUN' | 'CHECK') {
    if (kind === 'RUN' && l.simulacao && !window.confirm(`${l.name} já tem a simulação nº ${l.simulacao} no Credimorar.\n\nRodar de novo cria uma simulação NOVA e envia de novo aos 4 bancos (Bradesco, Itaú, Santander e Inter). Para só ler a situação, use "Conferir".\n\nRodar de novo?`)) return;
    setBusy(l.id + kind);
    try {
      const r = (await api.post('/api/credit-analysis/fh-request', { leadId: l.id, kind })).data;
      toast(r.created ? (kind === 'RUN' ? 'Pedido na fila: a extensão do Credimorar roda os 4 bancos' : 'Conferência na fila') : 'Já tem um pedido desse cliente na fila', r.created ? 'success' : 'warning');
      pingExtensions({ CREDIMORAR: data?.extension || undefined } as any, ['CREDIMORAR']);
      queryClient.invalidateQueries({ queryKey: ['credit-fh-board'] });
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao pedir a análise', 'error');
    } finally { setBusy(null); }
  }

  const leads = [...(data?.leads || [])].sort((a, b) => Number(b.active) - Number(a.active) || new Date(b.last?.updatedAt || b.stageEnteredAt || 0).getTime() - new Date(a.last?.updatedAt || a.stageEnteredAt || 0).getTime());
  const ext = data?.extension;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Análise de Crédito — Financiamento Imobiliário" subtitle="Bradesco, Itaú, Santander e Inter pelo Credimorar · CAIXA e BRB com a documentação completa" />
      <div className="flex-1 overflow-auto p-4 md:p-6 space-y-4">
        <div className="bg-white rounded-xl border border-af-border p-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${ext?.online ? (ext.loginNeeded ? 'bg-amber-500' : 'bg-emerald-500') : 'bg-slate-300'}`} />
            <span className="text-slate-700">Extensão do Credimorar: {ext?.online ? (ext.loginNeeded ? 'aguardando login no portal' : 'ligada') : 'sem sinal'}{ext?.lastSeenAt ? <span className="text-slate-400"> · {ago(ext.lastSeenAt)}</span> : null}</span>
          </div>
          <span className="text-slate-500">Card novo na Pré-Análise roda sozinho. O resultado de cada banco vem em nota no card e em push; <b>o cliente não é avisado sozinho</b>.</span>
          <span className="flex items-center gap-1 text-amber-700"><AlertTriangle size={14} /> Nome limpo é obrigatório nesses bancos: com restrição no Serasa não roda sozinho.</span>
        </div>

        <div className="bg-white rounded-xl border border-af-border overflow-hidden">
          {isLoading ? <div className="p-4"><Skeleton className="h-32" /></div> : !leads.length ? (
            <div className="p-8 text-center text-sm text-slate-400">Nenhum cliente de Financiamento Habitacional na Pré-Análise nem analisado nos últimos 90 dias.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[1100px]">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-af-border bg-slate-50">
                    <th className="px-3 py-2 w-6" />
                    <th className="px-3 py-2">Cliente</th>
                    <th className="px-3 py-2">Imóvel / financia</th>
                    {BANCOS.map((b) => <th key={b} className="px-3 py-2">{b}</th>)}
                    <th className="px-3 py-2">Simulação</th>
                    <th className="px-3 py-2 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.map((l) => (
                    <Fragment key={l.id}>
                      <tr className="border-b border-af-border/60 align-top hover:bg-slate-50/60">
                        <td className="px-3 py-3">
                          <button onClick={() => setOpen(open === l.id ? null : l.id)} className="text-slate-400 hover:text-slate-600" title="Ver o último retorno">{open === l.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                        </td>
                        <td className="px-3 py-3">
                          <Link href={`/inbox?leadId=${l.id}`} className="font-medium text-af-dark hover:underline flex items-center gap-1"><MessageSquare size={12} className="text-slate-400" /> {l.name}</Link>
                          {l.participante2 && <div className="text-[11px] text-slate-500">+ {l.participante2}</div>}
                          <div className="text-[11px] text-slate-400">{l.stage}{l.status === 'LOST' ? ' · Perdido' : ''}</div>
                          {l.restricaoSerasa === true && <div className="mt-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-red-50 text-red-700 text-[11px]"><AlertTriangle size={11} /> Restrição no Serasa</div>}
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-600 whitespace-nowrap">
                          <div>{l.valores.imovel ? formatCurrency(l.valores.imovel) : '—'}</div>
                          <div className="text-slate-400">financia {l.valores.financia ? formatCurrency(l.valores.financia) : '—'}</div>
                          {l.valores.renda ? <div className="text-slate-400">renda {formatCurrency(l.valores.renda)}</div> : null}
                        </td>
                        {BANCOS.map((b) => <td key={b} className="px-3 py-3"><BancoCell nome={b} lead={l} /></td>)}
                        <td className="px-3 py-3 text-xs text-slate-500 whitespace-nowrap">
                          {l.simulacao ? <div>nº {l.simulacao}</div> : <div className="text-slate-300">—</div>}
                          {l.leituraEm && <div className="text-slate-400">lido {ago(l.leituraEm)}</div>}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex justify-end gap-1.5">
                            {l.simulacao && <button onClick={() => pedir(l, 'CHECK')} disabled={!!busy || l.active} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 disabled:opacity-50" title="Ler de novo a situação dos 4 bancos no Credimorar (não cria nada)"><RefreshCw size={11} /> Conferir</button>}
                            <button onClick={() => pedir(l, 'RUN')} disabled={!!busy || l.active} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-af-accent text-white hover:opacity-90 disabled:opacity-50" title="Simular e enviar aos 4 bancos do Credimorar"><Play size={11} /> {l.simulacao ? 'Rodar de novo' : 'Rodar'}</button>
                          </div>
                        </td>
                      </tr>
                      {open === l.id && (
                        <tr className="border-b border-af-border/60 bg-slate-50/60">
                          <td />
                          <td colSpan={BANCOS.length + 4} className="px-3 py-3 text-xs text-slate-600 space-y-1">
                            {Object.entries(l.bancos).map(([b, x]) => <div key={b}><b>{b}:</b> {x.texto}</div>)}
                            {l.last && <div className="text-slate-500">Último retorno da extensão ({ago(l.last.updatedAt)}): {l.last.detail || l.last.status}</div>}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
