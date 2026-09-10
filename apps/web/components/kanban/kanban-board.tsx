'use client';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DndContext, DragEndEvent, PointerSensor, useSensor, useSensors, closestCorners,
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { Plus, X, Check, Shuffle } from 'lucide-react';
import { Stage, Lead, Pipeline, Contact, User } from '@/types';
import { KanbanColumn, stageColumnDragId } from './kanban-column';
import { LeadModal } from './lead-modal';
import { LeadDetailModal } from './lead-detail-modal';
import { BulkMoveModal } from './bulk-move-modal';
import { StageGateModal } from './stage-gate-modal';
import { ColorSwatches } from './color-swatches';
import { randomStageColor } from './stage-colors';
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
  const [newStageColor, setNewStageColor] = useState(randomStageColor());
  const [savingStage, setSavingStage] = useState(false);

  // Seleção em massa — marcar vários cards e mover todos de uma vez.
  const [selectedLeadIds, setSelectedLeadIds] = useState<Set<string>>(new Set());
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  function toggleLeadSelect(id: string) {
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function clearSelection() { setSelectedLeadIds(new Set()); }
  // "Selecionar todos desta etapa" — marca/desmarca de uma vez só os cards de
  // UMA coluna (não do funil inteiro). Se já estão todos marcados, desmarca;
  // senão, marca todos.
  function toggleStageSelection(stageLeadIds: string[]) {
    if (stageLeadIds.length === 0) return;
    setSelectedLeadIds((prev) => {
      const next = new Set(prev);
      const allIn = stageLeadIds.every((id) => next.has(id));
      stageLeadIds.forEach((id) => (allIn ? next.delete(id) : next.add(id)));
      return next;
    });
  }
  // Some com a seleção ao trocar de funil (ids não valem no outro).
  useEffect(() => { clearSelection(); }, [pipeline.id]);

  async function handleCreateStage() {
    const name = newStageName.trim();
    if (!name) return;
    setSavingStage(true);
    try {
      await api.post(`/api/pipelines/${pipeline.id}/stages`, { name, color: newStageColor });
      queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      setNewStageName('');
      setNewStageColor(randomStageColor());
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

  // Ordem otimista das colunas (arrastar pra reordenar) — null = usa a ordem
  // que já vem de pipeline.stages (o backend já devolve ordenado por
  // `order`). Reseta ao trocar de funil, senão a ordem de um funil vazava
  // visualmente pro outro por um instante até o próximo fetch.
  const [stageOrder, setStageOrder] = useState<string[] | null>(null);
  useEffect(() => { setStageOrder(null); }, [pipeline.id]);
  const displayStages = stageOrder
    ? (stageOrder.map((id) => pipeline.stages.find((s) => s.id === id)).filter((s): s is Stage => !!s))
    : pipeline.stages;

  async function handleStageReorder(draggedStageId: string, overStageId: string) {
    const currentOrder = stageOrder || pipeline.stages.map((s) => s.id);
    const oldIndex = currentOrder.indexOf(draggedStageId);
    const newIndex = currentOrder.indexOf(overStageId);
    if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return;

    const reordered = arrayMove(currentOrder, oldIndex, newIndex);
    setStageOrder(reordered);
    try {
      await api.patch(`/api/pipelines/${pipeline.id}/stages/reorder`, { stageIds: reordered });
      queryClient.invalidateQueries({ queryKey: ['pipelines'] });
    } catch {
      toast('Erro ao reordenar as etapas', 'error');
      setStageOrder(null); // desfaz o otimista, volta pra ordem do servidor
    }
  }

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

    // Arrasto de COLUNA (reordenar etapas) — distinguido pelo `data.type`
    // marcado em useSortable() no kanban-column.tsx. Id prefixado (col:...),
    // então nunca colide com um id de lead.
    if (active.data.current?.type === 'stage') {
      const draggedStageId = active.data.current.stageId as string;
      // `over` pode ser: outra alça de coluna (type "stage"), um CARD dentro
      // de alguma coluna (usa a etapa dona do card), ou a área vazia do
      // corpo da coluna (o useDroppable ali usa o id "cru" da etapa).
      const overId = over.id as string;
      const overStageId = over.data.current?.type === 'stage'
        ? (over.data.current.stageId as string)
        : leads.find((l) => l.id === overId)?.stageId
          ?? pipeline.stages.find((s) => s.id === overId)?.id;
      if (overStageId) await handleStageReorder(draggedStageId, overStageId);
      return;
    }

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
          <SortableContext items={displayStages.map((s) => stageColumnDragId(s.id))} strategy={horizontalListSortingStrategy}>
            {displayStages.map((stage) => (
              <KanbanColumn
                key={stage.id}
                stage={stage}
                leads={getLeadsForStage(stage.id)}
                onAddLead={(stageId) => setAddLeadStageId(stageId)}
                onOpenLead={(leadId) => setOpenLeadId(leadId)}
                selectedLeadIds={selectedLeadIds}
                onToggleSelect={toggleLeadSelect}
                onToggleStageSelection={toggleStageSelection}
              />
            ))}
          </SortableContext>

          {/* Adicionar etapa */}
          <div className="flex flex-col w-72 flex-shrink-0">
            {addingStage ? (
              <div className="app-column-surface rounded-xl shadow-md p-2 space-y-2">
                <div className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: newStageColor }} />
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
                <ColorSwatches value={newStageColor} onChange={setNewStageColor} className="px-1" />
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

      {/* Barra flutuante de seleção em massa — aparece quando há algo marcado.
          A seleção agora é por etapa (checkbox no topo de cada coluna) ou card
          a card; não existe mais "selecionar tudo do funil". */}
      {!isSearching && selectedLeadIds.size > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-af-navy text-white rounded-full shadow-xl px-5 py-2.5">
          <span className="text-sm font-medium">{selectedLeadIds.size} selecionado(s)</span>
          <button
            onClick={() => setBulkMoveOpen(true)}
            className="flex items-center gap-1.5 text-sm font-semibold bg-white text-af-navy px-3 py-1.5 rounded-full hover:bg-slate-100 transition-colors"
          >
            <Shuffle size={13} /> Mover
          </button>
          <button onClick={clearSelection} className="text-sm text-white/70 hover:text-white transition-colors">
            Limpar
          </button>
        </div>
      )}

      {bulkMoveOpen && (
        <BulkMoveModal
          leadIds={Array.from(selectedLeadIds)}
          onClose={() => setBulkMoveOpen(false)}
          onMoved={() => { setBulkMoveOpen(false); clearSelection(); onRefresh(); queryClient.invalidateQueries({ queryKey: ['leads'] }); }}
        />
      )}
    </>
  );
}
