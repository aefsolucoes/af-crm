'use client';
import { LeadDetail, Pipeline, Stage, User } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { Shuffle } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { StageGateModal } from '@/components/kanban/stage-gate-modal';
import { getMissingFields, ValidationField } from '@/lib/stage-validation';

interface LeadMetaPanelProps {
  lead: LeadDetail;
  onRefresh: () => void;
}

/** Bloco Responsável / Funil atual / Estágio atual — fica ao lado de Tarefas/Notas no detalhe do lead */
export function LeadMetaPanel({ lead, onRefresh }: LeadMetaPanelProps) {
  const [changing, setChanging] = useState(false);
  const [changingUser, setChangingUser] = useState(false);
  const [gateOpen, setGateOpen] = useState(false);
  const [gateMissing, setGateMissing] = useState<ValidationField[]>([]);
  const [gateStageName, setGateStageName] = useState('');
  const [pendingStageId, setPendingStageId] = useState<string | null>(null);
  const [changingPipeline, setChangingPipeline] = useState(false);
  const [showPipelineModal, setShowPipelineModal] = useState(false);
  const [selectedPipelineId, setSelectedPipelineId] = useState('');
  const [selectedStageId, setSelectedStageId] = useState('');

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: async () => { const { data } = await api.get('/api/users'); return data; },
  });

  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => { const { data } = await api.get('/api/pipelines'); return data; },
  });

  const selectedPipeline = pipelines.find(p => p.id === selectedPipelineId);

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
      onRefresh();
    } catch {
      toast('Erro ao mover lead', 'error');
    } finally {
      setChangingPipeline(false);
    }
  }

  async function handleUserChange(userId: string) {
    if (!userId || userId === lead.userId) return;
    setChangingUser(true);
    try {
      await api.put(`/api/leads/${lead.id}`, { userId });
      toast('Responsável atualizado!');
      onRefresh();
    } catch {
      toast('Erro ao atualizar responsável', 'error');
    } finally {
      setChangingUser(false);
    }
  }

  async function executeStageChange(stageId: string) {
    setChanging(true);
    try {
      await api.patch(`/api/leads/${lead.id}/stage`, { stageId });
      toast('Estágio atualizado!');
      onRefresh();
    } catch {
      toast('Erro ao atualizar estágio', 'error');
    } finally {
      setChanging(false);
    }
  }

  async function handleStageChange(stageId: string) {
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
        onConfirm={async () => { setGateOpen(false); if (pendingStageId) await executeStageChange(pendingStageId); setPendingStageId(null); }}
        onCancel={() => { setGateOpen(false); setPendingStageId(null); }}
      />

      <div className="px-4 py-3 border-b border-af-border bg-white space-y-3 flex-shrink-0">
        <div>
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Responsável</p>
          <div className="flex items-center gap-1.5">
            <Avatar name={lead.user?.name || '?'} size="sm" />
            <select
              value={lead.user?.id || ''}
              onChange={e => handleUserChange(e.target.value)}
              disabled={changingUser || users.length === 0}
              className="w-full text-xs font-medium px-2 py-1.5 border border-af-border rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-af-accent cursor-pointer disabled:opacity-50 min-w-0"
            >
              {users.map(u => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Funil atual</p>
          <div className="flex items-center gap-1.5">
            <span className="flex-1 text-xs font-medium text-slate-700 bg-white border border-af-border px-2.5 py-1.5 rounded-lg truncate">
              {lead.pipeline.name}
            </span>
            <button
              onClick={() => { setSelectedPipelineId(''); setSelectedStageId(''); setShowPipelineModal(true); }}
              className="flex-shrink-0 p-1.5 border border-af-border rounded-lg text-slate-400 hover:text-af-mid hover:bg-af-light transition-colors"
              title="Mover para outro funil"
            >
              <Shuffle size={13} />
            </button>
          </div>
        </div>

        <div>
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Estágio atual</p>
          <select
            value={lead.stageId}
            onChange={(e) => handleStageChange(e.target.value)}
            disabled={changing}
            className="w-full text-xs font-medium px-2.5 py-1.5 border border-af-border rounded-lg bg-white text-af-mid focus:outline-none focus:ring-2 focus:ring-af-accent cursor-pointer min-w-0"
          >
            {lead.pipeline.stages.map((s: Stage) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Modal — mover para outro funil */}
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
    </>
  );
}
