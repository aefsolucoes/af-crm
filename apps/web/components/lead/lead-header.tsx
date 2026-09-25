'use client';
import { LeadDetail } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { formatCurrency } from '@/lib/utils';
import { Building2, DollarSign, Trophy, XCircle, RotateCcw, X, Plus, Archive, ArchiveRestore } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

interface LeadHeaderProps {
  lead: LeadDetail;
  onStageChange: () => void;
  /** Chamado quando o lead é arquivado — só quando este componente é usado
   *  DENTRO de um modal (Kanban/Inbox → LeadDetailModal), pra fechar o
   *  modal e atualizar a lista de baixo, sem navegar a página inteira pra
   *  outro lugar. Quando ausente (uso na página standalone /leads/[id]),
   *  cai no comportamento antigo — vai pro Funil. */
  onArchived?: () => void;
  /** false = esconde as etiquetas, mantendo o status (o painel da Inbox já mostra as
   *  tags embaixo, na aba Dados). */
  showTags?: boolean;
  /** Painel estreito da Inbox: status e ações numa linha só, rótulos curtos
   *  ("Ganho", "Perdido", "Arquivar") e letra menor. */
  compact?: boolean;
}

// Paleta de labels estilo Trello — cor sólida por tag, escolhida por hash do nome
const TAG_COLORS = ['#61bd4f', '#f2d600', '#ff9f1a', '#eb5a46', '#c377e0', '#0079bf', '#00c2e0', '#51e898', '#ff78cb', '#344563'];
function tagColor(tag: string) {
  let hash = 0;
  for (let i = 0; i < tag.length; i++) hash = tag.charCodeAt(i) + ((hash << 5) - hash);
  return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

/** Linha 1: identidade + valor — fica no topo do modal, ocupando toda a largura */
export function LeadHeaderTop({ lead }: { lead: LeadDetail }) {
  return (
    <div className="px-6 py-3 bg-white border-b border-af-border">
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
    </div>
  );
}

/** Linhas 2 e 3: etiquetas + ações de status — ficam acima da aba Dados, na coluna da esquerda */
export function LeadHeaderActions({ lead, onStageChange, onArchived, showTags = true, compact = false }: LeadHeaderProps) {
  const [tagInput, setTagInput] = useState('');
  const [editingTags, setEditingTags] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const router = useRouter();
  // Marcar Perdido pede o motivo antes de confirmar — sem isso o card só
  // ganhava uma etiqueta "Perdido" e ficava perdido de vista dentro do
  // próprio funil, sem registrar por quê.
  const [showLostModal, setShowLostModal] = useState(false);
  const [lostReasonInput, setLostReasonInput] = useState('');
  const [savingLost, setSavingLost] = useState(false);

  async function handleArchive(archive: boolean) {
    if (archive && !confirm('Arquivar este lead? Ele não aparecerá mais no funil, mas pode ser restaurado depois.')) return;
    setArchiving(true);
    try {
      await api.patch(`/api/leads/${lead.id}/archive`, { archived: archive });
      toast(archive ? 'Lead arquivado' : 'Lead restaurado!');
      if (archive) {
        if (onArchived) {
          // Uso dentro de modal (Kanban ou painel da Inbox → LeadDetailModal)
          // — NUNCA navega a página inteira. Só fecha o modal/atualiza a
          // lista de baixo, senão arquivar um lead pela Inbox jogava o
          // usuário pro Funil no meio do que ele estava fazendo.
          onArchived();
        } else {
          // Página standalone (/leads/[id]) — router.back() saía daqui pra
          // QUALQUER lugar do histórico do navegador (inclusive telas sem
          // nenhuma relação, tipo Configurações, se foi a última aba
          // visitada antes de abrir este lead por um link). Destino fixo e
          // previsível: o funil, que é exatamente onde o próprio aviso
          // acima diz que o lead deixa de aparecer.
          router.push('/funil');
        }
      } else {
        onStageChange();
      }
    } catch {
      toast('Erro ao arquivar lead', 'error');
    } finally {
      setArchiving(false);
    }
  }

  async function handleStatusChange(status: 'OPEN' | 'WON') {
    try {
      await api.put(`/api/leads/${lead.id}`, { status });
      toast(status === 'WON' ? '🏆 Lead marcado como Ganho!' : 'Lead reaberto');
      onStageChange();
    } catch {
      toast('Erro ao atualizar status', 'error');
    }
  }

  async function confirmMarkLost() {
    if (!lostReasonInput.trim()) { toast('Diga o motivo da perda', 'warning'); return; }
    setSavingLost(true);
    try {
      await api.put(`/api/leads/${lead.id}`, { status: 'LOST', lostReason: lostReasonInput.trim() });
      toast('Lead marcado como Perdido');
      setShowLostModal(false);
      setLostReasonInput('');
      onStageChange();
    } catch {
      toast('Erro ao atualizar status', 'error');
    } finally {
      setSavingLost(false);
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

  // Pedido do Fabio: status + Ganho/Perdido/Arquivar numa linha só, rótulos
  // curtos — igual em todo lugar (painel da Inbox, card do Funil, página do
  // lead). `compact` só aperta o respiro lateral (painel estreito da Inbox).
  const btn = 'flex-shrink-0 flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 border rounded-md transition-colors disabled:opacity-50';
  const icon = 11;

  return (
    <div className={`${compact ? 'px-3' : 'px-4'} py-2 bg-white border-b border-af-border flex-shrink-0 space-y-1.5`}>
      {/* Linha 1: status + ações */}
      <div className="flex items-center flex-nowrap gap-1.5 overflow-x-auto scrollbar-none">
        <Badge
          color={lead.status === 'WON' ? '#10b981' : lead.status === 'LOST' ? '#ef4444' : '#6b7280'}
          className="flex-shrink-0 text-[11px] mr-0.5"
        >
          {lead.status === 'WON' ? 'Ganho' : lead.status === 'LOST' ? 'Perdido' : 'Aberto'}
        </Badge>
        {lead.status !== 'WON' && !lead.archived && (
          <button
            onClick={() => handleStatusChange('WON')}
            className={`${btn} bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-200`}
          >
            <Trophy size={icon} /> Ganho
          </button>
        )}
        {lead.status !== 'LOST' && !lead.archived && (
          <button
            onClick={() => setShowLostModal(true)}
            className={`${btn} bg-red-50 text-red-600 hover:bg-red-100 border-red-200`}
          >
            <XCircle size={icon} /> Perdido
          </button>
        )}
        {(lead.status === 'WON' || lead.status === 'LOST') && (
          <button
            onClick={() => handleStatusChange('OPEN')}
            className={`${btn} bg-slate-50 text-slate-600 hover:bg-slate-100 border-slate-200`}
          >
            <RotateCcw size={icon} /> Reabrir
          </button>
        )}
        {!lead.archived ? (
          <button
            onClick={() => handleArchive(true)}
            disabled={archiving}
            className={`${btn} bg-amber-50 text-amber-700 hover:bg-amber-100 border-amber-200`}
          >
            <Archive size={icon} /> Arquivar
          </button>
        ) : (
          <button
            onClick={() => handleArchive(false)}
            disabled={archiving}
            className={`${btn} bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-200`}
          >
            <ArchiveRestore size={icon} /> Restaurar
          </button>
        )}
      </div>

      {lead.status === 'LOST' && lead.lostReason && (
        <p className="text-[11px] text-slate-500 italic truncate" title={lead.lostReason}>Motivo: {lead.lostReason}</p>
      )}

      {/* Linha 2: etiquetas (estilo label do Trello) — fora do painel da Inbox */}
      {showTags && (
        <div className="flex items-center flex-wrap gap-1">
          {lead.tags.map((tag) => (
            <span
              key={tag}
              className="group flex items-center gap-1 text-[11px] font-semibold text-white px-2 py-0.5 rounded-md shadow-sm"
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
                className="text-xs border border-af-border rounded-md px-2 py-0.5 w-24 focus:outline-none focus:border-af-mid"
              />
              <button onClick={handleAddTag} className="text-xs text-af-mid hover:text-af-dark font-medium">+</button>
              <button onClick={() => { setEditingTags(false); setTagInput(''); }} className="text-xs text-slate-400">✕</button>
            </div>
          ) : (
            <button onClick={() => setEditingTags(true)} className="text-[11px] text-slate-500 hover:text-af-mid flex items-center gap-1 border border-dashed border-slate-300 hover:border-af-mid rounded-md px-2 py-0.5 transition-colors font-medium">
              <Plus size={10} /> Etiqueta
            </button>
          )}
        </div>
      )}

      <Modal open={showLostModal} onClose={() => setShowLostModal(false)} title="Marcar como Perdido" size="sm">
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium text-slate-700 mb-1 block">Motivo da perda</label>
            <textarea
              autoFocus
              value={lostReasonInput}
              onChange={(e) => setLostReasonInput(e.target.value)}
              placeholder="Ex: preço, escolheu concorrente, não respondeu mais, sem crédito aprovado..."
              rows={3}
              className="w-full text-sm px-3 py-2 border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowLostModal(false)} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
            <button
              onClick={confirmMarkLost}
              disabled={savingLost || !lostReasonInput.trim()}
              className="text-sm px-4 py-2 rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {savingLost ? 'Salvando...' : 'Marcar Perdido'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
