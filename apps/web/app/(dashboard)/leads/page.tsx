'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { Lead, Pipeline, Contact, User } from '@/types';
import api from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { formatCurrency, formatDate, isOverdue } from '@/lib/utils';
import { AlertCircle, Plus, Archive } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import Link from 'next/link';
import { useState } from 'react';
import { LeadModal } from '@/components/kanban/lead-modal';

async function fetchLeads(archived = false): Promise<Lead[]> {
  const { data } = await api.get(`/api/leads${archived ? '?archived=true' : ''}`);
  return data;
}

async function fetchPipelines(): Promise<Pipeline[]> {
  const { data } = await api.get('/api/pipelines');
  return data;
}

async function fetchContacts(): Promise<Contact[]> {
  const { data } = await api.get('/api/contacts');
  return data;
}

export default function LeadsPage() {
  const [search, setSearch] = useState('');
  const [openAdd, setOpenAdd] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const queryClient = useQueryClient();

  const { data: leads, isLoading } = useQuery({
    queryKey: ['leads', showArchived],
    queryFn: () => fetchLeads(showArchived),
  });
  const { data: pipelines } = useQuery({ queryKey: ['pipelines'], queryFn: fetchPipelines });
  const { data: contacts = [] } = useQuery({ queryKey: ['contacts'], queryFn: fetchContacts });

  const pipeline = pipelines?.[0];

  const users: User[] = Array.from(
    new Map((leads || []).map((l) => [l.user.id, l.user as unknown as User])).values()
  );

  const filtered = (leads || []).filter((l) => {
    const q = search.toLowerCase();
    const cf = (l.customFields || {}) as Record<string, string>;
    return (
      l.name.toLowerCase().includes(q) ||
      (cf.participante_1 || '').toLowerCase().includes(q) ||
      (l.company?.name || '').toLowerCase().includes(q) ||
      (l.contact?.name || '').toLowerCase().includes(q)
    );
  });

  function handleCreated() {
    queryClient.invalidateQueries({ queryKey: ['leads', false] });
    setOpenAdd(false);
  }

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Leads" />
      <div className="flex items-center justify-between px-6 py-3 bg-white border-b border-af-border gap-4">
        <div className="flex items-center gap-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar leads..."
            className="px-3 py-1.5 text-sm border border-af-border rounded-lg w-64 focus:outline-none focus:ring-2 focus:ring-af-accent"
          />
          {/* Toggle arquivados */}
          <button
            onClick={() => setShowArchived(v => !v)}
            className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
              showArchived
                ? 'bg-amber-100 text-amber-700 border-amber-300'
                : 'bg-white text-slate-500 border-af-border hover:bg-af-light'
            }`}
          >
            <Archive size={13} />
            {showArchived ? 'Arquivados' : 'Ver arquivados'}
          </button>
        </div>
        {!showArchived && (
          <Button size="sm" onClick={() => setOpenAdd(true)}>
            <Plus size={14} />
            Novo Lead
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 scrollbar-thin">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-af-border text-left">
                <th className="pb-3 font-semibold text-slate-600 text-xs uppercase tracking-wide">Lead</th>
                <th className="pb-3 font-semibold text-slate-600 text-xs uppercase tracking-wide">Empresa</th>
                <th className="pb-3 font-semibold text-slate-600 text-xs uppercase tracking-wide">Estágio</th>
                <th className="pb-3 font-semibold text-slate-600 text-xs uppercase tracking-wide">Valor</th>
                <th className="pb-3 font-semibold text-slate-600 text-xs uppercase tracking-wide">Responsável</th>
                <th className="pb-3 font-semibold text-slate-600 text-xs uppercase tracking-wide">Criado</th>
                <th className="pb-3 font-semibold text-slate-600 text-xs uppercase tracking-wide">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-af-border/50">
              {filtered.map((lead) => (
                <tr key={lead.id} className="hover:bg-af-light/50 transition-colors group">
                  <td className="py-3">
                    <Link href={`/leads/${lead.id}`} className="font-medium text-slate-900 hover:text-af-mid group-hover:underline">
                      {lead.name}
                    </Link>
                    {lead.tags.slice(0, 2).map((tag) => (
                      <Badge key={tag} className="ml-1 bg-af-light text-af-mid text-xs">{tag}</Badge>
                    ))}
                  </td>
                  <td className="py-3 text-slate-600">{lead.company?.name || '—'}</td>
                  <td className="py-3">
                    <span className="px-2 py-0.5 rounded-full text-xs text-white font-medium" style={{ backgroundColor: lead.stage.color }}>
                      {lead.stage.name}
                    </span>
                  </td>
                  <td className="py-3 font-medium text-af-mid">{formatCurrency(lead.value)}</td>
                  <td className="py-3">
                    <div className="flex items-center gap-2">
                      <Avatar name={lead.user.name} size="sm" />
                      <span className="text-slate-600">{lead.user.name}</span>
                    </div>
                  </td>
                  <td className="py-3 text-slate-500">{formatDate(lead.createdAt)}</td>
                  <td className="py-3">
                    <Badge className={`text-xs ${lead.status === 'WON' ? 'bg-green-100 text-green-700' : lead.status === 'LOST' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'}`}>
                      {lead.status === 'WON' ? 'Ganho' : lead.status === 'LOST' ? 'Perdido' : 'Aberto'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="text-center py-12 text-slate-400 text-sm">Nenhum lead encontrado</div>
        )}
      </div>

      {pipeline && (
        <LeadModal
          open={openAdd}
          onClose={() => setOpenAdd(false)}
          onCreated={handleCreated}
          stages={pipeline.stages}
          pipelineId={pipeline.id}
          contacts={contacts}
          users={users}
        />
      )}
    </div>
  );
}
