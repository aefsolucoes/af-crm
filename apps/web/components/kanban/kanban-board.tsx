'use client';
import { useState } from 'react';
import {
  DndContext, DragEndEvent, DragOverEvent, PointerSensor, useSensor, useSensors, closestCorners,
} from '@dnd-kit/core';
import { Stage, Lead, Pipeline, Contact, User } from '@/types';
import { KanbanColumn } from './kanban-column';
import { LeadModal } from './lead-modal';
import { usePipelineStore } from '@/store/pipeline.store';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';

interface KanbanBoardProps {
  pipeline: Pipeline;
  leads: Lead[];
  contacts: Contact[];
  users: User[];
  onRefresh: () => void;
}

export function KanbanBoard({ pipeline, leads, contacts, users, onRefresh }: KanbanBoardProps) {
  const { moveLeadOptimistic, setLeads } = usePipelineStore();
  const [addLeadStageId, setAddLeadStageId] = useState<string | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  function getLeadsForStage(stageId: string) {
    return leads.filter((l) => l.stageId === stageId);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const leadId = active.id as string;
    const overId = over.id as string;

    // overId can be a stage id or a lead id
    const targetStage = pipeline.stages.find((s) => s.id === overId) ||
      pipeline.stages.find((s) => getLeadsForStage(s.id).some((l) => l.id === overId));

    if (!targetStage) return;

    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.stageId === targetStage.id) return;

    // Optimistic update
    moveLeadOptimistic(leadId, targetStage.id);

    try {
      await api.patch(`/api/leads/${leadId}/stage`, { stageId: targetStage.id });
      onRefresh();
    } catch {
      toast('Erro ao mover lead', 'error');
      onRefresh(); // revert by refreshing
    }
  }

  return (
    <>
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <div className="flex gap-4 h-full overflow-x-auto pb-4 px-4 scrollbar-thin">
          {pipeline.stages.map((stage) => (
            <KanbanColumn
              key={stage.id}
              stage={stage}
              leads={getLeadsForStage(stage.id)}
              onAddLead={(stageId) => setAddLeadStageId(stageId)}
            />
          ))}
        </div>
      </DndContext>

      <LeadModal
        open={!!addLeadStageId}
        onClose={() => setAddLeadStageId(null)}
        onCreated={onRefresh}
        stages={pipeline.stages}
        pipelineId={pipeline.id}
        defaultStageId={addLeadStageId || undefined}
        contacts={contacts}
        users={users}
      />
    </>
  );
}
