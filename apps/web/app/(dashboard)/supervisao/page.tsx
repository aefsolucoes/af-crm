'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Topbar } from '@/components/ui/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ChevronLeft, ChevronRight, ClipboardList, ExternalLink, Send, SkipForward, Check, RotateCcw } from 'lucide-react';
import api from '@/lib/api';

/* Supervisão de sexta — ver apps/api/src/services/supervision.service.ts.
 * Toda sexta 08h o CRM resume cada cliente "Em contratação" e sugere a próxima mensagem; aqui o Fabio passa um por um. Nada sai sem clicar em Enviar. */

interface Item {
  id: string; leadId: string; leadName: string; etapa: string; banco: string; janelaAberta: boolean;
  status: 'PENDING' | 'SENT' | 'SKIPPED' | 'DONE';
  resumo: string; situacao: string | null; pendencias: string | null; sugestao: string | null; acao: string | null; sentText: string | null;
}
interface Data { weekKey: string; items: Item[] }

const ST: Record<Item['status'], { label: string; cls: string }> = {
  PENDING: { label: 'Pendente', cls: 'bg-amber-50 text-amber-700' },
  SENT: { label: 'Mensagem enviada', cls: 'bg-emerald-50 text-emerald-700' },
  DONE: { label: 'Feito', cls: 'bg-blue-50 text-blue-700' },
  SKIPPED: { label: 'Pulado', cls: 'bg-slate-100 text-slate-500' },
};

export default function SupervisaoPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Data>({ queryKey: ['supervision'], queryFn: async () => (await api.get('/api/supervision')).data });
  const [idx, setIdx] = useState(0);
  const [texto, setTexto] = useState('');
  const [busy, setBusy] = useState(false);
  const [gerando, setGerando] = useState(false);

  const items = data?.items || [];
  const pendentes = useMemo(() => items.filter((i) => i.status === 'PENDING').length, [items]);
  const item = items[idx];

  // abre no 1º pendente
  useEffect(() => {
    if (!items.length) return;
    const p = items.findIndex((i) => i.status === 'PENDING');
    setIdx((cur) => (cur < items.length ? (items[cur].status === 'PENDING' ? cur : p >= 0 ? p : cur) : Math.max(0, p)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  useEffect(() => { setTexto(item?.sentText || item?.sugestao || ''); }, [item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const recarregar = () => qc.invalidateQueries({ queryKey: ['supervision'] });
  const proximo = () => { const n = items.findIndex((i, k) => k > idx && i.status === 'PENDING'); setIdx(n >= 0 ? n : Math.min(idx + 1, items.length - 1)); };

  async function agir(acao: 'send' | 'skip' | 'done' | 'reopen') {
    if (!item) return;
    if (acao === 'send' && !window.confirm(`Enviar esta mensagem pro ${item.leadName} pelo WhatsApp?`)) return;
    setBusy(true);
    try {
      await api.post(`/api/supervision/${item.id}/${acao}`, acao === 'send' ? { text: texto } : {});
      toast(acao === 'send' ? 'Mensagem enviada' : acao === 'skip' ? 'Pulado — fica na lista' : acao === 'done' ? 'Marcado como feito' : 'Voltou pra pendente', 'success');
      await recarregar();
      if (acao !== 'reopen') proximo();
    } catch (err: any) { toast(err?.response?.data?.error || 'Erro', 'error'); }
    finally { setBusy(false); }
  }

  async function gerar() {
    if (!window.confirm('Gerar agora a lista desta semana? (a IA lê a conversa de cada cliente em contratação — pode levar alguns minutos)')) return;
    setGerando(true);
    try { const { data: r } = await api.post('/api/supervision/generate'); toast(`${r.criados} cliente(s) adicionados — ${r.total} na lista`, 'success'); await recarregar(); }
    catch (err: any) { toast(err?.response?.data?.error || 'Erro ao gerar', 'error'); }
    finally { setGerando(false); }
  }

  return (
    <div className="flex h-full flex-col">
      <Topbar title="Supervisão de sexta" subtitle="Clientes em contratação, um por um: resumo da conversa e a próxima mensagem sugerida" />
      <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-4">
        {isLoading && <Skeleton className="h-64 w-full" />}
        {!isLoading && !items.length && (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            <ClipboardList className="mx-auto mb-2 h-8 w-8 text-slate-300" />
            A lista desta semana ainda não foi gerada. Ela sai sozinha toda sexta às 08:00.
            <div className="mt-3"><Button onClick={gerar} disabled={gerando}>{gerando ? 'Gerando…' : 'Gerar agora'}</Button></div>
          </div>
        )}
        {item && (
          <>
            <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
              <span>Semana de {data?.weekKey.split('-').reverse().join('/')} · {pendentes} pendente(s) de {items.length}</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setIdx(Math.max(0, idx - 1))} disabled={idx === 0} className="rounded p-1 hover:bg-slate-100 disabled:opacity-30"><ChevronLeft className="h-4 w-4" /></button>
                <span>{idx + 1} / {items.length}</span>
                <button onClick={() => setIdx(Math.min(items.length - 1, idx + 1))} disabled={idx >= items.length - 1} className="rounded p-1 hover:bg-slate-100 disabled:opacity-30"><ChevronRight className="h-4 w-4" /></button>
                <button onClick={gerar} disabled={gerando} className="ml-2 rounded border border-slate-200 px-2 py-1 hover:bg-slate-50">{gerando ? 'Gerando…' : 'Atualizar lista'}</button>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-base font-semibold text-slate-800">{item.leadName}</div>
                  <div className="text-xs text-slate-500">{item.etapa}{item.banco ? ` · ${item.banco}` : ''}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${ST[item.status].cls}`}>{ST[item.status].label}</span>
                  <Link href={`/inbox?leadId=${item.leadId}`} target="_blank" className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50">
                    <ExternalLink className="h-3 w-3" /> Abrir card
                  </Link>
                </div>
              </div>

              <section className="mb-3 text-sm text-slate-700">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Resumo</div>
                <p className="whitespace-pre-wrap">{item.resumo}</p>
              </section>
              {item.situacao && <section className="mb-3 text-sm"><div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Onde está</div><p className="text-slate-700">{item.situacao}</p></section>}
              {item.pendencias && (
                <section className="mb-3 text-sm">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Pendências</div>
                  <ul className="list-disc pl-5 text-slate-700">{item.pendencias.split(/;\s*/).filter(Boolean).map((p, k) => <li key={k}>{p}</li>)}</ul>
                </section>
              )}
              {item.acao && <section className="mb-3 rounded-md bg-blue-50 p-2 text-sm text-blue-800"><span className="font-medium">Sugestão pra equipe: </span>{item.acao}</section>}

              <section className="mt-4">
                <div className="mb-1 flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <span>Mensagem pro cliente</span>
                  {!item.janelaAberta && <span className="normal-case text-amber-700">janela de 24 h fechada: use um template no card</span>}
                </div>
                {item.status === 'SENT' ? (
                  <p className="whitespace-pre-wrap rounded-md bg-emerald-50 p-2 text-sm text-emerald-800">{item.sentText}</p>
                ) : (
                  <textarea value={texto} onChange={(e) => setTexto(e.target.value)} rows={5} placeholder="A IA achou melhor não falar com o cliente agora. Se quiser, escreva uma mensagem." className="w-full rounded-md border border-slate-300 p-2 text-sm" />
                )}
              </section>

              <div className="mt-3 flex flex-wrap gap-2">
                {item.status !== 'SENT' && (
                  <Button onClick={() => agir('send')} disabled={busy || !texto.trim() || !item.janelaAberta}><Send className="mr-1 h-4 w-4" /> Enviar ao cliente</Button>
                )}
                {item.status === 'PENDING' ? (
                  <>
                    <button onClick={() => agir('done')} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"><Check className="h-4 w-4" /> Feito (resolvi de outro jeito)</button>
                    <button onClick={() => agir('skip')} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50"><SkipForward className="h-4 w-4" /> Pular</button>
                  </>
                ) : (
                  <button onClick={() => agir('reopen')} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50"><RotateCcw className="h-4 w-4" /> Voltar pra pendente</button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
