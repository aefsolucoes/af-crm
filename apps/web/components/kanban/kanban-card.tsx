'use client';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Lead } from '@/types';
import { formatCurrency, formatDate, CHANNEL_COLORS } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { Calendar, MessageCircle, GitMerge, Check } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import { MergeModal } from './merge-modal';

interface KanbanCardProps {
  lead: Lead;
  labelColor?: string;
  onOpen: (leadId: string) => void;
  /** Seleção em massa: marcado, se há alguma seleção ativa (mostra o
   *  checkbox sempre, não só no hover), e o callback de marcar/desmarcar. */
  selected?: boolean;
  selectionActive?: boolean;
  onToggleSelect?: (leadId: string) => void;
}

export function KanbanCard({ lead, labelColor, onOpen, selected = false, selectionActive = false, onToggleSelect }: KanbanCardProps) {
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
    router.push(`/inbox?leadId=${lead.id}`);
  }

  function openInbox(e: React.MouseEvent) {
    e.stopPropagation();
    router.push(`/inbox?leadId=${lead.id}`);
  }

  function handleCardClick() {
    // Com seleção em massa ligada, clicar no card marca/desmarca em vez de
    // abrir o detalhe (mais rápido pra selecionar vários seguidos).
    if (selectionActive && onToggleSelect) { onToggleSelect(lead.id); return; }
    onOpen(lead.id);
  }

  function handleToggleSelect(e: React.MouseEvent) {
    e.stopPropagation();
    onToggleSelect?.(lead.id);
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
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="group/card relative">
      {/* Checkbox de seleção em massa — canto superior esquerdo. Sempre
          visível se marcado ou se já tem seleção ativa; senão, só no hover. */}
      {onToggleSelect && (
        <button
          type="button"
          onClick={handleToggleSelect}
          onPointerDown={(e) => e.stopPropagation()}
          title={selected ? 'Desmarcar' : 'Selecionar'}
          className={cn(
            'absolute -top-1.5 -left-1.5 z-10 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all bg-white',
            selected ? 'border-af-accent bg-af-accent' : 'border-slate-300 hover:border-af-mid',
            !selected && !selectionActive && 'opacity-0 group-hover/card:opacity-100',
          )}
        >
          {selected && <Check size={12} className="text-white" />}
        </button>
      )}
      <div
        className={cn(
          'app-column-surface rounded-xl border shadow-sm hover:shadow-md transition-all cursor-pointer select-none overflow-hidden',
          selected ? 'border-af-accent ring-2 ring-af-accent/40' : 'border-af-border hover:border-af-mid/50',
        )}
        onClick={handleCardClick}
      >
        {labelColor && <div className="h-1.5 w-full" style={{ backgroundColor: labelColor }} />}
        <div className="p-3">
          {/* Cabeçalho */}
          <div className="flex items-start gap-2.5 mb-2.5">
            <div className="relative flex-shrink-0">
              <Avatar name={p1} src={(lead.contact as any)?.avatar} size="lg" />
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
                onClick={openInbox}
                title="Ir para a conversa no Inbox"
                className="p-1 rounded-lg text-slate-300 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
              >
                <MessageCircle size={12} />
              </button>
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
