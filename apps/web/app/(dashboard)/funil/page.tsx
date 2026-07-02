'use client';
import { useEffect, useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { Button } from '@/components/ui/button';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { CardSkeleton } from '@/components/ui/skeleton';
import { usePipelineStore } from '@/store/pipeline.store';
import { LeadModal } from '@/components/kanban/lead-modal';
import { Pipeline, Lead, Contact, User } from '@/types';
import api from '@/lib/api';
import { Plus, RefreshCw, Search, X } from 'lucide-react';
import { getSocket } from '@/lib/socket';

// Ordem fixa dos pipelines
const PIPELINE_ORDER = ['Vendas', 'Fechamento', 'Follow Up'];

async function fetchPipelines(): Promise<Pipeline[]> {
  const { data } = await api.get('/api/pipelines');
  return data;
}

async function fetchLeads(pipelineId: string): Promise<Lead[]> {
  const { data } = await api.get(`/api/leads?pipelineId=${pipelineId}`);
  return data;
}

async function fetchAllLeads(): Promise<Lead[]> {
  const { data } = await api.get('/api/leads');
  return data;
}

async function fetchContacts(): Promise<Contact[]> {
  const { data } = await api.get('/api/contacts');
  return data;
}

export default function FunilPage() {
  const { leads: storeLeads, setLeads, moveLeadOptimistic } = usePipelineStore();
  const [openAddLead, setOpenAddLead] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>('');
  const queryClient = useQueryClient();

  // Atualiza o kanban em tempo real quando chega nova mensagem WhatsApp
  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();

    function onNewNotification() {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['leads-all'] });
    }

    socket.on('new_notification', onNewNotification);
    return () => { socket.off('new_notification', onNewNotification); };
  }, [queryClient]);

  const { data: pipelines, isLoading: loadingPipelines } = useQuery({
    queryKey: ['pipelines'],
    queryFn: fetchPipelines,
  });

  // Pipelines ordenados: Vendas → Fechamento → Follow Up
  const sortedPipelines = useMemo(() => {
    if (!pipelines) return [];
    return [...pipelines].sort((a, b) => {
      const ai = PIPELINE_ORDER.indexOf(a.name);
      const bi = PIPELINE_ORDER.indexOf(b.name);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [pipelines]);

  const pipeline = sortedPipelines.find(p => p.id === selectedPipelineId) || sortedPipelines[0];

  useEffect(() => {
    if (sortedPipelines[0] && !selectedPipelineId) {
      setSelectedPipelineId(sortedPipelines[0].id);
    }
  }, [sortedPipelines]);

  // Leads do pipeline atual
  const { data: rawLeads, isLoading: loadingLeads, refetch } = useQuery({
    queryKey: ['leads', selectedPipelineId],
    queryFn: () => fetchLeads(selectedPipelineId),
    enabled: !!selectedPipelineId && !search.trim(),
  });

  // Todos os leads (para busca cross-pipeline)
  const { data: allRawLeads, refetch: refetchAll } = useQuery({
    queryKey: ['leads-all'],
    queryFn: fetchAllLeads,
    enabled: !!search.trim(),
  });

  const { data: contacts = [] } = useQuery({ queryKey: ['contacts'], queryFn: fetchContacts });

  // Sincroniza store com rawLeads para drag otimista
  useEffect(() => {
    if (rawLeads) setLeads(rawLeads);
  }, [rawLeads, setLeads]);

  // Leads para exibição: se pesquisando usa todos os funis, senão usa pipeline atual
  // Aplica updates otimísticos do store por cima dos dados do servidor
  const displayLeads = useMemo(() => {
    const baseLeads = search.trim() ? (allRawLeads || []) : (rawLeads || []);

    if (!search.trim() && storeLeads.length > 0) {
      // Aplica updates otimísticos (drag-and-drop) sem perder novos leads do servidor
      return baseLeads.map(lead => {
        const storeLead = storeLeads.find(l => l.id === lead.id);
        if (storeLead && storeLead.stageId !== lead.stageId) {
          return { ...lead, stageId: storeLead.stageId };
        }
        return lead;
      });
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      return baseLeads.filter(l => {
        const cf = (l.customFields || {}) as Record<string, string>;
        return (
          l.name.toLowerCase().includes(q) ||
          (cf.participante_1 || '').toLowerCase().includes(q) ||
          (cf.participante_2 || '').toLowerCase().includes(q) ||
          (cf.telefone_1 || '').includes(q) ||
          (cf.telefone_2 || '').includes(q) ||
          (l.contact?.name ?? '').toLowerCase().includes(q) ||
          (l.contact?.phone ?? '').includes(q) ||
          l.tags.some(t => t.toLowerCase().includes(q))
        );
      });
    }

    return baseLeads;
  }, [rawLeads, allRawLeads, storeLeads, search]);

  // Usuários únicos extraídos dos leads
  const users: User[] = useMemo(() =>
    Array.from(new Map(displayLeads.map(l => [l.user.id, l.user as unknown as User])).values()),
    [displayLeads]
  );

  const isLoading = loadingPipelines || (loadingLeads && !search.trim());

  function handleRefetch() {
    refetch();
    if (search.trim()) refetchAll();
  }

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Funil de Vendas" subtitle={search.trim() ? 'Todos os funis' : pipeline?.name} />

      <div className="flex items-center justify-between px-6 py-3 app-topbar-surface border-b gap-4">
        <div className="flex items-center gap-3 flex-1">
          {/* Seletor de pipeline (oculto durante busca) */}
          {!search.trim() && pipeline && (
            <select
              value={selectedPipelineId}
              onChange={e => setSelectedPipelineId(e.target.value)}
              className="text-sm border border-af-border rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-af-accent flex-shrink-0"
            >
              {sortedPipelines.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}

          {/* Busca global */}
          <div className="relative flex-1 max-w-sm">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Buscar em todos os funis..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-8 py-1.5 text-sm border border-af-border rounded-lg bg-af-light text-slate-700 focus:outline-none focus:ring-1 focus:ring-af-accent placeholder:text-slate-400"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                <X size={13} />
              </button>
            )}
          </div>
          {search && (
            <span className="text-xs text-slate-500 flex-shrink-0">
              {displayLeads.length} resultado{displayLeads.length !== 1 ? 's' : ''} em todos os funis
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={handleRefetch}>
            <RefreshCw size={14} />
            Atualizar
          </Button>
          <Button size="sm" onClick={() => setOpenAddLead(true)}>
            <Plus size={14} />
            Novo Lead
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden py-4">
        {isLoading ? (
          <div className="flex gap-4 px-4">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="w-72 flex-shrink-0 space-y-3">
                <div className="h-6 bg-slate-200 rounded animate-pulse" />
                <CardSkeleton />
                <CardSkeleton />
              </div>
            ))}
          </div>
        ) : pipeline ? (
          <KanbanBoard
            pipeline={search.trim() ? { ...pipeline, stages: sortedPipelines.flatMap(p => p.stages) } : pipeline}
            leads={displayLeads}
            contacts={contacts}
            users={users}
            onRefresh={handleRefetch}
            isSearching={!!search.trim()}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-slate-400 text-sm">
            Nenhum pipeline encontrado
          </div>
        )}
      </div>

      {pipeline && (
        <LeadModal
          open={openAddLead}
          onClose={() => setOpenAddLead(false)}
          onCreated={handleRefetch}
          stages={pipeline.stages}
          pipelineId={pipeline.id}
          contacts={contacts}
          users={users}
        />
      )}
    </div>
  );
}
