'use client';
import { Message } from '@/types';
import { formatDateTime, CHANNEL_LABELS, CHANNEL_COLORS } from '@/lib/utils';
import { MessageSquare } from 'lucide-react';

interface LeadTimelineProps {
  messages: Message[];
}

export function LeadTimeline({ messages }: LeadTimelineProps) {
  const sorted = [...messages].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-6 py-4 border-b border-af-border bg-white">
        <h3 className="text-sm font-semibold text-slate-700">Histórico de mensagens</h3>
        {messages.length > 0 && (
          <span className="ml-2 text-xs text-slate-400">({messages.length})</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 scrollbar-thin">
        {sorted.map(m => (
          <div key={m.id} className={`flex gap-3 ${m.direction === 'OUTBOUND' ? 'flex-row-reverse' : ''}`}>
            <div
              className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center"
              style={{ backgroundColor: CHANNEL_COLORS[m.channel] + '22', color: CHANNEL_COLORS[m.channel] }}
            >
              <MessageSquare size={13} />
            </div>
            <div
              className={`flex-1 rounded-xl p-3 text-sm ${
                m.direction === 'OUTBOUND'
                  ? 'bg-af-mid text-white'
                  : 'bg-white border border-af-border text-slate-700'
              }`}
            >
              <div className={`flex items-center justify-between mb-1 text-xs ${m.direction === 'OUTBOUND' ? 'text-white/70' : 'text-slate-400'}`}>
                <span>{CHANNEL_LABELS[m.channel]} · {m.direction === 'INBOUND' ? 'Recebido' : 'Enviado'}</span>
                <span>{formatDateTime(m.createdAt)}</span>
              </div>
              <p className="leading-relaxed">{m.content}</p>
            </div>
          </div>
        ))}

        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-slate-400 text-sm gap-2">
            <MessageSquare size={24} className="opacity-30" />
            <span>Nenhuma mensagem</span>
          </div>
        )}
      </div>
    </div>
  );
}
