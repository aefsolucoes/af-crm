'use client';
import { LeadDetail, Stage, User } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { Shuffle } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { StageGateModal } from '@/components/kanban/stage-gate-modal';
import { getMissingFields, ValidationField } from '@/lib/stage-validation';
import { MovePipelineModal } from './move-pipeline-modal';

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
  const [showPipelineModal, setShowPipelineModal] = useState(false);

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: async () => { const { data } = await api.get('/api/users'); return data; },
  });

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
              onClick={() => setShowPipelineModal(true)}
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

      {showPipelineModal && (
        <MovePipelineModal
          leadId={lead.id}
          currentPipelineId={lead.pipelineId}
          onClose={() => setShowPipelineModal(false)}
          onMoved={() => { setShowPipelineModal(false); onRefresh(); }}
        />
      )}
    </>
  );
}
