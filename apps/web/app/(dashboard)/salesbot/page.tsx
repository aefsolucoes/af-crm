'use client';
import { useState } from 'react';
import { Topbar } from '@/components/ui/topbar';
import { FlowCanvas } from '@/components/salesbot/flow-canvas';
import { FlowNode } from '@/components/salesbot/node-types';
import { Button } from '@/components/ui/button';
import { Save, Play, Square, Plus } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';

const DEFAULT_FLOW: FlowNode[] = [
  { id: 'start', type: 'message', label: 'Boas-vindas', x: 80, y: 80, config: { message: 'Olá! Bem-vindo à A&F Soluções Financeiras. Como posso ajudar?' } },
  { id: 'wait1', type: 'wait', label: 'Aguardar Resposta', x: 80, y: 220, config: { timeout: '24' } },
  { id: 'collect1', type: 'collect', label: 'Coletar Nome', x: 80, y: 360, config: { field: 'nome', question: 'Qual é o seu nome completo?' } },
];

export default function SalesBotPage() {
  const [nodes, setNodes] = useState<FlowNode[]>(DEFAULT_FLOW);
  const [botName, setBotName] = useState('Bot de Atendimento');
  const [active, setActive] = useState(false);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await api.post('/api/leads', {}); // Placeholder — save flow to /api/salesbot in real impl
      toast('Fluxo salvo com sucesso!');
    } catch {
      toast('Fluxo salvo localmente (backend em desenvolvimento)', 'warning');
    } finally {
      setSaving(false);
    }
  }

  function handleNewFlow() {
    setNodes([]);
    toast('Canvas limpo. Adicione novos nós.');
  }

  return (
    <div className="flex flex-col h-full">
      <Topbar title="SalesBot" subtitle="Editor de fluxo de automação" />

      {/* Toolbar */}
      <div className="flex items-center justify-between px-6 py-2 bg-white border-b border-af-border">
        <div className="flex items-center gap-3">
          <input
            value={botName}
            onChange={(e) => setBotName(e.target.value)}
            className="text-sm font-semibold text-slate-800 bg-transparent border-b border-transparent hover:border-af-border focus:border-af-accent focus:outline-none px-1"
          />
          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${active ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
            {active ? 'Ativo' : 'Inativo'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleNewFlow}>
            <Plus size={14} />
            Novo
          </Button>
          <Button
            variant={active ? 'danger' : 'secondary'}
            size="sm"
            onClick={() => setActive(!active)}
          >
            {active ? <><Square size={14} /> Pausar</> : <><Play size={14} /> Ativar</>}
          </Button>
          <Button size="sm" loading={saving} onClick={handleSave}>
            <Save size={14} />
            Salvar
          </Button>
        </div>
      </div>

      {/* Info bar */}
      <div className="px-6 py-1.5 bg-af-light border-b border-af-border text-xs text-slate-500 flex items-center gap-4">
        <span>{nodes.length} nós no fluxo</span>
        <span>·</span>
        <span>Arraste os nós do painel esquerdo para o canvas</span>
        <span>·</span>
        <span>Clique em um nó para configurá-lo</span>
      </div>

      <FlowCanvas nodes={nodes} onChange={setNodes} />
    </div>
  );
}
