'use client';
import { LeadDetail, Stage } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils';
import { ChevronRight, Building2, DollarSign } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { useState } from 'react';

interface LeadHeaderProps {
  lead: LeadDetail;
  onStageChange: () => void;
}

export function LeadHeader({ lead, onStageChange }: LeadHeaderProps) {
  const [changing, setChanging] = useState(false);

  async function handleStageChange(stageId: string) {
    setChanging(true);
    try {
      await api.patch(`/api/leads/${lead.id}/stage`, { stageId });
      toast('Estágio atualizado!');
      onStageChange();
    } catch {
      toast('Erro ao atualizar estágio', 'error');
    } finally {
      setChanging(false);
    }
  }

  return (
    <div className="px-6 py-5 bg-white border-b border-af-border">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Avatar name={lead.name} size="lg" />
          <div>
            <h1 className="text-xl font-bold text-slate-900">{lead.name}</h1>
            {lead.company && (
              <div className="flex items-center gap-1 text-sm text-slate-500 mt-0.5">
                <Building2 size={13} />
                {lead.company.name}
              </div>
            )}
            <div className="flex items-center gap-2 mt-2">
              {lead.tags.map((tag) => (
                <Badge key={tag} className="bg-af-light text-af-mid">{tag}</Badge>
              ))}
              <Badge
                className="text-white"
                style={{ backgroundColor: lead.status === 'WON' ? '#10b981' : lead.status === 'LOST' ? '#ef4444' : '#6b7280' }}
              >
                {lead.status === 'WON' ? 'Ganho' : lead.status === 'LOST' ? 'Perdido' : 'Aberto'}
              </Badge>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {lead.value && (
            <div className="text-right">
              <p className="text-xs text-slate-500 flex items-center gap-1 justify-end"><DollarSign size={12} />Valor</p>
              <p className="text-xl font-bold text-af-mid">{formatCurrency(lead.value)}</p>
            </div>
          )}

          <div className="text-right">
            <p className="text-xs text-slate-500 mb-1">Estágio atual</p>
            <select
              value={lead.stageId}
              onChange={(e) => handleStageChange(e.target.value)}
              disabled={changing}
              className="text-sm font-medium px-3 py-1.5 border border-af-border rounded-lg bg-white text-af-mid focus:outline-none focus:ring-2 focus:ring-af-accent cursor-pointer"
            >
              {lead.pipeline.stages.map((s: Stage) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Pipeline breadcrumb */}
      <div className="flex items-center gap-1 mt-4 overflow-x-auto scrollbar-thin pb-1">
        {lead.pipeline.stages.map((s: Stage, i: number) => (
          <div key={s.id} className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => handleStageChange(s.id)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                s.id === lead.stageId ? 'text-white' : 'bg-slate-100 text-slate-500 hover:bg-af-light hover:text-af-mid'
              }`}
              style={s.id === lead.stageId ? { backgroundColor: s.color } : {}}
            >
              {s.name}
            </button>
            {i < lead.pipeline.stages.length - 1 && <ChevronRight size={12} className="text-slate-300" />}
          </div>
        ))}
      </div>
    </div>
  );
}
