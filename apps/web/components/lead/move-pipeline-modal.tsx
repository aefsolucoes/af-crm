'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pipeline, Stage } from '@/types';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { Shuffle } from 'lucide-react';

interface MovePipelineModalProps {
  leadId: string;
  currentPipelineId: string;
  onClose: () => void;
  onMoved: () => void;
}

/** Modal "Mover para outro funil", compartilhado entre a Inbox e o Funil/Kanban
 *  (mesmo componente nos dois lugares — evita as duas telas ficarem
 *  dessincronizadas, um problema real com a versão duplicada anterior).
 *
 *  Seleção em 3 passos — setor primeiro, senão "Vendas"/"Em contratação"/
 *  "Follow Up" aparecem repetidos na lista (cada setor tem os seus) sem
 *  jeito de saber qual é qual: Setor → Funil (só os desse setor) → Etapa. */
export function MovePipelineModal({ leadId, currentPipelineId, onClose, onMoved }: MovePipelineModalProps) {
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

  // Pipelines sem setor (compatibilidade, funis antigos) entram como um
  // grupo "Sem setor" — só aparece se algum existir de verdade.
  const hasOrphanPipelines = pipelines.some(p => !p.department);
  const departmentOptions = [
    ...departments,
    ...(hasOrphanPipelines ? [{ id: '__none__', name: 'Sem setor' }] : []),
  ];

  const pipelinesInDepartment = pipelines.filter(p => {
    if (p.id === currentPipelineId) return false;
    if (departmentId === '__none__') return !p.department;
    return p.department?.id === departmentId;
  });
  const selectedPipeline = pipelines.find(p => p.id === pipelineId);

  async function handleMove() {
    if (!pipelineId) return;
    setMoving(true);
    try {
      await api.patch(`/api/leads/${leadId}/pipeline`, { pipelineId, stageId: stageId || undefined });
      toast(`Lead movido para "${selectedPipeline?.name}"!`);
      onMoved();
    } catch {
      toast('Erro ao mover lead', 'error');
    } finally {
      setMoving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm mx-4" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-bold text-slate-800 mb-4 flex items-center gap-2">
          <Shuffle size={16} className="text-af-mid" /> Mover para outro funil
        </h3>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-slate-500 mb-1 block">Setor</label>
            <select
              value={departmentId}
              onChange={e => { setDepartmentId(e.target.value); setPipelineId(''); setStageId(''); }}
              className="w-full px-3 py-2 text-sm border border-af-border rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-af-accent"
            >
              <option value="">Selecione o setor</option>
              {departmentOptions.map(d => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>

          {departmentId && (
            <div>
              <label className="text-xs font-semibold text-slate-500 mb-1 block">Funil</label>
              <select
                value={pipelineId}
                onChange={e => { setPipelineId(e.target.value); setStageId(''); }}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-af-accent"
              >
                <option value="">Selecione o funil</option>
                {pipelinesInDepartment.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
              {pipelinesInDepartment.length === 0 && (
                <p className="text-xs text-slate-400 mt-1">Esse setor não tem outro funil além do atual.</p>
              )}
            </div>
          )}

          {selectedPipeline && (
            <div>
              <label className="text-xs font-semibold text-slate-500 mb-1 block">Etapa de entrada</label>
              <select
                value={stageId}
                onChange={e => setStageId(e.target.value)}
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
            {moving ? 'Movendo...' : 'Mover lead'}
          </button>
        </div>
      </div>
    </div>
  );
}
