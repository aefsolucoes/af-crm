'use client';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { Button } from '@/components/ui/button';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { CardSkeleton } from '@/components/ui/skeleton';
import { usePipelineStore } from '@/store/pipeline.store';
import { LeadModal } from '@/components/kanban/lead-modal';
import { Pipeline, Lead, Contact, User } from '@/types';
import api from '@/lib/api';
import { Plus, RefreshCw, Search, X } from 'lucide-react';

async function fetchPipelines(): Promise<Pipeline[]> {
  const { data } = await api.get('/api/pipelines');
  return data;
}

async function fetchLeads(pipelineId: string): Promise<Lead[]> {
  const { data } = await api.get(`/api/leads?pipelineId=${pipelineId}`);
  return data;
}

async function fetchContacts(): Promise<Contact[]> {
  const { data } = await api.get('/api/contacts');
  return data;
}

async function fetchUsers(): Promise<User[]> {
  // Users come from the leads data for simplicity
  return [];
}

export default function FunilPage() {
  const { leads, setLeads } = usePipelineStore();
  const [openAddLead, setOpenAddLead] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>('');

  const { data: pipelines, isLoading: loadingPipelines } = useQuery({ queryKey: ['pipelines'], queryFn: fetchPipelines });
  const pipeline = pipelines?.find(p => p.id === selectedPipelineId) || pipelines?.[0];

  useEffect(() => { if (pipelines?.[0] && !selectedPipelineId) setSelectedPipelineId(pipelines[0].id); }, [pipelines]);

  const { data: rawLeads, isLoading: loadingLeads, refetch } = useQuery({
    queryKey: ['leads', selectedPipelineId],
    queryFn: () => fetchLeads(selectedPipelineId),
    enabled: !!selectedPipelineId,
  });

  const { data: contacts = [] } = useQuery({ queryKey: ['contacts'], queryFn: fetchContacts });

  useEffect(() => {
    if (rawLeads) setLeads(rawLeads);
  }, [rawLeads, setLeads]);

  const allLeads = leads.length > 0 ? leads : rawLeads || [];

  const displayLeads = search.trim()
    ? allLeads.filter(l => {
        const q = search.toLowerCase();
        return (
          l.name.toLowerCase().includes(q) ||
          (l.contact?.name ?? '').toLowerCase().includes(q) ||
          (l.contact?.phone ?? '').toLowerCase().includes(q) ||
          l.tags.some(t => t.toLowerCase().includes(q))
        );
      })
    : allLeads;

  // Extract unique users from leads
  const users: User[] = Array.from(
    new Map(displayLeads.map((l) => [l.user.id, l.user as unknown as User])).values()
  );

  const isLoading = loadingPipelines || loadingLeads;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Funil de Vendas" subtitle={pipeline?.name} />

      <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-af-border gap-4">
        <div className="flex items-center gap-3 flex-1">
          {pipeline && (
            <select
              value={selectedPipelineId}
              onChange={e => setSelectedPipelineId(e.target.value)}
              className="text-sm border border-af-border rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-af-accent flex-shrink-0"
            >
              {pipelines?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          {/* Busca */}
          <div className="relative flex-1 max-w-sm">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder="Buscar por nome, contato, telefone ou tag..."
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
              {displayLeads.length} resultado{displayLeads.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button variant="ghost" size="sm" onClick={() => refetch()}>
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
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="w-72 flex-shrink-0 space-y-3">
                <div className="h-6 bg-slate-200 rounded animate-pulse" />
                <CardSkeleton />
                <CardSkeleton />
              </div>
            ))}
          </div>
        ) : pipeline ? (
          <KanbanBoard
            pipeline={pipeline}
            leads={displayLeads}
            contacts={contacts}
            users={users}
            onRefresh={refetch}
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
          onCreated={refetch}
          stages={pipeline.stages}
          pipelineId={pipeline.id}
          contacts={contacts}
          users={users}
        />
      )}
    </div>
  );
}
