'use client';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Stage, Lead } from '@/types';
import { KanbanCard } from './kanban-card';
import { formatCurrency } from '@/lib/utils';
import { Plus } from 'lucide-react';

interface KanbanColumnProps {
  stage: Stage;
  leads: Lead[];
  onAddLead: (stageId: string) => void;
}

export function KanbanColumn({ stage, leads, onAddLead }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });

  const totalValue = leads.reduce((sum, l) => sum + (l.value || 0), 0);

  return (
    <div className="flex flex-col w-72 flex-shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: stage.color }} />
          <span className="text-sm font-semibold text-slate-700">{stage.name}</span>
          <span className="text-xs bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded-full font-medium">
            {leads.length}
          </span>
        </div>
        <button
          onClick={() => onAddLead(stage.id)}
          className="text-slate-400 hover:text-af-mid hover:bg-af-light rounded p-0.5 transition-colors"
          title="Adicionar lead"
        >
          <Plus size={16} />
        </button>
      </div>

      {/* Total */}
      {totalValue > 0 && (
        <div className="text-xs text-slate-500 mb-2 font-medium">{formatCurrency(totalValue)}</div>
      )}

      {/* Cards */}
      <SortableContext items={leads.map((l) => l.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`flex flex-col gap-2 flex-1 min-h-[200px] p-2 rounded-xl transition-colors ${
            isOver ? 'bg-af-light' : 'bg-slate-100/60'
          }`}
        >
          {leads.map((lead) => (
            <KanbanCard key={lead.id} lead={lead} />
          ))}
        </div>
      </SortableContext>
    </div>
  );
}
