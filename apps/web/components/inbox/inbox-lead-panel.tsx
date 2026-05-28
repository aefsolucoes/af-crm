'use client';
import { useState } from 'react';
import { LeadDetail, Stage, Pipeline } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { LeadSidebar } from '@/components/lead/lead-sidebar';
import { StageGateModal } from '@/components/kanban/stage-gate-modal';
import { getMissingFields, ValidationField } from '@/lib/stage-validation';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { ExternalLink, ChevronRight, Shuffle, ListChecks, LayoutList } from 'lucide-react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { LeadTasks } from '@/components/lead/lead-tasks';

interface InboxLeadPanelProps {
  lead: LeadDetail;
  onRefresh: () => void;
}

export function InboxLeadPanel({ lead, onRefresh }: InboxLeadPanelProps) {
  const [activePanel, setActivePanel] = useState<'dados' | 'atividades'>('dados');
  const [changingStage, setChangingStage] = useState(false);
  const [gateOpen, setGateOpen]           = useState(false);
  const [gateMissing, setGateMissing]     = useState<ValidationField[]>([]);
  const [gateStageName, setGateStageName] = useState('');
  const [pendingStageId, setPendingStageId] = useState<string | null>(null);
  // Pipeline change
  const [showPipelineModal, setShowPipelineModal] = useState(false);
  const [selectedPipelineId, setSelectedPipelineId] = useState('');
  const [selectedStageId, setSelectedStageId] = useState('');
  const [changingPipeline, setChangingPipeline] = useState(false);

  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => { const { data } = await api.get('/api/pipelines'); return data; },
  });
  const selectedPipeline = pipelines.find(p => p.id === selectedPipelineId);

  const cf = ((lead.customFields || {}) as Record<string, string>);
  const p1 = cf.participante_1 || lead.contact?.name || lead.name;
  const p2 = cf.participante_2;
  const displayName = p2 ? `${p1} / ${p2}` : p1;

  async function executeStageChange(stageId: string) {
    setChangingStage(true);
    try {
      await api.patch(`/api/leads/${lead.id}/stage`, { stageId });
      toast('Etapa atualizada!');
      onRefresh();
    } catch {
      toast('Erro ao atualizar etapa', 'error');
    } finally {
      setChangingStage(false);
    }
  }

  async function handlePipelineMove() {
    if (!selectedPipelineId) return;
    setChangingPipeline(true);
    try {
      await api.patch(`/api/leads/${lead.id}/pipeline`, {
        pipelineId: selectedPipelineId,
        stageId: selectedStageId || undefined,
      });
      const p = pipelines.find(p => p.id === selectedPipelineId);
      toast(`Lead movido para "${p?.name}"!`);
      setShowPipelineModal(false);
      setSelectedPipelineId('');
      setSelectedStageId('');
      onRefresh();
    } catch {
      toast('Erro ao mover lead', 'error');
    } finally {
      setChangingPipeline(false);
    }
  }

  async function handleStageChange(stageId: string) {
    if (stageId === lead.stageId) return;
    const targetStage = lead.pipeline.stages.find((s: Stage) => s.id === stageId);
    if (!targetStage) return;

    const missing = getMissingFields(lead, targetStage.name);
    if (missing.length > 0) {
      setPendingStageId(stageId);
      setGateMissing(missing);
      setGateStageName(targetStage.name);
      setGateOpen(true);
      return;
    }
    await executeStageChange(stageId);
  }

  return (
    <>
      <StageGateModal
        open={gateOpen}
        stageName={gateStageName}
        missing={gateMissing}
        onConfirm={async () => {
          setGateOpen(false);
          if (pendingStageId) await executeStageChange(pendingStageId);
          setPendingStageId(null);
        }}
        onCancel={() => { setGateOpen(false); setPendingStageId(null); }}
      />

      {/* ── Modal: Mover para outro funil ── */}
      {showPipelineModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowPipelineModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-slate-800 mb-4 flex items-center gap-2">
              <Shuffle size={16} className="text-af-mid" /> Mover para outro funil
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-500 mb-1 block">Funil de destino</label>
                <select
                  value={selectedPipelineId}
                  onChange={e => { setSelectedPipelineId(e.target.value); setSelectedStageId(''); }}
                  className="w-full px-3 py-2 text-sm border border-af-border rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-af-accent"
                >
                  <option value="">Selecione o funil</option>
                  {pipelines.filter(p => p.id !== lead.pipelineId).map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </div>
              {selectedPipeline && (
                <div>
                  <label className="text-xs font-semibold text-slate-500 mb-1 block">Estágio de entrada</label>
                  <select
                    value={selectedStageId}
                    onChange={e => setSelectedStageId(e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-af-border rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-af-accent"
                  >
                    <option value="">Primeiro estágio (padrão)</option>
                    {selectedPipeline.stages.map((s: Stage) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="flex gap-2 mt-5">
              <button
                onClick={() => setShowPipelineModal(false)}
                className="flex-1 py-2 text-sm border border-af-border rounded-xl text-slate-600 hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                onClick={handlePipelineMove}
                disabled={!selectedPipelineId || changingPipeline}
                className="flex-1 py-2 text-sm bg-af-mid text-white rounded-xl font-semibold hover:bg-af-dark disabled:opacity-50 transition-colors"
              >
                {changingPipeline ? 'Movendo...' : 'Mover lead'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="w-96 flex-shrink-0 border-l border-af-border bg-white flex flex-col overflow-hidden">

        {/* ── Header do lead ── */}
        <div className="px-4 pt-4 pb-3 border-b border-af-border bg-af-light/30 flex-shrink-0">
          <div className="flex items-center justify-between mb-3">
            <span
              className="text-xs px-2 py-0.5 rounded-full text-white font-medium"
              style={{ backgroundColor: lead.stage.color }}
            >
              {lead.stage.name}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setSelectedPipelineId(''); setSelectedStageId(''); setShowPipelineModal(true); }}
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-af-mid transition-colors"
                title="Mover para outro funil"
              >
                <Shuffle size={12} /> Funil
              </button>
              <Link
                href={`/leads/${lead.id}`}
                className="flex items-center gap-1 text-xs text-af-mid hover:text-af-dark transition-colors"
                title="Abrir lead completo"
              >
                Ver lead <ExternalLink size={12} />
              </Link>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Avatar name={p1 || '?'} src={(lead.contact as any)?.avatar} size="lg" />
            <div className="min-w-0">
              <p className="text-sm font-bold text-slate-900 leading-snug truncate">{displayName}</p>
              {lead.value && (
                <p className="text-xs text-af-mid font-semibold mt-0.5">
                  {lead.value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ── Seletor de painel: Dados | Atividades ── */}
        <div className="flex border-b border-af-border flex-shrink-0">
          <button
            onClick={() => setActivePanel('dados')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold transition-colors border-b-2 ${
              activePanel === 'dados'
                ? 'border-af-mid text-af-mid'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            <LayoutList size={13} />
            Dados
          </button>
          <button
            onClick={() => setActivePanel('atividades')}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold transition-colors border-b-2 ${
              activePanel === 'atividades'
                ? 'border-af-mid text-af-mid'
                : 'border-transparent text-slate-400 hover:text-slate-600'
            }`}
          >
            <ListChecks size={13} />
            Atividades
            {(lead.tasks?.filter(t => !t.done).length ?? 0) > 0 && (
              <span className="bg-af-mid text-white text-[10px] px-1.5 py-0.5 rounded-full leading-none">
                {lead.tasks.filter(t => !t.done).length}
              </span>
            )}
          </button>
        </div>

        {/* ── Painel: Dados ── */}
        {activePanel === 'dados' && (
          <>
            {/* Barra de fluxo */}
            <div className="px-3 py-3 border-b border-af-border flex-shrink-0">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Fluxo</p>
              <div className="flex flex-col gap-1 max-h-40 overflow-y-auto scrollbar-thin">
                {lead.pipeline.stages.map((s: Stage) => {
                  const isCurrent = s.id === lead.stageId;
                  const stageIndex = lead.pipeline.stages.findIndex((x: Stage) => x.id === s.id);
                  const currentIndex = lead.pipeline.stages.findIndex((x: Stage) => x.id === lead.stageId);
                  const isPast = stageIndex < currentIndex;

                  return (
                    <button
                      key={s.id}
                      onClick={() => handleStageChange(s.id)}
                      disabled={changingStage || isCurrent}
                      className={`
                        flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium text-left transition-all
                        ${isCurrent
                          ? 'text-white shadow-sm cursor-default'
                          : isPast
                            ? 'bg-slate-100 text-slate-400 hover:bg-slate-200'
                            : 'bg-white border border-slate-200 text-slate-600 hover:border-af-mid hover:text-af-mid'
                        }
                        disabled:opacity-70
                      `}
                      style={isCurrent ? { backgroundColor: s.color } : {}}
                    >
                      <span
                        className="w-2 h-2 rounded-full flex-shrink-0"
                        style={{ backgroundColor: isCurrent ? 'rgba(255,255,255,0.7)' : s.color }}
                      />
                      <span className="flex-1 truncate">{s.name}</span>
                      {isCurrent && <ChevronRight size={12} className="flex-shrink-0 opacity-70" />}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Campos editáveis */}
            <div className="flex-1 overflow-hidden flex flex-col min-h-0">
              <LeadSidebar
                lead={lead}
                onRefresh={onRefresh}
                className="w-full flex-1 border-r-0 border-l-0"
              />
            </div>
          </>
        )}

        {/* ── Painel: Atividades (Tarefas + Notas) ── */}
        {activePanel === 'atividades' && (
          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            <LeadTasks
              tasks={lead.tasks ?? []}
              notes={lead.notes ?? []}
              leadId={lead.id}
              onRefresh={onRefresh}
            />
          </div>
        )}
      </div>
    </>
  );
}
