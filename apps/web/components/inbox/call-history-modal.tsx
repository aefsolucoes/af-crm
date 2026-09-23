'use client';
import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { PhoneIncoming, PhoneOutgoing, PhoneMissed, Loader2 } from 'lucide-react';
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

export function CallHistoryModal({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const [calls, setCalls] = useState<CallRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<CallRecord[]>('/api/calls/history', { params: { leadId } })
      .then(({ data }) => { if (!cancelled) setCalls(data); })
      .catch(() => { if (!cancelled) setCalls([]); });
    return () => { cancelled = true; };
  }, [leadId]);

  return (
    <Modal title="Histórico de chamadas" onClose={onClose} size="md">
      {calls === null && (
        <div className="flex items-center justify-center py-8 text-slate-400">
          <Loader2 size={20} className="animate-spin" />
        </div>
      )}

      {calls?.length === 0 && (
        <p className="text-sm text-slate-400 text-center py-8">Nenhuma chamada registrada com esse cliente ainda.</p>
      )}

      {calls && calls.length > 0 && (
        <ul className="divide-y divide-af-border">
          {calls.map((call) => {
            const missed = call.status === 'MISSED' || call.status === 'REJECTED';
            const duration = formatDuration(call.connectedAt, call.endedAt);
            const Icon = missed ? PhoneMissed : call.direction === 'INBOUND' ? PhoneIncoming : PhoneOutgoing;
            const date = new Date(call.startedAt);
            return (
              <li key={call.id} className="flex items-center gap-3 py-3">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${missed ? 'bg-red-50 text-red-500' : 'bg-emerald-50 text-emerald-600'}`}>
                  <Icon size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-slate-800">
                    {call.direction === 'INBOUND' ? 'Chamada recebida' : 'Chamada feita'} — {STATUS_LABEL[call.status]}
                  </p>
                  <p className="text-xs text-slate-400">
                    {date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })} às{' '}
                    {date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    {call.answeredBy && ` · atendida por ${call.answeredBy.name}`}
                  </p>
                </div>
                {duration && <span className="text-xs font-medium text-slate-500 flex-shrink-0">{duration}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
