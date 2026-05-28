'use client';
import { useState } from 'react';
import {
  DndContext, DragEndEvent, PointerSensor, useSensor, useSensors, closestCorners,
} from '@dnd-kit/core';
import { Stage, Lead, Pipeline, Contact, User } from '@/types';
import { KanbanColumn } from './kanban-column';
import { LeadModal } from './lead-modal';
import { StageGateModal } from './stage-gate-modal';
import { usePipelineStore } from '@/store/pipeline.store';
import { getMissingFields, ValidationField } from '@/lib/stage-validation';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';

interface KanbanBoardProps {
  pipeline: Pipeline;
  leads: Lead[];
  contacts: Contact[];
  users: User[];
  onRefresh: () => void;
  isSearching?: boolean;
}

export function KanbanBoard({ pipeline, leads, contacts, users, onRefresh, isSearching }: KanbanBoardProps) {
  const { moveLeadOptimistic } = usePipelineStore();
  const [addLeadStageId, setAddLeadStageId] = useState<string | null>(null);

  // Stage gate
  const [gateOpen, setGateOpen]       = useState(false);
  const [gateMissing, setGateMissing] = useState<ValidationField[]>([]);
  const [gateStageName, setGateStageName] = useState('');
  const [pendingMove, setPendingMove] = useState<{ leadId: string; stageId: string } | null>(null);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 12 } }));

  function getLeadsForStage(stageId: string) {
    return leads.filter((l) => l.stageId === stageId);
  }

  async function executeMove(leadId: string, stageId: string) {
    moveLeadOptimistic(leadId, stageId);
    try {
      await api.patch(`/api/leads/${leadId}/stage`, { stageId });
      onRefresh();
    } catch {
      toast('Erro ao mover lead', 'error');
      onRefresh();
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over) return;

    const leadId = active.id as string;
    const overId = over.id as string;

    const targetStage = pipeline.stages.find((s) => s.id === overId) ||
      pipeline.stages.find((s) => getLeadsForStage(s.id).some((l) => l.id === overId));

    if (!targetStage) return;

    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.stageId === targetStage.id) return;

    // Validação de campos obrigatórios
    const missing = getMissingFields(lead, targetStage.name);
    if (missing.length > 0) {
      setPendingMove({ leadId, stageId: targetStage.id });
      setGateMissing(missing);
      setGateStageName(targetStage.name);
      setGateOpen(true);
      return;
    }

    await executeMove(leadId, targetStage.id);
  }

  async function handleGateConfirm() {
    setGateOpen(false);
    if (pendingMove) {
      await executeMove(pendingMove.leadId, pendingMove.stageId);
    }
    setPendingMove(null);
  }

  function handleGateCancel() {
    setGateOpen(false);
    setPendingMove(null);
  }

  return (
    <>
      <StageGateModal
        open={gateOpen}
        stageName={gateStageName}
        missing={gateMissing}
        onConfirm={handleGateConfirm}
        onCancel={handleGateCancel}
      />

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
