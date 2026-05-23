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
import { Plus, RefreshCw } from 'lucide-react';

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

  const { data: pipelines, isLoading: loadingPipelines } = useQuery({ queryKey: ['pipelines'], queryFn: fetchPipelines });
  const pipeline = pipelines?.[0];

  const { data: rawLeads, isLoading: loadingLeads, refetch } = useQuery({
    queryKey: ['leads', pipeline?.id],
    queryFn: () => fetchLeads(pipeline!.id),
    enabled: !!pipeline,
  });

  const { data: contacts = [] } = useQuery({ queryKey: ['contacts'], queryFn: fetchContacts });

  useEffect(() => {
    if (rawLeads) setLeads(rawLeads);
  }, [rawLeads, setLeads]);

  const displayLeads = leads.length > 0 ? leads : rawLeads || [];

  // Extract unique users from leads
  const users: User[] = Array.from(
    new Map(displayLeads.map((l) => [l.user.id, l.user as unknown as User])).values()
  );

  const isLoading = loadingPipelines || loadingLeads;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Funil de Vendas" subtitle={pipeline?.name} />

      <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-af-border">
        <div className="flex items-center gap-4">
          {pipeline && (
            <select className="text-sm border border-af-border rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-af-accent">
              {pipelines?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
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
