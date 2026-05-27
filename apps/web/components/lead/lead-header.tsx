'use client';
import { LeadDetail, Pipeline, Stage, User } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { formatCurrency } from '@/lib/utils';
import { ChevronRight, Building2, DollarSign, Trophy, XCircle, RotateCcw, X, Plus, Archive, ArchiveRestore, Shuffle } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';

interface LeadHeaderProps {
  lead: LeadDetail;
  onStageChange: () => void;
}

export function LeadHeader({ lead, onStageChange }: LeadHeaderProps) {
  const [changing, setChanging] = useState(false);
  const [changingUser, setChangingUser] = useState(false);
  const [changingPipeline, setChangingPipeline] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [editingTags, setEditingTags] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [showPipelineModal, setShowPipelineModal] = useState(false);
  const [selectedPipelineId, setSelectedPipelineId] = useState('');
  const [selectedStageId, setSelectedStageId] = useState('');
  const router = useRouter();

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: async () => { const { data } = await api.get('/api/users'); return data; },
  });

  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => { const { data } = await api.get('/api/pipelines'); return data; },
  });

  const selectedPipeline = pipelines.find(p => p.id === selectedPipelineId);

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
      onStageChange();
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
      onStageChange();
    } catch {
      toast('Erro ao atualizar responsável', 'error');
    } finally {
      setChangingUser(false);
    }
  }

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
            {lead.status !== 'WON' && !lead.archived && (
              <button
                onClick={() => handleStatusChange('WON')}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors"
              >
                <Trophy size={12} /> Marcar Ganho
              </button>
            )}
            {lead.status !== 'LOST' && !lead.archived && (
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
            {/* Arquivar / Restaurar */}
            {!lead.archived ? (
              <button
                onClick={() => handleArchive(true)}
                disabled={archiving}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-amber-50 text-amber-700 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors disabled:opacity-50"
              >
                <Archive size={12} /> Arquivar lead
              </button>
            ) : (
              <button
                onClick={() => handleArchive(false)}
                disabled={archiving}
                className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors disabled:opacity-50"
              >
                <ArchiveRestore size={12} /> Restaurar lead
              </button>
            )}
          </div>

          <div className="text-right">
            <p className="text-xs text-slate-500 mb-1">Responsável</p>
            <div className="flex items-center gap-1.5">
              <Avatar name={lead.user?.name || '?'} size="sm" />
              <select
                value={lead.user?.id || ''}
                onChange={e => handleUserChange(e.target.value)}
                disabled={changingUser || users.length === 0}
                className="text-sm font-medium px-3 py-1.5 border border-af-border rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-af-accent cursor-pointer disabled:opacity-50"
              >
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="text-right">
            <p className="text-xs text-slate-500 mb-1">Funil atual</p>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-slate-700 bg-slate-100 px-3 py-1.5 rounded-lg">
                {lead.pipeline.name}
              </span>
              <button
                onClick={() => { setSelectedPipelineId(''); setSelectedStageId(''); setShowPipelineModal(true); }}
                className="p-1.5 border border-af-border rounded-lg text-slate-400 hover:text-af-mid hover:bg-af-light transition-colors"
                title="Mover para outro funil"
              >
                <Shuffle size={14} />
              </button>
            </div>
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
