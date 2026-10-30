'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { CheckCircle2, ExternalLink, FileText, Home, Play, RefreshCw } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { pingExtensions } from '@/lib/credit-extensions';
import { cn } from '@/lib/utils';

/* Bloco "Financiamento" dentro do card (aba Financiamento) dos cards do Financiamento Habitacional (Fabio 29/10, Jaime: o bloco mostrava os bancos do
 * Home Equity com "—"). Situação de cada banco (Credimorar: Bradesco, Itaú, Santander; nosso portal: Inter; CAIXA/BRB), rodar/conferir e o PDF da simulação. */

type Banco = { status: string; texto: string };
type FhLead = {
  id: string; simulacao: string | null; leituraEm: string | null; active: boolean;
  last: { kind: string; status: string; detail: string | null; updatedAt: string } | null;
  bancos: Record<string, Banco>;
  valores: { imovel: number | null; financia: number | null; entrada: number | null; renda: number | null };
};
const ORDEM = ['Bradesco', 'Itaú', 'Santander', 'Inter', 'CAIXA', 'BRB'];
const PDF: Record<string, string> = { Bradesco: 'FH_BRADESCO', 'Itaú': 'FH_ITAU', Santander: 'FH_SANTANDER', Inter: 'FH_INTER' };

function tom(status: string) {
  const s = status.toLowerCase();
  if (/n[aã]o aprovad|rejeit|reprov|negad/.test(s)) return 'bg-red-50 text-red-500';
  if (/aprovad/.test(s)) return 'bg-emerald-50 text-emerald-600';
  if (/an[aá]lise|aguard|pendente|enviad|processando|enviar doc/.test(s)) return 'bg-indigo-50 text-indigo-600';
  if (/falh|erro/.test(s)) return 'bg-amber-50 text-amber-700';
  return 'bg-slate-100 text-slate-500';
}

export function LeadFhAnalysis({ leadId }: { leadId: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [manual, setManual] = useState<{ bank: string; status: string; value: string; term: string; rate: string; firstInstallment: string } | null>(null);
  const { data } = useQuery<{ lead: FhLead | null; extensions: Record<string, { online: boolean; extId: string | null }> }>({
    queryKey: ['fh-lead', leadId],
    queryFn: async () => (await api.get(`/api/credit-analysis/fh-lead/${leadId}`)).data,
    refetchInterval: 30_000,
  });
  const l = data?.lead;
  const recarregar = () => qc.invalidateQueries({ queryKey: ['fh-lead', leadId] });

  async function pedir(kind: 'RUN' | 'CHECK') {
    if (kind === 'RUN' && !window.confirm('Rodar o Financiamento de novo? Cria proposta NOVA no Credimorar (Bradesco, Itaú, Santander) e no nosso portal do Inter, com os valores do card.')) return;
    setBusy(kind);
    try {
      await api.post('/api/credit-analysis/fh-request', { leadId, kind });
      pingExtensions(data?.extensions as any, ['CREDIMORAR', 'INTER'] as any);
      toast(kind === 'RUN' ? 'Financiamento pedido: as extensões rodam em seguida' : 'Conferência pedida: o resultado entra em alguns minutos', 'success');
      recarregar();
    } catch (err: any) { toast(err?.response?.data?.error || 'Erro ao pedir', 'error'); } finally { setBusy(null); }
  }
  async function pdf(banco: string) {
    if (!window.confirm(`Mandar ao cliente, pelo WhatsApp, o PDF da simulação do ${banco} (com a logo da A&F)?`)) return;
    setBusy(banco);
    try {
      const { data: r } = await api.post('/api/credit-analysis/simulation-docs', { leadId, institutions: [PDF[banco]] });
      toast(r.created?.length ? `Pedido feito: o PDF do ${banco} sai em instantes` : 'Já tem um pedido desse PDF em andamento', 'success');
    } catch (err: any) { toast(err?.response?.data?.error || 'Erro ao pedir o PDF', 'error'); } finally { setBusy(null); }
  }

  // CAIXA/BRB rodam à mão (sem extensão): a equipe registra o resultado — com a CAIXA/BRB aprovada, o CRM manda os próximos passos ao cliente (Fabio 29/10).
  async function salvarManual() {
    if (!manual) return;
    setBusy('manual');
    try {
      await api.post('/api/credit-analysis/fh-manual-result', { leadId, ...manual });
      toast('Resultado registrado', 'success');
      setManual(null);
      recarregar();
    } catch (err: any) { toast(err?.response?.data?.error || 'Erro ao registrar', 'error'); } finally { setBusy(null); }
  }

  const bancos = l ? ORDEM.filter((b) => l.bancos[b]).map((b) => [b, l.bancos[b]] as const) : [];
  return (
    <div className="mb-3 rounded-lg border border-af-border bg-slate-50/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-600"><Home size={12} /> Financiamento — bancos</span>
        <Link href="/analise-financiamento" className="flex items-center gap-1 text-[11px] text-af-mid hover:underline">Ver todos <ExternalLink size={10} /></Link>
      </div>
      {!l ? <p className="text-xs text-slate-400">Carregando…</p> : (
        <>
          {l.simulacao && <p className="mb-1.5 text-[11px] text-slate-500">Simulação Credimorar nº {l.simulacao}{l.leituraEm ? ` · lida ${new Date(l.leituraEm).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : ''}</p>}
          {!bancos.length ? (
            <p className="text-xs text-slate-400">Nenhum banco rodou ainda.{l.active ? ' Rodando agora…' : ''}</p>
          ) : (
            <div className="space-y-1.5">
              {bancos.map(([nome, b]) => {
                const aprovado = /aprovad/i.test(b.status) && !/n[aã]o aprovad/i.test(b.status);
                return (
                  <div key={nome} className="rounded-md border border-slate-200 bg-white px-2 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-700">{nome}</span>
                      <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium', tom(b.status))}>{b.status}</span>
                    </div>
                    <p className="mt-0.5 text-[11px] leading-snug text-slate-500 whitespace-pre-wrap break-words">{b.texto.replace(/^[^,—]+[,—]\s*/, '').slice(0, 220)}</p>
                    {aprovado && PDF[nome] && (
                      <button onClick={() => pdf(nome)} disabled={busy === nome} className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-af-mid hover:underline disabled:opacity-50">
                        <FileText size={11} /> Simulação em PDF pro cliente
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {manual ? (
            <div className="mt-2 space-y-1.5 rounded-md border border-slate-200 bg-white p-2">
              <div className="flex gap-1.5">
                <select value={manual.bank} onChange={(e) => setManual({ ...manual, bank: e.target.value })} className="rounded border border-slate-200 px-1.5 py-1 text-xs">
                  <option value="CAIXA_FH">CAIXA</option><option value="BRB_FH">BRB</option>
                </select>
                <select value={manual.status} onChange={(e) => setManual({ ...manual, status: e.target.value })} className="flex-1 rounded border border-slate-200 px-1.5 py-1 text-xs">
                  <option value="APPROVED">Aprovado</option><option value="CONDITIONAL">Aprovado condicional</option><option value="REJECTED">Reprovado</option>
                </select>
              </div>
              {manual.status !== 'REJECTED' && (
                <div className="grid grid-cols-2 gap-1.5">
                  <input placeholder="Valor (R$)" value={manual.value} onChange={(e) => setManual({ ...manual, value: e.target.value })} className="rounded border border-slate-200 px-1.5 py-1 text-xs" />
                  <input placeholder="Prazo (meses)" value={manual.term} onChange={(e) => setManual({ ...manual, term: e.target.value })} className="rounded border border-slate-200 px-1.5 py-1 text-xs" />
                  <input placeholder="Taxa (ex.: 10,65% a.a.)" value={manual.rate} onChange={(e) => setManual({ ...manual, rate: e.target.value })} className="rounded border border-slate-200 px-1.5 py-1 text-xs" />
                  <input placeholder="1ª parcela (R$)" value={manual.firstInstallment} onChange={(e) => setManual({ ...manual, firstInstallment: e.target.value })} className="rounded border border-slate-200 px-1.5 py-1 text-xs" />
                </div>
              )}
              <div className="flex gap-3">
                <button onClick={salvarManual} disabled={busy === 'manual'} className="text-xs font-medium text-af-mid hover:underline disabled:opacity-50">Salvar</button>
                <button onClick={() => setManual(null)} className="text-xs text-slate-500 hover:underline">Cancelar</button>
              </div>
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-3">
            <button onClick={() => pedir('RUN')} disabled={!!busy || l.active} className="inline-flex items-center gap-1 text-xs font-medium text-af-mid hover:underline disabled:opacity-50"><Play size={11} /> {l.active ? 'Rodando…' : 'Rodar financiamento'}</button>
            <button onClick={() => pedir('CHECK')} disabled={!!busy} className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:underline disabled:opacity-50"><RefreshCw size={11} /> Conferir</button>
            {!manual && <button onClick={() => setManual({ bank: 'CAIXA_FH', status: 'APPROVED', value: '', term: '', rate: '', firstInstallment: '' })} className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:underline"><CheckCircle2 size={11} /> Resultado CAIXA/BRB</button>}
          </div>
        </>
      )}
    </div>
  );
}
