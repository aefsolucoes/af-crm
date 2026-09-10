'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pipeline, Stage } from '@/types';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Shuffle } from 'lucide-react';

interface BulkMoveModalProps {
  leadIds: string[];
  onClose: () => void;
  onMoved: () => void;
}

/** "Mover N leads" — versão em massa do MovePipelineModal. Mesma escolha em
 *  3 passos (Setor → Funil → Etapa), mas SEM excluir o funil atual da lista:
 *  o usuário pode querer só trocar de ETAPA dentro do mesmo funil. */
export function BulkMoveModal({ leadIds, onClose, onMoved }: BulkMoveModalProps) {
  const [departmentId, setDepartmentId] = useState('');
  const [pipelineId, setPipelineId] = useState('');
  const [stageId, setStageId] = useState('');
  const [moving, setMoving] = useState(false);

  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => (await api.get('/api/departments')).data as { id: string; name: string }[],
  });
  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => (await api.get('/api/pipelines')).data,
  });

  const hasOrphanPipelines = pipelines.some((p) => !p.department);
  const departmentOptions = [
    ...departments,
    ...(hasOrphanPipelines ? [{ id: '__none__', name: 'Sem setor' }] : []),
  ];

  const pipelinesInDepartment = pipelines.filter((p) => {
    if (departmentId === '__none__') return !p.department;
    return p.department?.id === departmentId;
  });
  const selectedPipeline = pipelines.find((p) => p.id === pipelineId);

  async function handleMove() {
    if (!pipelineId) return;
    setMoving(true);
    try {
      const { data } = await api.post('/api/leads/bulk-move', { leadIds, pipelineId, stageId: stageId || undefined });
      toast(`${data.moved} lead(s) movido(s) para "${data.pipelineName}" (${data.stageName}).`);
      onMoved();
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao mover os leads', 'error');
    } finally {
      setMoving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-bold text-slate-800 mb-1 flex items-center gap-2">
          <Shuffle size={16} className="text-af-mid" /> Mover {leadIds.length} lead(s)
        </h3>
        <p className="text-xs text-slate-400 mb-4">Escolha o funil e a etapa de destino.</p>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-slate-500 mb-1 block">Setor</label>
            <select
              value={departmentId}
              onChange={(e) => { setDepartmentId(e.target.value); setPipelineId(''); setStageId(''); }}
              className="w-full px-3 py-2 text-sm border border-af-border rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-af-accent"
            >
              <option value="">Selecione o setor</option>
              {departmentOptions.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>

          {departmentId && (
            <div>
              <label className="text-xs font-semibold text-slate-500 mb-1 block">Funil</label>
              <select
                value={pipelineId}
                onChange={(e) => { setPipelineId(e.target.value); setStageId(''); }}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="">Selecione o funil</option>
                {pipelinesInDepartment.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {pipelinesInDepartment.length === 0 && (
                <p className="text-xs text-slate-400 mt-1">Esse setor não tem funil.</p>
              )}
            </div>
          )}

          {selectedPipeline && (
            <div>
              <label className="text-xs font-semibold text-slate-500 mb-1 block">Etapa</label>
              <select
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="">Primeira etapa (padrão)</option>
                {selectedPipeline.stages.map((s: Stage) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="flex gap-2 mt-5">
          <button
            onClick={onClose}
            className="flex-1 py-2 text-sm border border-af-border rounded-xl text-slate-600 hover:bg-slate-50"
          >
            Cancelar
          </button>
          <button
            onClick={handleMove}
            disabled={!pipelineId || moving}
            className="flex-1 py-2 text-sm bg-af-mid text-white rounded-xl font-semibold hover:bg-af-dark disabled:opacity-50 transition-colors"
          >
            {moving ? 'Movendo...' : `Mover ${leadIds.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}
