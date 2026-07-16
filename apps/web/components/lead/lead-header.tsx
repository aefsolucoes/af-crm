'use client';
import { LeadDetail } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils';
import { Building2, DollarSign, Trophy, XCircle, RotateCcw, X, Plus, Archive, ArchiveRestore } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface LeadHeaderProps {
  lead: LeadDetail;
  onStageChange: () => void;
}

// Paleta de labels estilo Trello — cor sólida por tag, escolhida por hash do nome
const TAG_COLORS = ['#61bd4f', '#f2d600', '#ff9f1a', '#eb5a46', '#c377e0', '#0079bf', '#00c2e0', '#51e898', '#ff78cb', '#344563'];
function tagColor(tag: string) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

export function LeadHeader({ lead, onStageChange }: LeadHeaderProps) {
  const [tagInput, setTagInput] = useState('');
  const [editingTags, setEditingTags] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const router = useRouter();

  async function handleArchive(archive: boolean) {
    if (archive && !confirm('Arquivar este lead? Ele não aparecerá mais no funil, mas pode ser restaurado depois.')) return;
    setArchiving(true);
    try {
      await api.patch(`/api/leads/${lead.id}/archive`, { archived: archive });
      toast(archive ? 'Lead arquivado' : 'Lead restaurado!');
      if (archive) router.back();
      else onStageChange();
    } catch {
      toast('Erro ao arquivar lead', 'error');
    } finally {
      setArchiving(false);
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
    <div className="px-6 py-4 bg-white border-b border-af-border space-y-4">
      {/* Linha 1: identidade + valor */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar name={lead.name} size="lg" className="w-12 h-12" />
          <div className="min-w-0">
            <h1 className="text-2xl font-extrabold text-slate-900 truncate leading-tight">{lead.name}</h1>
            {lead.company && (
              <div className="flex items-center gap-1 text-xs text-slate-500 mt-1">
                <Building2 size={12} />
                <span className="truncate">{lead.company.name}</span>
              </div>
            )}
          </div>
        </div>

        {lead.value && (
          <div className="text-right flex-shrink-0">
            <p className="text-xs text-slate-400 flex items-center gap-1 justify-end"><DollarSign size={11} />Valor</p>
            <p className="text-xl font-extrabold text-af-mid leading-tight">{formatCurrency(lead.value)}</p>
          </div>
        )}
      </div>

      {/* Linha 2: tags (estilo label do Trello) + status */}
      <div className="flex items-center flex-wrap gap-1.5">
        <Badge
          color={lead.status === 'WON' ? '#10b981' : lead.status === 'LOST' ? '#ef4444' : '#6b7280'}
        >
          {lead.status === 'WON' ? 'Ganho' : lead.status === 'LOST' ? 'Perdido' : 'Aberto'}
        </Badge>
        {lead.tags.map((tag) => (
          <span
            key={tag}
            className="group flex items-center gap-1.5 text-xs font-semibold text-white px-2.5 py-1 rounded-md shadow-sm"
            style={{ backgroundColor: tagColor(tag) }}
          >
            {tag}
            <button onClick={() => handleRemoveTag(tag)} className="opacity-0 group-hover:opacity-100 hover:text-slate-900 transition-opacity">
              <X size={10} />
            </button>
          </span>
        ))}
        {editingTags ? (
          <div className="flex items-center gap-1">
            <input
              autoFocus
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddTag(); if (e.key === 'Escape') { setEditingTags(false); setTagInput(''); } }}
              placeholder="nova tag"
              className="text-xs border border-af-border rounded-md px-2 py-1 w-24 focus:outline-none focus:border-af-mid"
            />
            <button onClick={handleAddTag} className="text-xs text-af-mid hover:text-af-dark font-medium">+</button>
            <button onClick={() => { setEditingTags(false); setTagInput(''); }} className="text-xs text-slate-400">✕</button>
          </div>
        ) : (
          <button onClick={() => setEditingTags(true)} className="text-xs text-slate-500 hover:text-af-mid flex items-center gap-1 border border-dashed border-slate-300 hover:border-af-mid rounded-md px-2.5 py-1 transition-colors font-medium">
            <Plus size={11} /> Etiqueta
          </button>
        )}
      </div>

      {/* Linha 3: ações de status — compactas, em linha */}
      <div className="flex items-center flex-wrap gap-1.5">
        {lead.status !== 'WON' && !lead.archived && (
          <button
            onClick={() => handleStatusChange('WON')}
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors"
          >
            <Trophy size={12} /> Marcar Ganho
          </button>
        )}
        {lead.status !== 'LOST' && !lead.archived && (
          <button
            onClick={() => handleStatusChange('LOST')}
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 rounded-lg transition-colors"
          >
            <XCircle size={12} /> Marcar Perdido
          </button>
        )}
        {(lead.status === 'WON' || lead.status === 'LOST') && (
          <button
            onClick={() => handleStatusChange('OPEN')}
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 bg-slate-50 text-slate-600 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors"
          >
            <RotateCcw size={12} /> Reabrir
          </button>
        )}
        {!lead.archived ? (
          <button
            onClick={() => handleArchive(true)}
            disabled={archiving}
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors disabled:opacity-50"
          >
            <Archive size={12} /> Arquivar lead
          </button>
        ) : (
          <button
            onClick={() => handleArchive(false)}
            disabled={archiving}
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors disabled:opacity-50"
          >
            <ArchiveRestore size={12} /> Restaurar lead
          </button>
        )}
      </div>
    </div>
  );
}
