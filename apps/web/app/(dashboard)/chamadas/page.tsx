'use client';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Topbar } from '@/components/ui/topbar';
import { Skeleton } from '@/components/ui/skeleton';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed } from 'lucide-react';
import api from '@/lib/api';

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

async function fetchCalls(): Promise<CallRecord[]> {
  const { data } = await api.get('/api/calls');
  return data;
}

export default function ChamadasPage() {
  const router = useRouter();
  const { data: calls, isLoading } = useQuery({ queryKey: ['calls'], queryFn: fetchCalls });

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Chamadas" subtitle="Histórico de ligações de voz pelo WhatsApp" />

      <div className="flex-1 overflow-auto px-6 py-4 scrollbar-thin">
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
