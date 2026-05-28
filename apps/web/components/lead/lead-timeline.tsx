'use client';
import { Message, Note, NoteType } from '@/types';
import { formatDateTime, CHANNEL_LABELS, CHANNEL_COLORS } from '@/lib/utils';
import { MessageSquare, ArrowRightLeft, Pencil, Archive, User } from 'lucide-react';

interface LeadTimelineProps {
  messages: Message[];
  notes: Note[];
}

type TimelineItem =
  | { kind: 'message'; data: Message; at: Date }
  | { kind: 'event'; data: Note; at: Date };

const EVENT_STYLES: Partial<Record<NoteType, { icon: React.ReactNode; color: string; bg: string }>> = {
  STAGE_CHANGE: { icon: <ArrowRightLeft size={13} />, color: '#8b5cf6', bg: '#f5f3ff' },
  DATA_EDIT:    { icon: <Pencil size={13} />,         color: '#2261a8', bg: '#eff6ff' },
};

export function LeadTimeline({ messages, notes }: LeadTimelineProps) {
  // Separa notas de sistema das manuais
  const systemNotes = notes.filter(n => n.type === 'STAGE_CHANGE' || n.type === 'DATA_EDIT');

  // Monta linha do tempo unificada
  const items: TimelineItem[] = [
    ...messages.map(m => ({ kind: 'message' as const, data: m, at: new Date(m.createdAt) })),
    ...systemNotes.map(n => ({ kind: 'event' as const, data: n, at: new Date(n.createdAt) })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center px-6 py-4 border-b border-af-border bg-white">
        <h3 className="text-sm font-semibold text-slate-700">Conversa & Histórico</h3>
        {items.length > 0 && (
          <span className="ml-2 text-xs text-slate-400">({items.length})</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 scrollbar-thin">
        {items.map((item, idx) => {
          if (item.kind === 'message') {
            const m = item.data;
            return (
              <div key={`msg-${m.id}`} className={`flex gap-3 ${m.direction === 'OUTBOUND' ? 'flex-row-reverse' : ''}`}>
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
            );
          }

          // Evento de sistema (STAGE_CHANGE / DATA_EDIT)
          const n = item.data;
          const style = EVENT_STYLES[n.type] ?? { icon: <Pencil size={13} />, color: '#64748b', bg: '#f8fafc' };
          return (
            <div key={`evt-${n.id}-${idx}`} className="flex items-center gap-3 py-1">
              {/* Linha vertical + ícone */}
              <div className="flex flex-col items-center flex-shrink-0">
                <div
                  className="w-6 h-6 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: style.bg, color: style.color }}
                >
                  {style.icon}
                </div>
              </div>
              {/* Conteúdo do evento */}
              <div
                className="flex-1 px-3 py-2 rounded-lg border text-xs"
                style={{ backgroundColor: style.bg, borderColor: style.color + '44' }}
              >
                <p className="text-slate-700 leading-snug">{n.content}</p>
                <div className="flex items-center gap-2 mt-1">
                  {n.user && (
                    <span className="flex items-center gap-1 text-[10px] text-slate-400">
                      <User size={9} /> {n.user.name}
                    </span>
                  )}
                  <span className="text-[10px] text-slate-400 ml-auto">{formatDateTime(n.createdAt)}</span>
                </div>
              </div>
            </div>
          );
        })}

        {items.length === 0 && (
          <div className="flex flex-col items-center justify-center h-32 text-slate-400 text-sm gap-2">
            <MessageSquare size={24} className="opacity-30" />
            <span>Nenhuma atividade</span>
          </div>
        )}
      </div>
    </div>
  );
}
