'use client';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Lead } from '@/types';
import { formatCurrency, formatDate, CHANNEL_COLORS } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { ArrowDownLeft, ArrowUpRight, Calendar, MessageCircle, GitMerge } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { MergeModal } from './merge-modal';

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
  const queryClient = useQueryClient();
  const [showMerge, setShowMerge] = useState(false);

  // dnd-kit com distance:12 — cliques normais (<12px) passam para onClick
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: lead.id });

  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  const lastMsg = lead.messages?.[0];
  const unreadCount = lead._count?.messages ?? 0;
  const cf = (lead.customFields || {}) as Record<string, string>;

  // Nome de exibição: participante_1 / participante_2 (se houver ambos)
  const p1 = cf.participante_1 || lead.contact?.name || lead.name;
  const p2 = cf.participante_2;
  const displayName = p2 ? `${p1} / ${p2}` : p1;

  const channelColor = lastMsg ? CHANNEL_COLORS[lastMsg.channel] : undefined;

  // Telefones — mostra telefone_1 e/ou telefone_2
  const tel1 = cf.telefone_1 || lead.contact?.phone || '';
  const tel2 = cf.telefone_2 || '';

  function openWhatsApp(e: React.MouseEvent, phone: string) {
    e.stopPropagation();
    queryClient.invalidateQueries({ queryKey: ['lead', lead.id] });
    router.push(`/leads/${lead.id}?t=${Date.now()}`);
  }

  function handleCardClick() {
    queryClient.invalidateQueries({ queryKey: ['lead', lead.id] });
    // Força re-navegação mesmo que a URL seja a mesma (bug: voltar e clicar no mesmo card)
    router.push(`/leads/${lead.id}?t=${Date.now()}`);
  }

  return (
    <>
    <MergeModal
      open={showMerge}
      onClose={() => setShowMerge(false)}
      onMerged={() => { queryClient.invalidateQueries({ queryKey: ['leads'] }); }}
      leadId={lead.id}
      leadName={displayName}
    />
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <div
        className="bg-white rounded-xl border border-af-border shadow-sm hover:shadow-md hover:border-af-mid/50 transition-all cursor-pointer select-none"
        onClick={handleCardClick}
      >
        <div className="p-3">
          {/* Cabeçalho */}
          <div className="flex items-start gap-2.5 mb-2.5">
            <div className="relative flex-shrink-0">
              <Avatar name={p1} size="lg" />
              {channelColor && (
                <span className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white"
                  style={{ backgroundColor: channelColor }} />
              )}
            </div>

            <div className="flex-1 min-w-0 pt-0.5">
              <div className="flex items-start justify-between gap-1.5">
                <span className="text-sm font-semibold text-slate-900 leading-snug line-clamp-2">{displayName}</span>
                {unreadCount > 0 && (
                  <span className="flex-shrink-0 text-xs bg-af-mid text-white px-1.5 py-0.5 rounded-full min-w-[20px] text-center leading-tight font-medium">
                    {unreadCount}
                  </span>
                )}
              </div>
              {/* Telefones clicáveis */}
              <div className="flex flex-col gap-0.5 mt-0.5">
                {tel1 && (
                  <button onClick={e => openWhatsApp(e, tel1)}
                    className="flex items-center gap-1 text-xs text-green-600 hover:text-green-700 hover:underline transition-colors w-fit">
                    <MessageCircle size={10} /> {tel1}
                  </button>
                )}
                {tel2 && (
                  <button onClick={e => openWhatsApp(e, tel2)}
                    className="flex items-center gap-1 text-xs text-green-600 hover:text-green-700 hover:underline transition-colors w-fit">
                    <MessageCircle size={10} /> {tel2}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Última mensagem */}
          {lastMsg ? (
            <div className="flex items-center gap-1.5 mb-2.5 bg-slate-50 rounded-lg px-2.5 py-1.5">
              {lastMsg.direction === 'INBOUND'
                ? <ArrowDownLeft size={11} className="text-emerald-500 flex-shrink-0" />
                : <ArrowUpRight size={11} className="text-af-mid flex-shrink-0" />}
              <span className="text-xs text-slate-600 flex-1 truncate leading-tight">{lastMsg.content}</span>
              <span className="text-xs text-slate-400 flex-shrink-0 ml-1">{msgTime(lastMsg.createdAt)}</span>
            </div>
          ) : (
            <div className="mb-2.5 bg-slate-50 rounded-lg px-2.5 py-1.5">
              <span className="text-xs text-slate-300">Sem mensagens</span>
            </div>
          )}

          {/* Rodapé */}
          <div className="flex items-center justify-between pt-2 border-t border-af-border/60 gap-1">
            <span className={`text-xs font-bold ${lead.value ? 'text-af-mid' : 'text-slate-300'}`}>
              {lead.value ? formatCurrency(lead.value) : '—'}
            </span>
            <div className="flex items-center gap-1 text-xs text-slate-400">
              <Calendar size={10} />
              <span>{formatDate(lead.createdAt)}</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={e => { e.stopPropagation(); setShowMerge(true); }}
                title="Verificar duplicatas"
                className="p-1 rounded-lg text-slate-300 hover:text-amber-500 hover:bg-amber-50 transition-colors"
              >
                <GitMerge size={12} />
              </button>
              <Avatar name={lead.user.name} size="sm" />
            </div>
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
