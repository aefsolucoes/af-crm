'use client';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Lead } from '@/types';
import { formatCurrency, formatDate, isOverdue, CHANNEL_COLORS } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { MessageSquare, Clock, Building2 } from 'lucide-react';
import Link from 'next/link';

interface KanbanCardProps {
  lead: Lead;
}

export function KanbanCard({ lead }: KanbanCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: lead.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const hasUnread = (lead._count?.messages ?? 0) > 0;
  const urgent = false; // no task dueAt on lead directly

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <div
        className={`bg-white rounded-lg border border-af-border shadow-sm hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing ${urgent ? 'border-l-4 border-l-red-400' : ''}`}
        {...listeners}
      >
        <div className="p-3">
          {/* Header */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <Link
              href={`/leads/${lead.id}`}
              className="text-sm font-medium text-slate-900 hover:text-af-mid line-clamp-2 leading-snug"
              onClick={(e) => e.stopPropagation()}
            >
              {lead.name}
            </Link>
            {hasUnread && (
              <span className="flex-shrink-0 flex items-center gap-0.5 text-xs bg-af-mid text-white px-1.5 py-0.5 rounded-full">
                <MessageSquare size={10} />
                {lead._count!.messages}
              </span>
            )}
          </div>

          {/* Company */}
          {lead.company && (
            <div className="flex items-center gap-1 text-xs text-slate-500 mb-2">
              <Building2 size={11} />
              <span className="truncate">{lead.company.name}</span>
            </div>
          )}

          {/* Tags */}
          {lead.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mb-2">
              {lead.tags.slice(0, 2).map((tag) => (
                <Badge key={tag} className="bg-af-light text-af-mid text-xs">{tag}</Badge>
              ))}
              {lead.tags.length > 2 && <Badge className="bg-slate-100 text-slate-500">+{lead.tags.length - 2}</Badge>}
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between pt-2 border-t border-af-border/60">
            <div className="flex items-center gap-1.5">
              <Avatar name={lead.user.name} size="sm" />
              {lead.value && (
                <span className="text-xs font-medium text-af-mid">{formatCurrency(lead.value)}</span>
              )}
            </div>
            <div className="flex items-center gap-1 text-xs text-slate-400">
              <Clock size={10} />
              {formatDate(lead.createdAt)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
