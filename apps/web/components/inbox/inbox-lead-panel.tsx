'use client';
import { useState } from 'react';
import { LeadDetail, Stage } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { LeadSidebar } from '@/components/lead/lead-sidebar';
import { StageGateModal } from '@/components/kanban/stage-gate-modal';
import { getMissingFields, ValidationField } from '@/lib/stage-validation';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { ExternalLink, ChevronRight } from 'lucide-react';
import Link from 'next/link';

interface InboxLeadPanelProps {
  lead: LeadDetail;
  onRefresh: () => void;
}

export function InboxLeadPanel({ lead, onRefresh }: InboxLeadPanelProps) {
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

      <div className="w-80 flex-shrink-0 border-l border-af-border bg-white flex flex-col overflow-hidden">

        {/* ── Header do lead ── */}
        <div className="px-4 pt-4 pb-3 border-b border-af-border bg-af-light/30 flex-shrink-0">
          <div className="flex items-center justify-between mb-3">
            <span
              className="text-xs px-2 py-0.5 rounded-full text-white font-medium"
              style={{ backgroundColor: lead.stage.color }}
            >
              {lead.stage.name}
            </span>
            <Link
              href={`/leads/${lead.id}`}
              className="flex items-center gap-1 text-xs text-af-mid hover:text-af-dark transition-colors"
              title="Abrir lead completo"
            >
              Ver lead <ExternalLink size={12} />
            </Link>
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

        {/* ── Mini pipeline (barra de fluxo) ── */}
        <div className="px-3 py-3 border-b border-af-border flex-shrink-0">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Fluxo</p>
          <div className="flex flex-col gap-1 max-h-48 overflow-y-auto scrollbar-thin">
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

        {/* ── LeadSidebar completo (abas + campos editáveis) ── */}
        <div className="flex-1 overflow-hidden flex flex-col">
          <LeadSidebar lead={lead} onRefresh={onRefresh} />
        </div>
      </div>
    </>
  );
}
