'use client';
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { StepList, BotFlow, EMPTY_FLOW } from '@/components/salesbot/step-list';
import { Button } from '@/components/ui/button';
import { Save, Play, Square, Plus, ChevronLeft, Bot, Trash2, ToggleLeft, ToggleRight, ListChecks } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';

interface SalesBotSummary {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  stepCount: number;
  updatedAt: string;
}

interface SalesBotDetail extends Omit<SalesBotSummary, 'stepCount'> {
  flow: BotFlow;
}

interface SalesBotRun {
  id: string;
  leadName: string;
  status: string;
  stopReason: string | null;
  startedAt: string;
  updatedAt: string;
}

const RUN_STATUS_LABEL: Record<string, { label: string; className: string }> = {
  RUNNING: { label: 'Rodando', className: 'bg-blue-100 text-blue-700' },
  WAITING_REPLY: { label: 'Aguardando resposta', className: 'bg-amber-100 text-amber-700' },
  WAITING_TIME: { label: 'Aguardando prazo', className: 'bg-amber-100 text-amber-700' },
  COMPLETED: { label: 'Concluído', className: 'bg-green-100 text-green-700' },
  STOPPED: { label: 'Parado', className: 'bg-slate-100 text-slate-500' },
  ERROR: { label: 'Erro', className: 'bg-red-100 text-red-700' },
};

export default function SalesBotPage() {
  const qc = useQueryClient();
  const [editingBotId, setEditingBotId] = useState<string | null>(null);
  const [tab, setTab] = useState<'flow' | 'runs'>('flow');

  const { data: bots, isLoading } = useQuery({
    queryKey: ['salesbots'],
    queryFn: async () => (await api.get('/api/salesbot')).data as SalesBotSummary[],
  });

  const createMutation = useMutation({
    mutationFn: async () => (await api.post('/api/salesbot', { name: 'Novo Salesbot', description: '' })).data as SalesBotDetail,
    onSuccess: (bot) => {
      qc.invalidateQueries({ queryKey: ['salesbots'] });
      setEditingBotId(bot.id);
    },
    onError: () => toast('Erro ao criar o bot', 'error'),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => api.delete(`/api/salesbot/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['salesbots'] }); toast('Bot removido.'); },
    onError: () => toast('Erro ao remover o bot', 'error'),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: string; active: boolean }) => (await api.put(`/api/salesbot/${id}`, { active })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['salesbots'] }),
    onError: () => toast('Erro ao ativar/pausar o bot', 'error'),
  });

  if (editingBotId) {
    return (
      <BotEditor
        botId={editingBotId}
        tab={tab}
        setTab={setTab}
        onBack={() => { setEditingBotId(null); setTab('flow'); }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      <Topbar title="SalesBot" subtitle="Automação de fluxos de conversa no WhatsApp" />

      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Seus Salesbots</h2>
            <p className="text-sm text-slate-500">{isLoading ? 'Carregando...' : `${bots?.length || 0} bot${bots?.length !== 1 ? 's' : ''} criado${bots?.length !== 1 ? 's' : ''}`}</p>
          </div>
          <Button onClick={() => createMutation.mutate()} loading={createMutation.isPending}>
            <Plus size={15} />
            Novo Salesbot
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <button
            onClick={() => createMutation.mutate()}
            className="flex flex-col items-center justify-center gap-3 p-8 rounded-xl border-2 border-dashed border-af-border hover:border-af-accent hover:bg-af-light transition-colors text-slate-400 hover:text-af-accent"
          >
            <Plus size={28} />
            <span className="text-sm font-medium">Criar novo salesbot</span>
          </button>

          {(bots || []).map((bot) => (
            <div key={bot.id} className="bg-white rounded-xl border border-af-border shadow-sm hover:shadow-md transition-shadow">
              <div className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${bot.active ? 'bg-green-100' : 'bg-slate-100'}`}>
                      <Bot size={18} className={bot.active ? 'text-green-600' : 'text-slate-400'} />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900">{bot.name}</h3>
                      <p className="text-xs text-slate-500 mt-0.5">{bot.stepCount} passo{bot.stepCount !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleMutation.mutate({ id: bot.id, active: !bot.active }); }}
                    className={`${bot.active ? 'text-green-500 hover:text-green-700' : 'text-slate-300 hover:text-slate-500'} transition-colors`}
                    title={bot.active ? 'Pausar' : 'Ativar'}
                  >
                    {bot.active ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
                  </button>
                </div>

                <p className="text-xs text-slate-500 mb-4 line-clamp-2">{bot.description || 'Sem descrição.'}</p>

                <div className="flex items-center gap-1">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${bot.active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                    {bot.active ? 'Ativo' : 'Inativo'}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-1 px-4 pb-4 pt-0">
                <Button size="sm" className="flex-1" onClick={() => setEditingBotId(bot.id)}>
                  Editar fluxo
                </Button>
                <button
                  onClick={() => { if (confirm(`Excluir "${bot.name}"? Isso apaga o histórico de execuções também.`)) deleteMutation.mutate(bot.id); }}
                  className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                  title="Excluir"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BotEditor({
  botId, tab, setTab, onBack,
}: { botId: string; tab: 'flow' | 'runs'; setTab: (t: 'flow' | 'runs') => void; onBack: () => void }) {
  const qc = useQueryClient();
  const [flow, setFlow] = useState<BotFlow | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dirty, setDirty] = useState(false);

  const { data: bot } = useQuery({
    queryKey: ['salesbot', botId],
    queryFn: async () => {
      const { data } = await api.get(`/api/salesbot/${botId}`);
      return data as SalesBotDetail;
    },
  });

  // useQuery v5 não tem mais onSuccess — popula o estado local (editável) a
  // partir do servidor aqui. Guardado por `dirty` pra uma revalidação em
  // segundo plano não apagar uma edição em andamento.
  useEffect(() => {
    if (bot && !dirty) {
      setFlow(bot.flow?.steps ? bot.flow : EMPTY_FLOW);
      setName(bot.name);
      setDescription(bot.description || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot]);

  const { data: runs } = useQuery({
    queryKey: ['salesbot-runs', botId],
    queryFn: async () => (await api.get(`/api/salesbot/${botId}/runs`)).data as SalesBotRun[],
    enabled: tab === 'runs',
  });

  const saveMutation = useMutation({
    mutationFn: async () => (await api.put(`/api/salesbot/${botId}`, { name, description, flow })).data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['salesbot', botId] });
      qc.invalidateQueries({ queryKey: ['salesbots'] });
      setDirty(false);
      toast('Fluxo salvo com sucesso!');
    },
    onError: () => toast('Erro ao salvar o fluxo', 'error'),
  });

  const toggleMutation = useMutation({
    mutationFn: async () => (await api.put(`/api/salesbot/${botId}`, { active: !bot?.active })).data,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['salesbot', botId] }); qc.invalidateQueries({ queryKey: ['salesbots'] }); },
    onError: () => toast('Erro ao ativar/pausar o bot', 'error'),
  });

  if (!bot || !flow) {
    return (
      <div className="flex flex-col h-full">
        <Topbar title="SalesBot" />
        <div className="flex-1 flex items-center justify-center text-sm text-slate-400">Carregando...</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <Topbar
        title={
          <div className="flex items-center gap-2">
            <button onClick={onBack} className="text-slate-400 hover:text-slate-700 flex items-center gap-1 text-sm font-normal">
              <ChevronLeft size={16} /> SalesBot
            </button>
            <span className="text-slate-300">/</span>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setDirty(true); }}
              className="text-sm font-semibold text-slate-800 bg-transparent border-b border-transparent hover:border-af-border focus:border-af-accent focus:outline-none px-1"
            />
          </div>
        }
        subtitle={
          <input
            value={description}
            onChange={(e) => { setDescription(e.target.value); setDirty(true); }}
            className="text-xs text-slate-400 bg-transparent focus:outline-none w-full"
            placeholder="Descrição do bot..."
          />
        }
      />

      <div className="flex items-center justify-between px-6 py-2 bg-white border-b border-af-border">
        <div className="flex items-center gap-3">
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${bot.active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
            {bot.active ? 'Ativo' : 'Inativo'}
          </span>
          <span className="text-xs text-slate-400">{flow.steps.length} passo{flow.steps.length !== 1 ? 's' : ''}</span>
          <div className="flex items-center gap-1 ml-4">
            <button
              onClick={() => setTab('flow')}
              className={`px-3 py-1 text-xs font-medium rounded-lg ${tab === 'flow' ? 'bg-af-accent text-white' : 'text-slate-500 hover:bg-af-light'}`}
            >
              Fluxo
            </button>
            <button
              onClick={() => setTab('runs')}
              className={`px-3 py-1 text-xs font-medium rounded-lg flex items-center gap-1 ${tab === 'runs' ? 'bg-af-accent text-white' : 'text-slate-500 hover:bg-af-light'}`}
            >
              <ListChecks size={12} /> Execuções
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant={bot.active ? 'danger' : 'secondary'} size="sm" onClick={() => toggleMutation.mutate()} loading={toggleMutation.isPending}>
            {bot.active ? <><Square size={14} /> Pausar</> : <><Play size={14} /> Ativar</>}
          </Button>
          <Button size="sm" loading={saveMutation.isPending} onClick={() => saveMutation.mutate()} disabled={!dirty && !saveMutation.isPending}>
            <Save size={14} />
            Salvar
          </Button>
        </div>
      </div>

      {tab === 'flow' ? (
        <StepList flow={flow} onChange={(f) => { setFlow(f); setDirty(true); }} />
      ) : (
        <RunsPanel runs={runs} />
      )}
    </div>
  );
}

function RunsPanel({ runs }: { runs?: SalesBotRun[] }) {
  if (!runs) return <div className="flex-1 flex items-center justify-center text-sm text-slate-400">Carregando...</div>;
  if (runs.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-sm text-slate-400">Nenhuma execução ainda — ative o bot e mande a frase-gatilho de um número de teste.</div>;
  }
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-400 border-b border-af-border">
            <th className="pb-2 font-medium">Lead</th>
            <th className="pb-2 font-medium">Status</th>
            <th className="pb-2 font-medium">Iniciado</th>
            <th className="pb-2 font-medium">Atualizado</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const meta = RUN_STATUS_LABEL[r.status] || { label: r.status, className: 'bg-slate-100 text-slate-500' };
            return (
              <tr key={r.id} className="border-b border-af-border/60">
                <td className="py-2.5 text-slate-800">{r.leadName}</td>
                <td className="py-2.5">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.className}`}>{meta.label}</span>
                  {r.stopReason && <span className="text-xs text-slate-400 ml-2">{r.stopReason}</span>}
                </td>
                <td className="py-2.5 text-slate-500">{new Date(r.startedAt).toLocaleString('pt-BR')}</td>
                <td className="py-2.5 text-slate-500">{new Date(r.updatedAt).toLocaleString('pt-BR')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
