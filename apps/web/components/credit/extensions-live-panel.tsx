'use client';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { cn } from '@/lib/utils';
import { BANKS, STATUS, ago, type Bank } from './shared';
import { BankLogo } from './bank-logo';
import { CaixaPanel } from './caixa-panel';

/* Painel do topo (Fabio 19/10): o logo de cada banco e o que a extensão dele está fazendo AGORA — quem está rodando (cliente e passo), quem está NA FILA e os últimos JÁ RODADOS.
 * Dados: GET /api/credit-analysis/live (extensionsLive). Atualiza a cada 5 s e na hora que o CRM avisa de mudança. */

interface Item { id: string; leadId: string; leadName: string; kind: string }
interface Live {
  bank: string; online: boolean; loginNeeded: boolean; lastSeenAt: string | null; foraDoHorario: boolean; queued: number; queuedRuns?: number; scheduled: number;
  scheduledList?: (Item & { at: string })[];
  running: (Item & { holderName: string | null; since: string; step: string | null; stepAt: string | null })[];
  queue: (Item & { since: string; manual: boolean; aguardandoLogin: boolean })[];
  recent: (Item & { status: string; at: string; durationMin: number | null })[];
}

type Estado = { rotulo: string; cls: string; borda: string; pulsa?: boolean };

function estadoDe(l: Live, manual = false): Estado {
  if (manual) return l.running.length || l.queued > 0 ? { rotulo: 'Em análise (à mão)', cls: 'bg-blue-50 text-blue-700', borda: 'border-l-blue-500' } : { rotulo: 'À mão — com a documentação', cls: 'bg-slate-100 text-slate-600', borda: 'border-l-slate-300' };
  if (l.loginNeeded) return { rotulo: 'Deslogada — entre no portal', cls: 'bg-red-50 text-red-700', borda: 'border-l-red-500' };
  if (l.running.length) return { rotulo: l.running[0].kind === 'CHECK' ? 'Conferindo resultado' : 'Rodando', cls: 'bg-blue-50 text-blue-700', borda: 'border-l-blue-500', pulsa: true };
  if (l.foraDoHorario) return { rotulo: 'Parada (fora de 07h–22h)', cls: 'bg-slate-100 text-slate-500', borda: 'border-l-slate-300' };
  if (!l.online) return { rotulo: 'Sem sinal', cls: 'bg-slate-100 text-slate-500', borda: 'border-l-slate-300' };
  if (l.queued > 0) return { rotulo: `Na fila (${l.queued})`, cls: 'bg-amber-50 text-amber-700', borda: 'border-l-amber-400' };
  return { rotulo: 'Livre', cls: 'bg-emerald-50 text-emerald-700', borda: 'border-l-emerald-500' };
}

const tipo = (k: string) => (k === 'CHECK' ? 'conferência' : 'análise');

function Titulo({ children, n }: { children: React.ReactNode; n?: number }) {
  return <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">{children}{n != null && <span className="ml-1 text-slate-500 normal-case font-medium">({n})</span>}</p>;
}

/** Colunas do painel. Financiamento (Fabio 29/10: "cadê os outros bancos?"): Credimorar (Bradesco, Itaú, Santander), Inter no nosso portal, CAIXA e BRB (à mão). */
type Coluna = { key: string; short: string; sub?: string; logo?: Bank; sigla?: string; cor?: string; manual?: boolean };
const COLUNAS_FH: Coluna[] = [
  { key: 'CREDIMORAR_FH', short: 'Credimorar', sub: 'Bradesco · Itaú · Santander', sigla: 'CM', cor: '#1F3A93' },
  { key: 'INTER_FH', short: 'Inter', sub: 'nosso portal', logo: 'INTER' },
  { key: 'CAIXA_FH', short: 'CAIXA', sub: 'roda com a documentação enxuta', sigla: 'CX', cor: '#005CA9', manual: true },
  { key: 'BRB_FH', short: 'BRB', sub: 'roda com a documentação completa', sigla: 'BRB', cor: '#00529B', manual: true },
];

function Emblema({ c }: { c: Coluna }) {
  if (c.logo) return <BankLogo bank={c.logo} size={40} />;
  return <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg text-[11px] font-bold text-white" style={{ background: c.cor }}>{c.sigla}</span>;
}

export function ExtensionsLivePanel({ produto = 'he' }: { produto?: 'he' | 'fh' }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const colunas: Coluna[] = produto === 'fh' ? COLUNAS_FH : BANKS.map((b) => ({ key: b.key, short: b.short, logo: b.key }));
  const { data } = useQuery<Live[]>({
    queryKey: ['credit-live', produto],
    queryFn: async () => (await api.get('/api/credit-analysis/live', { params: produto === 'fh' ? { produto: 'fh' } : {} })).data,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    const socket = getSocket();
    const on = () => queryClient.invalidateQueries({ queryKey: ['credit-live'] });
    socket.on('credit_analysis_updated', on);
    return () => { socket.off('credit_analysis_updated', on); };
  }, [queryClient]);

  const abrir = (leadId: string) => router.push(`/inbox?leadId=${leadId}`);
  const nome = (n: string, id: string) => <button onClick={() => abrir(id)} className="hover:underline text-left truncate min-w-0" title={`${n} — abrir a conversa`}>{n}</button>;

  // Resumo da fila de todos os bancos: quantos clientes diferentes estão esperando (agora + agendados).
  const esperando = new Map<string, { nome: string; bancos: string[] }>();
  for (const l of data || []) for (const q of [...l.queue, ...(l.scheduledList || [])]) {
    const e = esperando.get(q.leadId) || { nome: q.leadName, bancos: [] };
    const bk = colunas.find((x) => x.key === l.bank)?.short || l.bank;
    if (!e.bancos.includes(bk)) e.bancos.push(bk);
    esperando.set(q.leadId, e);
  }
  const hora = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="space-y-3">
    {esperando.size > 0 && (
      <div className="bg-white rounded-xl border border-af-border px-3 py-2">
        <Titulo n={esperando.size}>Clientes na fila (todos os bancos)</Titulo>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-700">
          {Array.from(esperando.entries()).map(([id, e]) => (
            <span key={id} className="inline-flex items-center gap-1 min-w-0">{nome(e.nome, id)}<span className="text-[10px] text-slate-400 flex-shrink-0">{e.bancos.join(' · ')}</span></span>
          ))}
        </div>
      </div>
    )}
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
      {colunas.map((b) => {
        const l = data?.find((x) => x.bank === b.key);
        const e = l ? estadoDe(l, b.manual) : { rotulo: 'carregando…', cls: 'bg-slate-100 text-slate-400', borda: 'border-l-slate-200' };
        return (
          <div key={b.key} className={cn('bg-white rounded-xl border border-af-border border-l-4 p-3 min-w-0', e.borda)}>
            <div className="flex items-center gap-3">
              <Emblema c={b} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-800 truncate">{b.short}{b.sub && <span className="ml-1.5 text-[11px] font-normal text-slate-400">{b.sub}</span>}</p>
                <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full', e.cls)}>
                  {e.pulsa && <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping" /><span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" /></span>}
                  {e.rotulo}
                </span>
              </div>
            </div>

            {l?.loginNeeded && <p className="mt-2 text-xs text-red-600">A sessão do portal venceu. Entre nele (CAPTCHA + código por e-mail) que a fila segue sozinha.</p>}
            {l && b.manual && !l.running.length && !l.recent.length && <p className="mt-2 text-xs text-slate-400">Ainda sem extensão: a equipe roda no portal e registra o resultado no card (aba Financiamento → "Resultado CAIXA/BRB").</p>}
            {l && !b.manual && !l.loginNeeded && !l.running.length && (
              <p className="mt-2 text-xs text-slate-400">{l.foraDoHorario ? 'Volta a trabalhar às 07h.' : l.online ? 'Nenhum cliente rodando agora.' : l.lastSeenAt ? `Vista ${ago(l.lastSeenAt)}. Chrome aberto e extensão ligada?` : 'Extensão sem sinal. Chrome aberto e extensão ligada?'}</p>
            )}

            {/* Rodando agora */}
            {l && l.running.length > 0 && (
              <div className="mt-2.5">
                <Titulo n={l.running.length}>Rodando agora</Titulo>
                <ul className="space-y-1.5">
                  {l.running.map((r) => (
                    <li key={r.id} className="text-xs rounded-lg bg-blue-50/60 border border-blue-100 px-2 py-1.5">
                      <div className="flex items-center gap-1.5 font-semibold text-slate-800">{nome(r.leadName, r.leadId)}<span className="text-[10px] font-normal text-slate-400 flex-shrink-0">{tipo(r.kind)}</span></div>
                      {r.holderName && r.holderName.toLowerCase() !== r.leadName.toLowerCase() && <p className="text-[11px] text-slate-400">no nome de {r.holderName}</p>}
                      {r.step && <p className="text-slate-500 break-words">{r.step}</p>}
                      <p className="text-[11px] text-slate-400">começou {ago(r.since)}{r.stepAt ? ` · último passo ${ago(r.stepAt)}` : ''}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Na fila */}
            {l && (l.queued > 0 || l.scheduled > 0) && (
              <div className="mt-2.5">
                <Titulo n={l.queued}>Na fila{l.queuedRuns ? ` · ${l.queuedRuns} análise(s)` : ''}</Titulo>
                {l.queue.length > 0 && (
                  <ul className="space-y-0.5 max-h-36 overflow-y-auto pr-1">
                    {l.queue.map((q, i) => (
                      <li key={q.id} className="flex items-center gap-1.5 text-xs text-slate-700">
                        <span className="w-4 text-right text-[10px] text-slate-400 flex-shrink-0">{i + 1}.</span>
                        {nome(q.leadName, q.leadId)}
                        <span className="text-[10px] text-slate-400 flex-shrink-0">{q.aguardandoLogin ? 'esperando login' : tipo(q.kind)}{q.manual ? ' · pedido seu' : ''} · {ago(q.since)}</span>
                      </li>
                    ))}
                    {l.queued > l.queue.length && <li className="text-[11px] text-slate-400 pl-5">+ {l.queued - l.queue.length} na fila</li>}
                  </ul>
                )}
                {(l.scheduledList || []).length > 0 && (
                  <div className="mt-1">
                    <p className="text-[10px] text-slate-400">Agendadas ({l.scheduled})</p>
                    <ul className="space-y-0.5 max-h-24 overflow-y-auto pr-1">
                      {(l.scheduledList || []).map((q) => (
                        <li key={q.id} className="flex items-center gap-1.5 text-xs text-slate-600">
                          {nome(q.leadName, q.leadId)}
                          <span className="text-[10px] text-slate-400 flex-shrink-0">{tipo(q.kind)} · às {hora(q.at)}</span>
                        </li>
                      ))}
                      {l.scheduled > (l.scheduledList || []).length && <li className="text-[11px] text-slate-400">+ {l.scheduled - (l.scheduledList || []).length} agendada(s)</li>}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {/* Já rodados */}
            {l && l.recent.length > 0 && (
              <div className="mt-2.5 pt-2 border-t border-slate-100">
                <Titulo>Já rodados (últimos {l.recent.length})</Titulo>
                <ul className="space-y-0.5 max-h-44 overflow-y-auto pr-1">
                  {l.recent.map((r) => {
                    const st = STATUS[r.status];
                    return (
                      <li key={r.id} className="flex items-center gap-1.5 text-xs text-slate-700">
                        <span className={cn('flex-shrink-0 px-1.5 py-px rounded-full text-[10px] font-medium', st?.cls || 'bg-slate-100 text-slate-500')}>{st?.label || r.status}</span>
                        {nome(r.leadName, r.leadId)}
                        <span className="text-[10px] text-slate-400 flex-shrink-0">{r.kind === 'CHECK' ? 'confer. · ' : ''}{ago(r.at)}{r.durationMin != null && r.durationMin > 0 ? ` · ${r.durationMin} min` : ''}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        );
      })}
      {/* Home Equity: a CAIXA é a 4ª coluna (Fabio 31/10) — cadastro, conferência e Avaliação de Risco. */}
      {produto === 'he' && <CaixaPanel />}
    </div>
    </div>
  );
}
