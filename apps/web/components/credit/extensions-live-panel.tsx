'use client';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { cn } from '@/lib/utils';
import { BANKS, STATUS, ago, type Bank } from './shared';
import { BankLogo } from './bank-logo';

/* Painel do topo (Fabio 19/10): o logo de cada banco e o que a extensão dele está fazendo AGORA — qual cliente está rodando, em que passo, e a fila.
 * Dados: GET /api/credit-analysis/live (extensionsLive). Atualiza a cada 5 s e na hora que o CRM avisa de mudança. */

interface Live {
  bank: Bank; online: boolean; loginNeeded: boolean; lastSeenAt: string | null; foraDoHorario: boolean; queued: number;
  running: { leadId: string; leadName: string; kind: string; holderName: string | null; since: string; step: string | null; stepAt: string | null } | null;
  lastDone: { leadName: string; status: string; at: string } | null;
}

type Estado = { rotulo: string; cls: string; borda: string; pulsa?: boolean };

function estadoDe(l: Live): Estado {
  if (l.loginNeeded) return { rotulo: 'Deslogada — entre no portal', cls: 'bg-red-50 text-red-700', borda: 'border-l-red-500' };
  if (l.running) return { rotulo: l.running.kind === 'CHECK' ? 'Conferindo resultado' : 'Rodando', cls: 'bg-blue-50 text-blue-700', borda: 'border-l-blue-500', pulsa: true };
  if (!l.online) return l.foraDoHorario ? { rotulo: 'Parada (fora de 07h–22h)', cls: 'bg-slate-100 text-slate-500', borda: 'border-l-slate-300' } : { rotulo: 'Sem sinal', cls: 'bg-slate-100 text-slate-500', borda: 'border-l-slate-300' };
  if (l.foraDoHorario) return { rotulo: 'Parada (fora de 07h–22h)', cls: 'bg-slate-100 text-slate-500', borda: 'border-l-slate-300' };
  if (l.queued > 0) return { rotulo: `Na fila (${l.queued})`, cls: 'bg-amber-50 text-amber-700', borda: 'border-l-amber-400' };
  return { rotulo: 'Livre', cls: 'bg-emerald-50 text-emerald-700', borda: 'border-l-emerald-500' };
}

export function ExtensionsLivePanel() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data } = useQuery<Live[]>({
    queryKey: ['credit-live'],
    queryFn: async () => (await api.get('/api/credit-analysis/live')).data,
    refetchInterval: 5_000,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    const socket = getSocket();
    const on = () => queryClient.invalidateQueries({ queryKey: ['credit-live'] });
    socket.on('credit_analysis_updated', on);
    return () => { socket.off('credit_analysis_updated', on); };
  }, [queryClient]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {BANKS.map((b) => {
        const l = data?.find((x) => x.bank === b.key);
        const e = l ? estadoDe(l) : { rotulo: 'carregando…', cls: 'bg-slate-100 text-slate-400', borda: 'border-l-slate-200' };
        return (
          <div key={b.key} className={cn('bg-white rounded-xl border border-af-border border-l-4 p-3 min-w-0', e.borda)}>
            <div className="flex items-center gap-3">
              <BankLogo bank={b.key} size={40} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-slate-800 truncate">{b.short}</p>
                <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full', e.cls)}>
                  {e.pulsa && <span className="relative flex h-2 w-2"><span className="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75 animate-ping" /><span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" /></span>}
                  {e.rotulo}
                </span>
              </div>
            </div>

            {l?.running ? (
              <div className="mt-2.5 text-xs">
                <button onClick={() => router.push(`/inbox?leadId=${l.running!.leadId}`)} className="font-semibold text-slate-800 hover:underline text-left break-words" title="Abrir a conversa deste cliente">{l.running.leadName}</button>
                {l.running.holderName && l.running.holderName.toLowerCase() !== l.running.leadName.toLowerCase() && <p className="text-[11px] text-slate-400">analisando no nome de {l.running.holderName}</p>}
                {l.running.step && <p className="text-slate-500 mt-0.5 break-words">{l.running.step}</p>}
                <p className="text-[11px] text-slate-400 mt-0.5">começou {ago(l.running.since)}{l.running.stepAt ? ` · último passo ${ago(l.running.stepAt)}` : ''}</p>
              </div>
            ) : l?.loginNeeded ? (
              <p className="mt-2.5 text-xs text-red-600">A sessão do portal venceu. Entre nele (CAPTCHA + código por e-mail) que a fila segue sozinha.</p>
            ) : (
              <p className="mt-2.5 text-xs text-slate-400">{l?.foraDoHorario ? 'Volta a trabalhar às 07h.' : l?.online ? 'Nenhum cliente rodando agora.' : l?.lastSeenAt ? `Vista ${ago(l.lastSeenAt)}. Chrome aberto e extensão ligada?` : 'Extensão sem sinal. Chrome aberto e extensão ligada?'}</p>
            )}

            {l && (l.queued > 0 || l.lastDone) && (
              <div className="mt-2 pt-2 border-t border-slate-100 text-[11px] text-slate-500 space-y-0.5">
                {l.queued > 0 && l.running && <p>{l.queued} na fila depois deste</p>}
                {l.lastDone && <p className="truncate" title={l.lastDone.leadName}>Último: <b className="text-slate-600">{l.lastDone.leadName}</b> — {STATUS[l.lastDone.status]?.label || l.lastDone.status} {ago(l.lastDone.at)}</p>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
