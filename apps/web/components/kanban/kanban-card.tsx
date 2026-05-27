'use client';
import { useRef } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Lead } from '@/types';
import { formatCurrency, formatDate, CHANNEL_COLORS } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { ArrowDownLeft, ArrowUpRight, Calendar } from 'lucide-react';
import { useRouter } from 'next/navigation';

interface KanbanCardProps {
  lead: Lead;
}

function msgTime(dateStr: string) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0)
    return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
  if (diffDays === 1) return 'ontem';
  if (diffDays < 7) return `${diffDays}d`;
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' }).format(date);
}

export function KanbanCard({ lead }: KanbanCardProps) {
  const router = useRouter();
  const pointerStart = useRef({ x: 0, y: 0 });

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: lead.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const lastMsg = lead.messages?.[0];
  const unreadCount = lead._count?.messages ?? 0;
  const cf = (lead.customFields || {}) as Record<string, string>;
  const displayName = cf.participante_1 || lead.contact?.name || lead.name;
  const channelColor = lastMsg ? CHANNEL_COLORS[lastMsg.channel] : undefined;

  function handlePointerDown(e: React.PointerEvent) {
    pointerStart.current = { x: e.clientX, y: e.clientY };
  }

  function handleClick(e: React.MouseEvent) {
    const dx = Math.abs(e.clientX - pointerStart.current.x);
    const dy = Math.abs(e.clientY - pointerStart.current.y);
    // Só navega se não foi um arrasto (< 8px de movimento)
    if (dx < 8 && dy < 8) {
      router.push(`/leads/${lead.id}`);
    }
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div
        className="bg-white rounded-xl border border-af-border shadow-sm hover:shadow-md hover:border-af-mid/50 transition-all cursor-pointer active:cursor-grabbing select-none"
        {...listeners}
        onPointerDown={handlePointerDown}
        onClick={handleClick}
      >
        <div className="p-3">

          {/* ── Cabeçalho: avatar + nome + badge de não lidos ── */}
          <div className="flex items-start gap-2.5 mb-2.5">
            {/* Avatar com indicador de canal */}
            <div className="relative flex-shrink-0">
              <Avatar name={displayName} size="lg" />
              {channelColor && (
                <span
                  className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white"
                  style={{ backgroundColor: channelColor }}
                />
              )}
            </div>

            {/* Nome e badge */}
            <div className="flex-1 min-w-0 pt-0.5">
              <div className="flex items-start justify-between gap-1.5">
                <span className="text-sm font-semibold text-slate-900 leading-snug line-clamp-2">
                  {displayName}
                </span>
                {unreadCount > 0 && (
                  <span className="flex-shrink-0 text-xs bg-af-mid text-white px-1.5 py-0.5 rounded-full min-w-[20px] text-center leading-tight font-medium">
                    {unreadCount}
                  </span>
                )}
              </div>
              {lead.contact?.phone && (
                <span className="text-xs text-slate-400 mt-0.5 block">{lead.contact.phone}</span>
              )}
            </div>
          </div>

          {/* ── Última mensagem ── */}
          {lastMsg ? (
            <div className="flex items-center gap-1.5 mb-2.5 bg-slate-50 rounded-lg px-2.5 py-1.5">
              {lastMsg.direction === 'INBOUND' ? (
                <ArrowDownLeft size={11} className="text-emerald-500 flex-shrink-0" />
              ) : (
                <ArrowUpRight size={11} className="text-af-mid flex-shrink-0" />
              )}
              <span className="text-xs text-slate-600 flex-1 truncate leading-tight">
                {lastMsg.content}
              </span>
              <span className="text-xs text-slate-400 flex-shrink-0 ml-1">
                {msgTime(lastMsg.createdAt)}
              </span>
            </div>
          ) : (
            <div className="mb-2.5 bg-slate-50 rounded-lg px-2.5 py-1.5">
              <span className="text-xs text-slate-300">Sem mensagens</span>
            </div>
          )}

          {/* ── Rodapé: valor · data · usuário ── */}
          <div className="flex items-center justify-between pt-2 border-t border-af-border/60 gap-1">
            <span className={`text-xs font-bold ${lead.value ? 'text-af-mid' : 'text-slate-300'}`}>
              {lead.value ? formatCurrency(lead.value) : '—'}
            </span>
            <div className="flex items-center gap-1 text-xs text-slate-400">
              <Calendar size={10} />
              <span>{formatDate(lead.createdAt)}</span>
            </div>
            <Avatar name={lead.user.name} size="sm" />
          </div>

        </div>
      </div>
    </div>
  );
}
