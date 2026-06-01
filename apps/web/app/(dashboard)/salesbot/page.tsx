'use client';
import { useState } from 'react';
import { Topbar } from '@/components/ui/topbar';
import { FlowCanvas } from '@/components/salesbot/flow-canvas';
import { FlowNode } from '@/components/salesbot/node-types';
import { Button } from '@/components/ui/button';
import { Save, Play, Square, Plus, ChevronLeft, Bot, Trash2, Copy, ToggleLeft, ToggleRight } from 'lucide-react';
import { toast } from '@/components/ui/toast';

interface SalesBot {
  id: string;
  name: string;
  description: string;
  active: boolean;
  nodes: FlowNode[];
  createdAt: string;
}

const INITIAL_BOTS: SalesBot[] = [
  {
    id: 'bot-1',
    name: 'Bot de Boas-vindas',
    description: 'Recebe novos leads e coleta informações básicas',
    active: true,
    createdAt: '2025-01-01',
    nodes: [
      { id: 'start', type: 'send_message', label: 'Boas-vindas', x: 80, y: 80, config: { message: 'Olá! Bem-vindo à A&F Soluções Financeiras. Como posso ajudar?' }, connections: ['wait1'] },
      { id: 'wait1', type: 'pause', label: 'Aguardar Resposta', x: 80, y: 220, config: { pauseType: 'response', timeout: '24' }, connections: ['collect1'] },
      { id: 'collect1', type: 'validation', label: 'Coletar Nome', x: 80, y: 360, config: { validationType: 'text', field: 'nome', errorMessage: 'Por favor, informe seu nome.' }, connections: [] },
    ],
  },
  {
    id: 'bot-2',
    name: 'Bot de Qualificação',
    description: 'Qualifica leads com perguntas direcionadas',
    active: false,
    createdAt: '2025-01-15',
    nodes: [],
  },
];

export default function SalesBotPage() {
  const [bots, setBots] = useState<SalesBot[]>(INITIAL_BOTS);
  const [editingBotId, setEditingBotId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const editingBot = bots.find((b) => b.id === editingBotId) || null;

  function handleNewBot() {
    const bot: SalesBot = {
      id: `bot-${Date.now()}`,
      name: 'Novo Salesbot',
      description: 'Descrição do bot',
      active: false,
      createdAt: new Date().toISOString().split('T')[0],
      nodes: [],
    };
    setBots([...bots, bot]);
    setEditingBotId(bot.id);
  }

  function handleDuplicate(bot: SalesBot) {
    const copy: SalesBot = {
      ...bot,
      id: `bot-${Date.now()}`,
      name: `${bot.name} (cópia)`,
      active: false,
    };
    setBots([...bots, copy]);
    toast('Bot duplicado com sucesso!');
  }

  function handleDelete(id: string) {
    setBots(bots.filter((b) => b.id !== id));
    toast('Bot removido.');
  }

  function handleToggle(id: string) {
    setBots(bots.map((b) => (b.id === id ? { ...b, active: !b.active } : b)));
  }

  function handleNodesChange(nodes: FlowNode[]) {
    setBots(bots.map((b) => (b.id === editingBotId ? { ...b, nodes } : b)));
  }

  function handleNameChange(name: string) {
    setBots(bots.map((b) => (b.id === editingBotId ? { ...b, name } : b)));
  }

  function handleDescriptionChange(description: string) {
    setBots(bots.map((b) => (b.id === editingBotId ? { ...b, description } : b)));
  }

  async function handleSave() {
    setSaving(true);
    await new Promise((r) => setTimeout(r, 600));
    setSaving(false);
    toast('Fluxo salvo com sucesso!');
  }

  // ─── Editor view ───────────────────────────────────────────────────────────
  if (editingBot) {
    return (
      <div className="flex flex-col h-full">
        <Topbar
          title={
            <div className="flex items-center gap-2">
              <button onClick={() => setEditingBotId(null)} className="text-slate-400 hover:text-slate-700 flex items-center gap-1 text-sm font-normal">
                <ChevronLeft size={16} /> SalesBot
              </button>
              <span className="text-slate-300">/</span>
              <input
                value={editingBot.name}
                onChange={(e) => handleNameChange(e.target.value)}
                className="text-sm font-semibold text-slate-800 bg-transparent border-b border-transparent hover:border-af-border focus:border-af-accent focus:outline-none px-1"
              />
            </div>
          }
          subtitle={
            <input
              value={editingBot.description}
              onChange={(e) => handleDescriptionChange(e.target.value)}
              className="text-xs text-slate-400 bg-transparent focus:outline-none w-full"
              placeholder="Descrição do bot..."
            />
          }
        />

        {/* Toolbar */}
        <div className="flex items-center justify-between px-6 py-2 bg-white border-b border-af-border">
          <div className="flex items-center gap-3">
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${editingBot.active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
              {editingBot.active ? 'Ativo' : 'Inativo'}
            </span>
            <span className="text-xs text-slate-400">{editingBot.nodes.length} nós no fluxo</span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant={editingBot.active ? 'danger' : 'secondary'}
              size="sm"
              onClick={() => handleToggle(editingBot.id)}
            >
              {editingBot.active ? <><Square size={14} /> Pausar</> : <><Play size={14} /> Ativar</>}
            </Button>
            <Button size="sm" loading={saving} onClick={handleSave}>
              <Save size={14} />
              Salvar
            </Button>
          </div>
        </div>

        <div className="px-6 py-1.5 bg-af-light border-b border-af-border text-xs text-slate-500 flex items-center gap-4">
          <span>Clique em um tipo de nó para adicioná-lo</span>
          <span>·</span>
          <span>Arraste os nós para reposicioná-los</span>
          <span>·</span>
          <span>Clique em um nó para configurá-lo</span>
        </div>

        <FlowCanvas nodes={editingBot.nodes} onChange={handleNodesChange} />
      </div>
    );
  }

  // ─── List view ─────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      <Topbar title="SalesBot" subtitle="Automação de fluxos de conversa" />

      <div className="flex-1 overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Seus Salesbots</h2>
            <p className="text-sm text-slate-500">{bots.length} bot{bots.length !== 1 ? 's' : ''} criado{bots.length !== 1 ? 's' : ''}</p>
          </div>
          <Button onClick={handleNewBot}>
            <Plus size={15} />
            Novo Salesbot
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Criar novo card */}
          <button
            onClick={handleNewBot}
            className="flex flex-col items-center justify-center gap-3 p-8 rounded-xl border-2 border-dashed border-af-border hover:border-af-accent hover:bg-af-light transition-colors text-slate-400 hover:text-af-accent"
          >
            <Plus size={28} />
            <span className="text-sm font-medium">Criar novo salesbot</span>
          </button>

          {bots.map((bot) => (
            <div
              key={bot.id}
              className="bg-white rounded-xl border border-af-border shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg ${bot.active ? 'bg-green-100' : 'bg-slate-100'}`}>
                      <Bot size={18} className={bot.active ? 'text-green-600' : 'text-slate-400'} />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-slate-900">{bot.name}</h3>
                      <p className="text-xs text-slate-500 mt-0.5">{bot.nodes.length} nós</p>
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggle(bot.id); }}
                    className={`${bot.active ? 'text-green-500 hover:text-green-700' : 'text-slate-300 hover:text-slate-500'} transition-colors`}
                    title={bot.active ? 'Desativar' : 'Ativar'}
                  >
                    {bot.active ? <ToggleRight size={22} /> : <ToggleLeft size={22} />}
                  </button>
                </div>

                <p className="text-xs text-slate-500 mb-4 line-clamp-2">{bot.description}</p>

                <div className="flex items-center gap-1">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${bot.active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                    {bot.active ? 'Ativo' : 'Inativo'}
                  </span>
                  <span className="text-xs text-slate-400 ml-auto">Criado {bot.createdAt}</span>
                </div>
              </div>

              <div className="flex items-center gap-1 px-4 pb-4 pt-0">
                <Button size="sm" className="flex-1" onClick={() => setEditingBotId(bot.id)}>
                  Editar fluxo
                </Button>
                <button
                  onClick={() => handleDuplicate(bot)}
                  className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                  title="Duplicar"
                >
                  <Copy size={14} />
                </button>
                <button
                  onClick={() => handleDelete(bot.id)}
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
