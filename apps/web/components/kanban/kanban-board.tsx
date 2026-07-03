'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragEndEvent, PointerSensor, useSensor, useSensors, closestCorners,
} from '@dnd-kit/core';
import { Plus, X, Check } from 'lucide-react';
import { Stage, Lead, Pipeline, Contact, User } from '@/types';
import { KanbanColumn } from './kanban-column';
import { LeadModal } from './lead-modal';
import { LeadDetailModal } from './lead-detail-modal';
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
  const [openLeadId, setOpenLeadId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [addingStage, setAddingStage] = useState(false);
  const [newStageName, setNewStageName] = useState('');
  const [savingStage, setSavingStage] = useState(false);

  async function handleCreateStage() {
    const name = newStageName.trim();
    if (!name) return;
    setSavingStage(true);
    try {
      await api.post(`/api/pipelines/${pipeline.id}/stages`, { name });
      queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      setNewStageName('');
      setAddingStage(false);
      toast(`Etapa "${name}" criada!`);
    } catch {
      toast('Erro ao criar etapa', 'error');
    } finally {
      setSavingStage(false);
    }
  }

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
              onOpenLead={(leadId) => setOpenLeadId(leadId)}
            />
          ))}

          {/* Adicionar etapa */}
          <div className="flex flex-col w-72 flex-shrink-0">
            {addingStage ? (
              <div className="app-column-surface rounded-xl shadow-md p-2 flex items-center gap-1">
                <input
                  autoFocus
                  value={newStageName}
                  onChange={(e) => setNewStageName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreateStage();
                    if (e.key === 'Escape') { setAddingStage(false); setNewStageName(''); }
                  }}
                  placeholder="Nome da etapa"
                  className="flex-1 min-w-0 text-sm px-2 py-1.5 border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent"
                />
                <button
                  onClick={handleCreateStage}
                  disabled={savingStage || !newStageName.trim()}
                  className="text-green-600 hover:text-green-700 disabled:opacity-40 flex-shrink-0"
                >
                  <Check size={18} />
                </button>
                <button
                  onClick={() => { setAddingStage(false); setNewStageName(''); }}
                  className="text-slate-400 hover:text-slate-600 flex-shrink-0"
                >
                  <X size={18} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setAddingStage(true)}
                className="flex items-center gap-1.5 rounded-xl app-column-surface shadow-md px-3 py-2.5 text-sm font-medium text-slate-600 hover:text-slate-800 transition-colors"
              >
                <Plus size={16} /> Adicionar etapa
              </button>
            )}
          </div>
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

      <LeadDetailModal
        leadId={openLeadId}
        onClose={() => { setOpenLeadId(null); onRefresh(); }}
      />
    </>
  );
}
