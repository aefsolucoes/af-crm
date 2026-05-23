'use client';
import { FlowNode, getNodeMeta } from './node-types';
import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface NodeInspectorProps {
  node: FlowNode | null;
  onUpdate: (node: FlowNode) => void;
  onClose: () => void;
}

export function NodeInspector({ node, onUpdate, onClose }: NodeInspectorProps) {
  if (!node) return null;

  const meta = getNodeMeta(node.type);

  function handleConfigChange(key: string, value: string) {
    onUpdate({ ...node!, config: { ...node!.config, [key]: value } });
  }

  function handleLabelChange(label: string) {
    onUpdate({ ...node!, label });
  }

  return (
    <aside className="w-72 border-l border-af-border bg-white flex flex-col flex-shrink-0">
      <div className="flex items-center justify-between px-4 py-3 border-b border-af-border">
        <div className="flex items-center gap-2">
          <span className="p-1.5 rounded-lg text-white" style={{ backgroundColor: meta.color }}>
            {meta.icon}
          </span>
          <span className="text-sm font-semibold text-slate-900">{meta.label}</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <p className="text-xs text-slate-500">{meta.description}</p>

        <Input
          label="Rótulo do nó"
          value={node.label}
          onChange={(e) => handleLabelChange(e.target.value)}
        />

        {node.type === 'message' && (
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-slate-700">Mensagem</label>
            <textarea
              value={String(node.config.message || '')}
              onChange={(e) => handleConfigChange('message', e.target.value)}
              className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
              rows={4}
              placeholder="Digite a mensagem que será enviada..."
            />
          </div>
        )}

        {node.type === 'wait' && (
          <Input
            label="Tempo máximo (horas)"
            type="number"
            value={String(node.config.timeout || '24')}
            onChange={(e) => handleConfigChange('timeout', e.target.value)}
          />
        )}

        {node.type === 'condition' && (
          <>
            <Input
              label="Campo a verificar"
              value={String(node.config.field || '')}
              onChange={(e) => handleConfigChange('field', e.target.value)}
              placeholder="Ex: resposta"
            />
            <Input
              label="Valor esperado"
              value={String(node.config.value || '')}
              onChange={(e) => handleConfigChange('value', e.target.value)}
              placeholder="Ex: sim"
            />
          </>
        )}

        {node.type === 'collect' && (
          <>
            <Input
              label="Campo para salvar"
              value={String(node.config.field || '')}
              onChange={(e) => handleConfigChange('field', e.target.value)}
              placeholder="Ex: email"
            />
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium text-slate-700">Pergunta</label>
              <textarea
                value={String(node.config.question || '')}
                onChange={(e) => handleConfigChange('question', e.target.value)}
                className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
                rows={3}
                placeholder="Qual é o seu e-mail?"
              />
            </div>
          </>
        )}

        {node.type === 'move_stage' && (
          <Input
            label="ID do estágio destino"
            value={String(node.config.stageId || '')}
            onChange={(e) => handleConfigChange('stageId', e.target.value)}
            placeholder="ID do estágio"
          />
        )}
      </div>
    </aside>
  );
}
