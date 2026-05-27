'use client';
import { LeadDetail, Stage } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils';
import { ChevronRight, Building2, DollarSign, Trophy, XCircle, RotateCcw, X, Plus } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { useState } from 'react';

interface LeadHeaderProps {
  lead: LeadDetail;
  onStageChange: () => void;
}

export function LeadHeader({ lead, onStageChange }: LeadHeaderProps) {
  const [changing, setChanging] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [editingTags, setEditingTags] = useState(false);

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

  async function handleStatusChange(status: 'OPEN' | 'WON' | 'LOST') {
    try {
      await api.put(`/api/leads/${lead.id}`, { status });
      toast(status === 'WON' ? '🏆 Lead marcado como Ganho!' : status === 'LOST' ? 'Lead marcado como Perdido' : 'Lead reaberto');
      onStageChange();
    } catch {
      toast('Erro ao atualizar status', 'error');
    }
  }

  async function handleRemoveTag(tag: string) {
    try {
      const newTags = lead.tags.filter(t => t !== tag);
      await api.put(`/api/leads/${lead.id}`, { tags: newTags });
      toast('Tag removida');
      onStageChange();
    } catch {
      toast('Erro ao remover tag', 'error');
    }
  }

  async function handleAddTag() {
    const tag = tagInput.trim();
    if (!tag || lead.tags.includes(tag)) { setTagInput(''); return; }
    try {
      await api.put(`/api/leads/${lead.id}`, { tags: [...lead.tags, tag] });
      setTagInput('');
      toast('Tag adicionada');
      onStageChange();
    } catch {
      toast('Erro ao adicionar tag', 'error');
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
            {/* Tags */}
            <div className="flex items-center flex-wrap gap-1.5 mt-2">
              {lead.tags.map((tag) => (
                <span key={tag} className="group flex items-center gap-1 text-xs bg-af-light text-af-mid px-2 py-0.5 rounded-full">
                  {tag}
                  <button onClick={() => handleRemoveTag(tag)} className="opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity">
                    <X size={10} />
                  </button>
                </span>
              ))}
              <Badge
                color={lead.status === 'WON' ? '#10b981' : lead.status === 'LOST' ? '#ef4444' : '#6b7280'}
              >
                {lead.status === 'WON' ? 'Ganho' : lead.status === 'LOST' ? 'Perdido' : 'Aberto'}
              </Badge>
              {/* Add tag inline */}
              {editingTags ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAddTag(); if (e.key === 'Escape') { setEditingTags(false); setTagInput(''); } }}
                    placeholder="nova tag"
                    className="text-xs border border-af-border rounded-full px-2 py-0.5 w-20 focus:outline-none focus:border-af-mid"
                  />
                  <button onClick={handleAddTag} className="text-xs text-af-mid hover:text-af-dark font-medium">+</button>
                  <button onClick={() => { setEditingTags(false); setTagInput(''); }} className="text-xs text-slate-400">✕</button>
                </div>
              ) : (
                <button onClick={() => setEditingTags(true)} className="text-xs text-slate-400 hover:text-af-mid flex items-center gap-0.5 border border-dashed border-slate-300 hover:border-af-mid rounded-full px-2 py-0.5 transition-colors">
                  <Plus size={10} /> tag
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 flex-shrink-0">
          {lead.value && (
            <div className="text-right">
              <p className="text-xs text-slate-500 flex items-center gap-1 justify-end"><DollarSign size={12} />Valor</p>
              <p className="text-xl font-bold text-af-mid">{formatCurrency(lead.value)}</p>
            </div>
          )}

          {/* Status actions */}
          <div className="flex flex-col gap-1.5">
            {lead.status !== 'WON' && (
              <button
                onClick={() => handleStatusChange('WON')}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors"
              >
                <Trophy size={12} /> Marcar Ganho
              </button>
            )}
            {lead.status !== 'LOST' && (
              <button
                onClick={() => handleStatusChange('LOST')}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 rounded-lg transition-colors"
              >
                <XCircle size={12} /> Marcar Perdido
              </button>
            )}
            {(lead.status === 'WON' || lead.status === 'LOST') && (
              <button
                onClick={() => handleStatusChange('OPEN')}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-slate-50 text-slate-600 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors"
              >
                <RotateCcw size={12} /> Reabrir
              </button>
            )}
          </div>

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
