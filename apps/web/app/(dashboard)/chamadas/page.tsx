'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Topbar } from '@/components/ui/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Phone } from 'lucide-react';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';

interface CallRecord {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  status: 'RINGING' | 'CONNECTING' | 'CONNECTED' | 'ENDED' | 'MISSED' | 'REJECTED' | 'FAILED';
  fromPhone: string;
  toPhone: string;
  startedAt: string;
  connectedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  answeredBy: { id: string; name: string } | null;
  lead: { id: string; name: string } | null;
}

const STATUS_LABEL: Record<CallRecord['status'], string> = {
  RINGING: 'Chamando…',
  CONNECTING: 'Conectando…',
  CONNECTED: 'Em andamento',
  ENDED: 'Atendida',
  MISSED: 'Perdida',
  REJECTED: 'Recusada',
  FAILED: 'Falhou',
};

function formatDuration(connectedAt: string | null, endedAt: string | null): string | null {
  if (!connectedAt || !endedAt) return null;
  const secs = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(connectedAt).getTime()) / 1000));
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/** Ligação que está acontecendo agora. Os limites de tempo protegem de registros que ficaram "tocando" no banco
 *  porque o aviso de término nunca chegou (a Meta desiste de uma ligação sem resposta em ~1 minuto). */
function isLive(c: CallRecord, now: number): boolean {
  const age = (iso: string | null) => (iso ? now - new Date(iso).getTime() : Infinity);
  if (c.status === 'RINGING') return age(c.startedAt) < 120_000;
  if (c.status === 'CONNECTING') return age(c.startedAt) < 300_000;
  if (c.status === 'CONNECTED') return age(c.connectedAt || c.startedAt) < 4 * 3600_000;
  return false;
}

function clock(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
}

function formatPhone(p: string): string {
  const d = p.replace(/\D/g, '');
  const n = d.startsWith('55') && d.length > 11 ? d.slice(2) : d;
  if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
  if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
  return p;
}

async function fetchCalls(): Promise<CallRecord[]> {
  const { data } = await api.get('/api/calls');
  return data;
}

export default function ChamadasPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: calls, isLoading } = useQuery({ queryKey: ['calls'], queryFn: fetchCalls, refetchInterval: 10_000 });
  const [now, setNow] = useState(() => Date.now());

  // Quem está ligando agora: atualiza na hora quando chega, é atendida ou termina.
  useEffect(() => {
    const socket = getSocket();
    const refresh = () => queryClient.invalidateQueries({ queryKey: ['calls'] });
    socket.on('incoming_call', refresh);
    socket.on('call_answered_by', refresh);
    socket.on('call_ended', refresh);
    return () => { socket.off('incoming_call', refresh); socket.off('call_answered_by', refresh); socket.off('call_ended', refresh); };
  }, [queryClient]);

  const live = (calls || []).filter((c) => isLive(c, now));
  useEffect(() => {
    if (!live.length) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live.length]);

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Chamadas" subtitle="Histórico de ligações de voz pelo WhatsApp" />

      <div className="flex-1 overflow-auto px-6 py-4 scrollbar-thin">
        {/* Ligações acontecendo agora */}
        <div className="bg-white rounded-xl border border-af-border p-4 mb-4">
          <div className="flex items-center gap-2 mb-2">
            <span className={`w-2 h-2 rounded-full ${live.length ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
            <h2 className="text-sm font-semibold text-slate-800">Ligações agora</h2>
          </div>
          {live.length === 0 ? (
            <p className="text-xs text-slate-400">Nenhuma ligação neste momento. Quando alguém ligar, aparece aqui na hora.</p>
          ) : (
            <div className="divide-y divide-af-border">
              {live.map((c) => {
                const ringing = c.status === 'RINGING';
                const started = new Date(c.connectedAt || c.startedAt).getTime();
                const who = c.lead?.name || formatPhone(c.direction === 'INBOUND' ? c.fromPhone : c.toPhone);
                return (
                  <div key={c.id} className="flex items-center gap-3 py-2.5">
                    <div className={`w-9 h-9 rounded-full flex items-center justify-center ${ringing ? 'bg-blue-50 text-blue-500 animate-pulse' : 'bg-emerald-50 text-emerald-600'}`}>
                      <Phone size={16} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-800 truncate">{who}</div>
                      <div className="text-xs text-slate-400">
                        {c.lead && <>{formatPhone(c.direction === 'INBOUND' ? c.fromPhone : c.toPhone)} · </>}
                        {ringing
                          ? `${c.direction === 'INBOUND' ? 'Ligando pra gente' : 'Estamos ligando'} · ${clock(now - started)}`
                          : c.status === 'CONNECTING'
                            ? `Conectando${c.answeredBy ? ` · ${c.answeredBy.name} atendeu` : ''}`
                            : `Em andamento · ${clock(now - started)}${c.answeredBy ? ` · ${c.answeredBy.name}` : ''}`}
                      </div>
                    </div>
                    {c.lead && (
                      <button onClick={() => router.push(`/inbox?leadId=${c.lead!.id}`)} className="text-xs text-af-mid hover:underline flex-shrink-0">Ver conversa</button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {isLoading && (
          <div className="space-y-2">
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-14" />)}
          </div>
        )}

        {!isLoading && (calls?.length || 0) === 0 && (
          <div className="text-center py-12 text-slate-400 text-sm">Nenhuma chamada registrada ainda.</div>
        )}

        {!isLoading && calls && calls.length > 0 && (
          <div className="bg-white rounded-xl border border-af-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 border-b border-af-border">
                  <th className="px-4 py-2.5 font-medium">Cliente</th>
                  <th className="px-4 py-2.5 font-medium">Direção</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Duração</th>
                  <th className="px-4 py-2.5 font-medium">Atendida por</th>
                  <th className="px-4 py-2.5 font-medium">Data</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-af-border">
                {calls.map((call) => {
                  const missed = call.status === 'MISSED' || call.status === 'REJECTED' || call.status === 'FAILED';
                  const duration = formatDuration(call.connectedAt, call.endedAt);
                  const Icon = missed ? PhoneMissed : call.direction === 'INBOUND' ? PhoneIncoming : PhoneOutgoing;
                  const date = new Date(call.startedAt);
                  return (
                    <tr
                      key={call.id}
                      className={call.lead ? 'hover:bg-slate-50 cursor-pointer transition-colors' : ''}
                      onClick={() => call.lead && router.push(`/inbox?leadId=${call.lead.id}`)}
                    >
                      <td className="px-4 py-3 font-medium text-slate-800">
                        {call.lead?.name || call.fromPhone}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 ${missed ? 'text-red-500' : 'text-emerald-600'}`}>
                          <Icon size={14} />
                          {call.direction === 'INBOUND' ? 'Recebida' : 'Feita'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{STATUS_LABEL[call.status]}</td>
                      <td className="px-4 py-3 text-slate-600">{duration || '—'}</td>
                      <td className="px-4 py-3 text-slate-600">{call.answeredBy?.name || '—'}</td>
                      <td className="px-4 py-3 text-slate-400 text-xs whitespace-nowrap">
                        {date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })} às{' '}
                        {date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
