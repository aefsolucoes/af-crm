'use client';
import { useState, useRef, useCallback } from 'react';
import { FlowNode, NodeType, getNodeMeta } from './node-types';
import { NodeInspector } from './node-inspector';
import { cn } from '@/lib/utils';
import { Plus, Trash2 } from 'lucide-react';

interface FlowCanvasProps {
  nodes: FlowNode[];
  onChange: (nodes: FlowNode[]) => void;
}

function generateId() {
  return Math.random().toString(36).slice(2, 9);
}

export function FlowCanvas({ nodes, onChange }: FlowCanvasProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; startX: number; startY: number; nodeX: number; nodeY: number } | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const selectedNode = nodes.find((n) => n.id === selectedId) || null;

  function addNode(type: NodeType) {
    const meta = getNodeMeta(type);
    const newNode: FlowNode = {
      id: generateId(),
      type,
      label: meta.label,
      x: 100 + nodes.length * 30,
      y: 100 + nodes.length * 30,
      config: {},
    };
    onChange([...nodes, newNode]);
    setSelectedId(newNode.id);
  }

  function updateNode(updated: FlowNode) {
    onChange(nodes.map((n) => (n.id === updated.id ? updated : n)));
  }

  function deleteNode(id: string) {
    onChange(nodes.filter((n) => n.id !== id));
    if (selectedId === id) setSelectedId(null);
  }

  const handleMouseDown = useCallback((e: React.MouseEvent, nodeId: string) => {
    e.stopPropagation();
    const node = nodes.find((n) => n.id === nodeId)!;
    setDragging({ id: nodeId, startX: e.clientX, startY: e.clientY, nodeX: node.x, nodeY: node.y });
    setSelectedId(nodeId);
  }, [nodes]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return;
    const dx = e.clientX - dragging.startX;
    const dy = e.clientY - dragging.startY;
    onChange(nodes.map((n) => n.id === dragging.id ? { ...n, x: dragging.nodeX + dx, y: dragging.nodeY + dy } : n));
  }, [dragging, nodes, onChange]);

  const handleMouseUp = useCallback(() => setDragging(null), []);

  const NODE_TYPES: NodeType[] = ['message', 'wait', 'condition', 'collect', 'assign', 'move_stage', 'human'];

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Toolbar */}
      <div className="w-48 border-r border-af-border bg-white flex flex-col p-3 gap-2 overflow-y-auto scrollbar-thin flex-shrink-0">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Nós disponíveis</p>
        {NODE_TYPES.map((type) => {
          const meta = getNodeMeta(type);
          return (
            <button
              key={type}
              onClick={() => addNode(type)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-af-border hover:border-af-mid hover:bg-af-light transition-colors text-left text-xs"
            >
              <span className="p-1 rounded text-white" style={{ backgroundColor: meta.color }}>
                {meta.icon}
              </span>
              <span className="text-slate-700 font-medium">{meta.label}</span>
            </button>
          );
        })}
      </div>

      {/* Canvas */}
      <div
        ref={canvasRef}
        className="flex-1 bg-slate-50 relative overflow-hidden cursor-default"
        style={{ backgroundImage: 'radial-gradient(circle, #c5d6eb 1px, transparent 1px)', backgroundSize: '24px 24px' }}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={() => setSelectedId(null)}
      >
        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-slate-400">
              <Plus size={32} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">Clique em um nó para adicioná-lo ao canvas</p>
            </div>
          </div>
        )}

        {nodes.map((node) => {
          const meta = getNodeMeta(node.type);
          const isSelected = selectedId === node.id;
          return (
            <div
              key={node.id}
              className={cn(
                'absolute min-w-36 bg-white rounded-xl border-2 shadow-md cursor-grab active:cursor-grabbing select-none',
                isSelected ? 'ring-2 ring-af-accent' : ''
              )}
              style={{ left: node.x, top: node.y, borderColor: meta.color }}
              onMouseDown={(e) => handleMouseDown(e, node.id)}
              onClick={(e) => { e.stopPropagation(); setSelectedId(node.id); }}
            >
              <div className="flex items-center gap-2 px-3 py-2 rounded-t-xl" style={{ backgroundColor: meta.color }}>
                <span className="text-white">{meta.icon}</span>
                <span className="text-white text-xs font-semibold">{node.label}</span>
              </div>
              <div className="px-3 py-2 text-xs text-slate-600">
                {node.type === 'message' && !!node.config.message && (
                  <p className="truncate max-w-40">{String(node.config.message)}</p>
                )}
                {node.type === 'collect' && !!node.config.field && (
                  <p>Campo: <strong>{String(node.config.field)}</strong></p>
                )}
                {!node.config.message && !node.config.field && (
                  <p className="text-slate-400 italic">Configurar...</p>
                )}
              </div>
              {isSelected && (
                <button
                  className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5 hover:bg-red-600"
                  onClick={(e) => { e.stopPropagation(); deleteNode(node.id); }}
                >
                  <Trash2 size={10} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Inspector */}
      <NodeInspector
        node={selectedNode}
        onUpdate={updateNode}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
