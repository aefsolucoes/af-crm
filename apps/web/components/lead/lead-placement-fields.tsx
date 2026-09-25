'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LeadDetail, Pipeline, Stage } from '@/types';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

const NO_DEPARTMENT = '__none__';

interface LeadPlacementFieldsProps {
  lead: LeadDetail;
  onRefresh: () => void;
  /** Troca de estágio dentro do MESMO funil — quem chama cuida do aviso de
   *  campos obrigatórios (StageGateModal). */
  onStageChange: (stageId: string) => void;
  changingStage?: boolean;
  /** inline = rótulo ao lado (painel da Inbox); stacked = rótulo em cima
   *  (detalhe do lead no Funil). */
  layout?: 'inline' | 'stacked';
}

/** Padrão do CRM pra trocar um lead de lugar (pedido do usuário 2026-09-25):
 *  Setor → Funil → Estágio editáveis ali mesmo, sem janela. Trocar o setor
 *  (ou o funil) zera os campos seguintes; o lead só muda de lugar quando o
 *  estágio é escolhido. */
export function LeadPlacementFields({ lead, onRefresh, onStageChange, changingStage, layout = 'inline' }: LeadPlacementFieldsProps) {
  const { data: departments = [] } = useQuery({
    queryKey: ['departments'],
    queryFn: async () => (await api.get('/api/departments')).data as { id: string; name: string }[],
  });
  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => (await api.get('/api/pipelines')).data,
  });

  const currentDepartment = lead.pipeline.department?.id || NO_DEPARTMENT;
  const [draftDepartment, setDraftDepartment] = useState<string | null>(null);
  const [draftPipeline, setDraftPipeline] = useState('');
  const [moving, setMoving] = useState(false);

  useEffect(() => { setDraftDepartment(null); setDraftPipeline(''); }, [lead.id, lead.pipelineId]);

  const editing = draftDepartment !== null;
  const departmentValue = editing ? draftDepartment : currentDepartment;
  // Funis sem setor (a Caixa de Entrada global) entram como um "setor" à
  // parte — mesmo rótulo do seletor principal do Funil.
  const hasOrphanPipelines = pipelines.some((p) => !p.department) || !lead.pipeline.department;
  const departmentOptions = [
    ...departments,
    ...(hasOrphanPipelines ? [{ id: NO_DEPARTMENT, name: 'Caixa de Entrada' }] : []),
  ];
  const pipelineOptions = pipelines.filter((p) =>
    departmentValue === NO_DEPARTMENT ? !p.department : p.department?.id === departmentValue
  );
  const draftStages = pipelines.find((p) => p.id === draftPipeline)?.stages || [];

  function cancel() {
    setDraftDepartment(null);
    setDraftPipeline('');
  }

  function changeDepartment(value: string) {
    if (!editing && value === currentDepartment) return;
    setDraftDepartment(value);
    setDraftPipeline('');
  }

  function changePipeline(value: string) {
    if (!editing && value === lead.pipelineId) return;
    setDraftDepartment(departmentValue);
    setDraftPipeline(value);
  }

  async function changeStage(stageId: string) {
    if (!editing) return onStageChange(stageId);
    if (!draftPipeline || !stageId) return;
    if (draftPipeline === lead.pipelineId) {
      cancel();
      return onStageChange(stageId);
    }
    setMoving(true);
    try {
      await api.patch(`/api/leads/${lead.id}/pipeline`, { pipelineId: draftPipeline, stageId });
      const target = pipelines.find((p) => p.id === draftPipeline);
      toast(`Lead movido para "${target?.name}"!`);
      cancel();
      onRefresh();
    } catch {
      toast('Erro ao mover lead', 'error');
    } finally {
      setMoving(false);
    }
  }

  const baseSelect = 'w-full min-w-0 text-xs font-semibold rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-af-accent cursor-pointer disabled:opacity-60';
  const neutralSelect = cn(baseSelect, 'border border-af-border bg-white text-slate-700');

  const row = (label: string, children: ReactNode) =>
    layout === 'inline' ? (
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex-shrink-0 w-14">{label}</span>
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    ) : (
      <div>
        <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">{label}</p>
        {children}
      </div>
    );

  return (
    <div className={layout === 'inline' ? 'space-y-2' : 'space-y-3'}>
      {row('Setor', (
        <select value={departmentValue} onChange={(e) => changeDepartment(e.target.value)} disabled={moving} className={neutralSelect}>
          {departmentOptions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      ))}

      {row('Funil', (
        <select
          value={editing ? draftPipeline : lead.pipelineId}
          onChange={(e) => changePipeline(e.target.value)}
          disabled={moving}
          className={cn(neutralSelect, editing && !draftPipeline && 'ring-2 ring-af-accent/40')}
        >
          {editing && <option value="">Selecione o funil</option>}
          {pipelineOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      ))}

      {row('Estágio', editing ? (
          <select
            value=""
            onChange={(e) => changeStage(e.target.value)}
            disabled={moving || !draftPipeline}
            className={cn(neutralSelect, draftPipeline && 'ring-2 ring-af-accent/40')}
          >
            <option value="">{draftPipeline ? 'Selecione o estágio' : 'Escolha o funil primeiro'}</option>
            {draftStages.map((s: Stage) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        ) : (
          <select
            value={lead.stageId}
            disabled={changingStage}
            onChange={(e) => changeStage(e.target.value)}
            className={cn(baseSelect, 'border-0 text-white')}
            style={{ backgroundColor: lead.stage.color }}
          >
            {lead.pipeline.stages.map((s: Stage) => (
              <option key={s.id} value={s.id} style={{ color: '#0f172a', backgroundColor: '#fff' }}>{s.name}</option>
            ))}
          </select>
        ))}

      {editing && (
        <div className="flex justify-end">
          <button onClick={cancel} disabled={moving} className="text-[11px] text-slate-400 hover:text-slate-600 underline">
            Cancelar troca
          </button>
        </div>
      )}
    </div>
  );
}
