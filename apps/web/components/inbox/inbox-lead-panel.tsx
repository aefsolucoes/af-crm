'use client';
import { useState } from 'react';
import { LeadDetail, Stage } from '@/types';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { LeadSidebar } from '@/components/lead/lead-sidebar';
import { LeadPlacementFields } from '@/components/lead/lead-placement-fields';
import { StageGateModal } from '@/components/kanban/stage-gate-modal';
import { getMissingFields, ValidationField } from '@/lib/stage-validation';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { ListChecks, LayoutList, PanelRightClose } from 'lucide-react';
import { LeadTasks } from '@/components/lead/lead-tasks';

interface InboxLeadPanelProps {
  lead: LeadDetail;
  onRefresh: () => void;
  /** Esconde o painel (some com a coluna toda) — pra quem quer mais espaço
   *  pra conversa. Volta por um botão que fica na borda (ver InboxPageInner). */
  onHide?: () => void;
  /** Override de classe do container raiz — usado no mobile pra virar um
   *  overlay full-screen em vez da coluna fixa de 384px do desktop. */
  className?: string;
}

export function InboxLeadPanel({ lead, onRefresh, onHide, className }: InboxLeadPanelProps) {
  const [activePanel, setActivePanel] = useState<'dados' | 'atividades'>('dados');
  const [changingStage, setChangingStage] = useState(false);
  const [gateOpen, setGateOpen]           = useState(false);
  const [gateMissing, setGateMissing]     = useState<ValidationField[]>([]);
  const [gateStageName, setGateStageName] = useState('');
  const [pendingStageId, setPendingStageId] = useState<string | null>(null);

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

      <div className={cn('w-96 flex-shrink-0 border-l border-af-border app-column-surface flex flex-col overflow-hidden', className)}>

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
              {onHide && (
                // Só existe quando InboxLeadPanel abre como popup no celular
                // (a barra fina de esconder/mostrar do desktop é outro botão,
                // em inbox/page.tsx). Ícone sozinho ficava discreto demais —
                // usuário pediu mais visível, igual referência que mandou
                // (círculo azul preenchido) — aqui funciona como "voltar" da
                // tela do Card pra conversa.
                <button
                  onClick={onHide}
                  className="flex-shrink-0 ml-1 w-8 h-8 rounded-full bg-[#3b82f6] hover:bg-[#2563eb] text-white flex items-center justify-center shadow-md transition-colors"
                  title="Voltar pra conversa"
                >
                  <PanelRightClose size={16} />
                </button>
              )}
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
            {/* Setor → Funil → Estágio — padrão do CRM pra trocar o lead de
                lugar (LeadPlacementFields), sem janela. */}
            <div className="px-3 py-2.5 border-b border-af-border flex-shrink-0">
              <LeadPlacementFields
                lead={lead}
                onRefresh={onRefresh}
                onStageChange={handleStageChange}
                changingStage={changingStage}
                layout="inline"
              />
            </div>

            {/* Campos editáveis — todos os dados */}
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
