'use client';
import { useEffect, useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { KanbanBoard } from '@/components/kanban/kanban-board';
import { CardSkeleton } from '@/components/ui/skeleton';
import { usePipelineStore } from '@/store/pipeline.store';
import { LeadModal } from '@/components/kanban/lead-modal';
import { DuplicatesModal } from '@/components/kanban/duplicates-modal';
import { Pipeline, Lead, Contact, User } from '@/types';
import api from '@/lib/api';
import { Plus, RefreshCw, Search, X, Pencil, Trash2, FolderPlus, GitMerge, Archive } from 'lucide-react';
import { getSocket } from '@/lib/socket';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth.store';

// Ordem fixa dos pipelines dentro de cada setor
const PIPELINE_ORDER = ['Caixa de Entrada', 'Vendas', 'Em contratação', 'Follow Up'];

interface DepartmentOption { id: string; name: string; }

async function fetchPipelines(): Promise<Pipeline[]> {
  const { data } = await api.get('/api/pipelines');
  return data;
}

async function fetchDepartments(): Promise<DepartmentOption[]> {
  const { data } = await api.get('/api/departments');
  return data;
}

async function fetchLeads(pipelineId: string, archived = false): Promise<Lead[]> {
  const { data } = await api.get(`/api/leads?pipelineId=${pipelineId}${archived ? '&archived=true' : ''}`);
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

interface FunilViewProps {
  /** Nome exato do Department (ex.: "Financiamento Habitacional") — filtra
   *  quais pipelines aparecem aqui. Cada setor tem sua própria tela agora,
   *  em vez de um único "Funil de Vendas" misturando tudo. */
  departmentName: string;
  /** Título mostrado no topo (ex.: "Funil de Vendas Habitação"). */
  title: string;
  /** Sufixo pra chave do localStorage — cada setor lembra seu próprio último
   *  funil selecionado, sem um sobrescrever o do outro. */
  storageKeySuffix: string;
}

export function FunilView({ departmentName, title, storageKeySuffix }: FunilViewProps) {
  const { leads: storeLeads, setLeads, moveLeadOptimistic } = usePipelineStore();
  const [openAddLead, setOpenAddLead] = useState(false);
  const [openDuplicates, setOpenDuplicates] = useState(false);
  const [search, setSearch] = useState('');
  const me = useAuthStore((s) => s.user);
  const isAdmin = me?.role === 'ADMIN';
  const [showArchived, setShowArchived] = useState(false);

  const selectedPipelineKey = `af-crm:funil:${storageKeySuffix}:selectedPipelineId`;
  function readStoredPipelineId(): string {
    if (typeof window === 'undefined') return '';
    try { return localStorage.getItem(selectedPipelineKey) || ''; } catch { return ''; }
  }
  function storePipelineId(id: string) {
    if (typeof window === 'undefined') return;
    try {
      if (id) localStorage.setItem(selectedPipelineKey, id);
      else localStorage.removeItem(selectedPipelineKey);
    } catch { /* localStorage indisponível (modo privado etc.) — segue sem persistir */ }
  }

  const [selectedPipelineId, setSelectedPipelineIdRaw] = useState<string>(readStoredPipelineId);
  // Troca o funil selecionado E lembra a escolha (F5 volta pro mesmo funil).
  function setSelectedPipelineId(id: string) {
    setSelectedPipelineIdRaw(id);
    storePipelineId(id);
  }
  const [showNewPipeline, setShowNewPipeline] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState('');
  const [showRenamePipeline, setShowRenamePipeline] = useState(false);
  const [renamePipelineName, setRenamePipelineName] = useState('');
  const [savingPipeline, setSavingPipeline] = useState(false);
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

  const { data: allPipelines, isLoading: loadingPipelines } = useQuery({
    queryKey: ['pipelines'],
    queryFn: fetchPipelines,
  });

  const { data: departments } = useQuery({ queryKey: ['departments'], queryFn: fetchDepartments });
  const department = (departments || []).find((d) => d.name === departmentName);

  // Pipelines deste setor — mais os "órfãos" (sem departamento definido).
  // Mesmo critério que o backend já usa pra decidir o que um colaborador sem
  // setor vê (services/department.service.ts: OR departmentId=X OU null) —
  // sem incluir os órfãos aqui, um pipeline sem setor sumia das DUAS telas
  // novas (nem Habitação nem Consórcio o enxergava mais).
  const departmentPipelines = useMemo(
    () => (allPipelines || []).filter((p) => p.department?.name === departmentName || !p.department),
    [allPipelines, departmentName]
  );

  // Pipelines ordenados: Caixa de Entrada → Vendas → Em contratação → Follow Up
  const sortedPipelines = useMemo(() => {
    return [...departmentPipelines].sort((a, b) => {
      const ai = PIPELINE_ORDER.indexOf(a.name);
      const bi = PIPELINE_ORDER.indexOf(b.name);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
  }, [departmentPipelines]);

  const pipeline = sortedPipelines.find(p => p.id === selectedPipelineId) || sortedPipelines[0];

  useEffect(() => {
    if (!sortedPipelines[0]) return;
    // Sem nada selecionado (1ª visita) ou o funil lembrado não existe mais
    // (foi excluído, ou é de outro setor) — cai pro primeiro da lista deste
    // setor. Fora isso, respeita o que já está selecionado.
    const stillExists = sortedPipelines.some(p => p.id === selectedPipelineId);
    if (!selectedPipelineId || !stillExists) {
      setSelectedPipelineId(sortedPipelines[0].id);
    }
  }, [sortedPipelines]);

  // Leads do pipeline atual
  const { data: rawLeads, isLoading: loadingLeads, refetch } = useQuery({
    queryKey: ['leads', selectedPipelineId, showArchived],
    queryFn: () => fetchLeads(selectedPipelineId, isAdmin && showArchived),
    enabled: !!selectedPipelineId && !search.trim(),
  });

  // Todos os leads (para busca cross-pipeline) — só os DESTE setor.
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

  const departmentPipelineIds = useMemo(() => new Set(sortedPipelines.map((p) => p.id)), [sortedPipelines]);

  // Leads para exibição: se pesquisando usa todos os funis DESTE SETOR, senão
  // usa pipeline atual. Aplica updates otimísticos do store por cima dos
  // dados do servidor.
  const displayLeads = useMemo(() => {
    const baseLeads = search.trim()
      ? (allRawLeads || []).filter((l) => departmentPipelineIds.has(l.pipelineId))
      : (rawLeads || []);

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
  }, [rawLeads, allRawLeads, storeLeads, search, departmentPipelineIds]);

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

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    if (!name) return;
    setSavingPipeline(true);
    try {
      // Manda o departmentId deste setor — pra um Admin (que escolhe o setor
      // livremente), sem isso o funil novo nasceria "órfão" e não apareceria
      // em NENHUMA das duas telas. Pra colaborador comum, o backend ignora
      // isso e usa o setor dele mesmo de qualquer jeito.
      const { data } = await api.post('/api/pipelines', { name, departmentId: department?.id });
      await queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      setSelectedPipelineId(data.id);
      setNewPipelineName('');
      setShowNewPipeline(false);
      toast(`Funil "${name}" criado!`);
    } catch {
      toast('Erro ao criar funil', 'error');
    } finally {
      setSavingPipeline(false);
    }
  }

  async function handleRenamePipeline() {
    const name = renamePipelineName.trim();
    if (!name || !pipeline) return;
    setSavingPipeline(true);
    try {
      await api.patch(`/api/pipelines/${pipeline.id}`, { name });
      await queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      setShowRenamePipeline(false);
      toast('Funil renomeado!');
    } catch {
      toast('Erro ao renomear funil', 'error');
    } finally {
      setSavingPipeline(false);
    }
  }

  async function handleDeletePipeline() {
    if (!pipeline) return;
    if (!window.confirm(`Excluir o funil "${pipeline.name}"? Só é possível excluir funis sem leads.`)) return;
    try {
      await api.delete(`/api/pipelines/${pipeline.id}`);
      setSelectedPipelineId('');
      await queryClient.invalidateQueries({ queryKey: ['pipelines'] });
      toast('Funil excluído!');
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao excluir funil', 'error');
    }
  }

  return (
    <div className="flex flex-col h-full">
      <Topbar title={title} subtitle={search.trim() ? `Todos os funis de ${departmentName}` : pipeline?.name} />

      <div className="flex items-center justify-between px-6 py-3 app-topbar-surface border-b gap-4">
        <div className="flex items-center gap-3 flex-1">
          {/* Seletor de pipeline (oculto durante busca) */}
          {!search.trim() && pipeline && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <select
                value={selectedPipelineId}
                onChange={e => setSelectedPipelineId(e.target.value)}
                className="text-sm border border-af-border rounded-lg px-3 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-af-accent"
              >
                {sortedPipelines.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button
                onClick={() => setShowNewPipeline(true)}
                title="Novo funil"
                className="p-1.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
              >
                <FolderPlus size={16} />
              </button>
              <button
                onClick={() => { setRenamePipelineName(pipeline.name); setShowRenamePipeline(true); }}
                title="Renomear funil"
                className="p-1.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10 transition-colors"
              >
                <Pencil size={16} />
              </button>
              <button
                onClick={handleDeletePipeline}
                title="Excluir funil"
                className="p-1.5 rounded-lg text-white/80 hover:text-red-300 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 size={16} />
              </button>
            </div>
          )}

          {/* Busca global */}
          <div className="relative flex-1 max-w-sm">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            <input
              type="text"
              placeholder={`Buscar nos funis de ${departmentName}...`}
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
              {displayLeads.length} resultado{displayLeads.length !== 1 ? 's' : ''} em {departmentName}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {isAdmin && (
            <Button
              variant={showArchived ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setShowArchived((v) => !v)}
              title="Ver leads arquivados (somente admin)"
            >
              <Archive size={14} />
              {showArchived ? 'Vendo arquivados' : 'Ver arquivados'}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setOpenDuplicates(true)}>
            <GitMerge size={14} />
            Juntar duplicados
          </Button>
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
            Nenhum pipeline encontrado em {departmentName}
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

      <DuplicatesModal
        open={openDuplicates}
        onClose={() => setOpenDuplicates(false)}
        onMerged={handleRefetch}
      />

      <Modal open={showNewPipeline} onClose={() => setShowNewPipeline(false)} title="Novo funil" size="sm">
        <div className="space-y-3">
          <input
            autoFocus
            value={newPipelineName}
            onChange={e => setNewPipelineName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreatePipeline(); }}
            placeholder="Nome do funil"
            className="w-full text-sm px-3 py-2 border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowNewPipeline(false)} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
            <button onClick={handleCreatePipeline} disabled={savingPipeline || !newPipelineName.trim()} className="text-sm px-4 py-2 rounded-lg bg-af-mid text-white hover:bg-af-dark disabled:opacity-50">
              {savingPipeline ? 'Criando...' : 'Criar funil'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={showRenamePipeline} onClose={() => setShowRenamePipeline(false)} title="Renomear funil" size="sm">
        <div className="space-y-3">
          <input
            autoFocus
            value={renamePipelineName}
            onChange={e => setRenamePipelineName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleRenamePipeline(); }}
            placeholder="Nome do funil"
            className="w-full text-sm px-3 py-2 border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent"
          />
          <div className="flex justify-end gap-2">
            <button onClick={() => setShowRenamePipeline(false)} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
            <button onClick={handleRenamePipeline} disabled={savingPipeline || !renamePipelineName.trim()} className="text-sm px-4 py-2 rounded-lg bg-af-mid text-white hover:bg-af-dark disabled:opacity-50">
              {savingPipeline ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
