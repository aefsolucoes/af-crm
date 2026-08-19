'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Stage, Lead } from '@/types';
import { KanbanCard } from './kanban-card';
import { ColorSwatches } from './color-swatches';
import { formatCurrency } from '@/lib/utils';
import { Plus } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';

interface KanbanColumnProps {
  stage: Stage;
  leads: Lead[];
  onAddLead: (stageId: string) => void;
  onOpenLead: (leadId: string) => void;
}

const STAGE_DESCRIPTIONS: Record<string, string> = {
  // Pipeline Principal — Financiamento Habitacional
  'Prospecção':              'Respondendo questionário / tirando dúvidas',
  'Qualificação':            'Lead qualificado — avaliando perfil e necessidade',
  'Proposta':                'Proposta enviada — aguardando retorno do cliente',
  'Negociação':              'Negociando condições — ajustando taxas e valores',
  'Follow Up':               'Não respondeu o questionário — acionar',
  'Aguardando Simulação':    'Questionário ok — realizar simulação',
  'Proposta Enviada':        'Proposta enviada — aguardando aprovação',
  'Aguardando Documentação': 'Aprovado — aguardando envio dos documentos',
  'Fechado':                 'Documentação encaminhada — concluído',
  // Pipeline Follow Up
  'Remarketing':       'Entrou após parar no funil de Vendas',
  'Promoção Enviada':  'Oferta / condição especial enviada',
  'Retomou Interesse': 'Reagiu — voltando para o funil de Vendas',
  'Descartado':        'Sem reação após tentativas',
  // Pipeline Fechamento
  'Documentação Recebida':   'Docs recebidos — processo de fechamento iniciado',
  'Crédito em Análise':      'Banco analisando a documentação',
  'Crédito Aprovado':        'Crédito aprovado — avançar para vistoria',
  'Vistoria do Imóvel':      'Vistoria técnica agendada / em andamento',
  'Análise Jurídica':        'Documentação no jurídico do banco',
  'Registro em Cartório':    'Escritura e registro de imóveis em andamento',
  'Pagamento ao Vendedor':   'Transferência liberada — negócio concluído',
};

export function KanbanColumn({ stage, leads, onAddLead, onOpenLead }: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(stage.name);
  const [editColor, setEditColor] = useState(stage.color);
  const [saving, setSaving] = useState(false);

  const totalValue = leads.reduce((sum, l) => sum + (l.value || 0), 0);
  const description = STAGE_DESCRIPTIONS[stage.name];

  function openEdit() {
    setEditName(stage.name);
    setEditColor(stage.color);
    setEditing(true);
  }

  async function saveEdit() {
    const name = editName.trim();
    if (!name) return;
    setSaving(true);
    try {
      await api.patch(`/api/pipelines/${stage.pipelineId}/stages/${stage.id}`, { name, color: editColor });
      queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      setEditing(false);
      toast('Etapa atualizada!');
    } catch {
      toast('Erro ao atualizar etapa', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col w-72 flex-shrink-0 h-full">
      {/* Cabeçalho do estágio — único bloco com o fundo translúcido */}
      <div className="rounded-xl app-column-surface shadow-md px-3 pt-3 pb-2 flex-shrink-0">
        {editing ? (
          <div className="space-y-2">
            <div className="flex items-center gap-1">
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditing(false); }}
                className="flex-1 min-w-0 text-sm px-2 py-1 border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent"
              />
              <button onClick={saveEdit} disabled={saving || !editName.trim()} className="text-green-600 hover:text-green-700 disabled:opacity-40 flex-shrink-0 text-xs font-semibold px-1.5">
                Salvar
              </button>
              <button onClick={() => setEditing(false)} className="text-slate-400 hover:text-slate-600 flex-shrink-0 text-xs px-1">
                Cancelar
              </button>
            </div>
            <ColorSwatches value={editColor} onChange={setEditColor} />
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <button
              onClick={openEdit}
              className="flex items-center gap-2 min-w-0 hover:opacity-80 transition-opacity text-left"
              title="Editar nome/cor da etapa"
            >
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: stage.color }} />
              <span className="text-sm font-bold text-slate-800 truncate">{stage.name}</span>
              <span className="text-xs bg-slate-200/80 text-slate-600 px-1.5 py-0.5 rounded-full font-semibold flex-shrink-0">
                {leads.length}
              </span>
            </button>
            <button
              onClick={() => onAddLead(stage.id)}
              className="text-slate-400 hover:text-af-mid hover:bg-af-light rounded p-0.5 transition-colors flex-shrink-0"
              title="Adicionar lead"
            >
              <Plus size={16} />
            </button>
          </div>
        )}

        {/* Descrição do estágio */}
        {!editing && description && (
          <p className="text-[11px] text-slate-400 leading-tight mt-1">{description}</p>
        )}

        {/* Total */}
        {!editing && totalValue > 0 && (
          <div className="text-xs text-slate-500 mt-1 font-medium">{formatCurrency(totalValue)}</div>
        )}
      </div>

      {/* Corpo — transparente (mostra o fundo). Os cards têm fundo próprio. */}
      <SortableContext items={leads.map((l) => l.id)} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`flex flex-col gap-2 min-h-[60px] pt-2 flex-1 min-h-0 overflow-y-auto scrollbar-thin transition-colors rounded-xl ${
            isOver ? 'bg-af-light/40' : ''
          }`}
        >
          {leads.map((lead) => (
            <KanbanCard key={lead.id} lead={lead} labelColor={stage.color} onOpen={onOpenLead} />
          ))}

          {/* Adicionar cartão — rola junto com os cards */}
          <button
            onClick={() => onAddLead(stage.id)}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium text-slate-600 hover:bg-white/40 hover:text-slate-800 transition-colors"
          >
            <Plus size={14} /> Adicionar um cartão
          </button>
        </div>
      </SortableContext>
    </div>
  );
}
