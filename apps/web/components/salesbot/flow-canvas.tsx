'use client';
import { useState, useRef, useCallback } from 'react';
import { FlowNode, NodeType, getNodeMeta, NODE_TYPES } from './node-types';
import { NodeInspector } from './node-inspector';
import { cn } from '@/lib/utils';
import { Plus, Trash2, ChevronDown } from 'lucide-react';

interface FlowCanvasProps {
  nodes: FlowNode[];
  onChange: (nodes: FlowNode[]) => void;
}

function generateId() {
  return Math.random().toString(36).slice(2, 9);
}

const DROPDOWN_TYPES: NodeType[] = ['action', 'goto_step'];

export function FlowCanvas({ nodes, onChange }: FlowCanvasProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; startX: number; startY: number; nodeX: number; nodeY: number } | null>(null);
  const [openDropdown, setOpenDropdown] = useState<NodeType | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  const selectedNode = nodes.find((n) => n.id === selectedId) || null;

  function addNode(type: NodeType) {
    const meta = getNodeMeta(type);
    const newNode: FlowNode = {
      id: generateId(),
      type,
      label: meta.label,
      x: 120 + (nodes.length % 5) * 40,
      y: 120 + Math.floor(nodes.length / 5) * 140 + (nodes.length % 5) * 40,
      config: {},
      connections: [],
    };
    onChange([...nodes, newNode]);
    setSelectedId(newNode.id);
    setOpenDropdown(null);
  }

  function updateNode(updated: FlowNode) {
    onChange(nodes.map((n) => (n.id === updated.id ? updated : n)));
  }

  function deleteNode(id: string) {
    onChange(nodes.filter((n) => n.id !== id).map(n => ({
      ...n,
      connections: (n.connections || []).filter(c => c !== id),
    })));
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

  function getNodePreview(node: FlowNode): string {
    const c = node.config;
    if (c.message) return String(c.message).slice(0, 40);
    if (c.comment) return String(c.comment).slice(0, 40);
    if (c.emoji) return String(c.emoji);
    if (c.title) return String(c.title).slice(0, 40);
    if (c.actionType) return String(c.actionType);
    if (c.validationType) return String(c.validationType);
    if (c.pauseType) return `Aguardar: ${c.duration ?? 1} ${c.unit ?? 'h'}`;
    if (c.reason) return String(c.reason);
    return '';
  }

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Sidebar de nós */}
      <div className="w-52 border-r border-af-border bg-white flex flex-col p-3 gap-1 overflow-y-auto scrollbar-thin flex-shrink-0">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Adicionar próximo passo</p>
        {NODE_TYPES.map((meta) => {
          const hasDropdown = DROPDOWN_TYPES.includes(meta.type);
          return (
            <div key={meta.type} className="relative">
              <button
                onClick={() => {
                  if (hasDropdown) {
                    setOpenDropdown(openDropdown === meta.type ? null : meta.type);
                  } else {
                    addNode(meta.type);
                  }
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-af-border hover:border-af-mid hover:bg-af-light transition-colors text-left text-xs"
              >
                <span className="p-1 rounded text-white flex-shrink-0" style={{ backgroundColor: meta.color }}>
                  {meta.icon}
                </span>
                <span className="text-slate-700 font-medium flex-1">{meta.label}</span>
                {hasDropdown && <ChevronDown size={12} className="text-slate-400" />}
              </button>
              {hasDropdown && openDropdown === meta.type && (
                <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-af-border rounded-lg shadow-lg z-10 overflow-hidden">
                  <button
                    onClick={() => addNode(meta.type)}
                    className="w-full px-3 py-2 text-xs text-slate-700 hover:bg-af-light text-left"
                  >
                    Adicionar nó padrão
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Canvas */}
      <div
        ref={canvasRef}
        className="flex-1 bg-slate-50 relative overflow-auto cursor-default"
        style={{ backgroundImage: 'radial-gradient(circle, #c5d6eb 1px, transparent 1px)', backgroundSize: '24px 24px', minHeight: 600 }}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onClick={() => { setSelectedId(null); setOpenDropdown(null); }}
      >
        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center text-slate-400">
              <Plus size={32} className="mx-auto mb-2 opacity-30" />
              <p className="text-sm">Clique em um tipo de nó para adicioná-lo ao canvas</p>
            </div>
          </div>
        )}

        {/* Conexões SVG */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ overflow: 'visible' }}>
          {nodes.map((node) =>
            (node.connections || []).map((targetId) => {
              const target = nodes.find((n) => n.id === targetId);
              if (!target) return null;
              const x1 = node.x + 80;
              const y1 = node.y + 48;
              const x2 = target.x;
              const y2 = target.y + 20;
              const cx = (x1 + x2) / 2;
              return (
                <path
                  key={`${node.id}-${targetId}`}
                  d={`M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke="#94a3b8"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  markerEnd="url(#arrow)"
                />
              );
            })
          )}
          <defs>
            <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L6,3 z" fill="#94a3b8" />
            </marker>
          </defs>
        </svg>

        {nodes.map((node) => {
          const meta = getNodeMeta(node.type);
          const isSelected = selectedId === node.id;
          const preview = getNodePreview(node);
          return (
            <div
              key={node.id}
              className={cn(
                'absolute min-w-[160px] max-w-[200px] bg-white rounded-xl border-2 shadow-md cursor-grab active:cursor-grabbing select-none transition-shadow',
                isSelected ? 'ring-2 ring-af-accent shadow-lg' : 'hover:shadow-lg'
              )}
              style={{ left: node.x, top: node.y, borderColor: meta.color }}
              onMouseDown={(e) => handleMouseDown(e, node.id)}
              onClick={(e) => { e.stopPropagation(); setSelectedId(node.id); }}
            >
              <div className="flex items-center gap-2 px-3 py-2 rounded-t-xl" style={{ backgroundColor: meta.color }}>
                <span className="text-white flex-shrink-0">{meta.icon}</span>
                <span className="text-white text-xs font-semibold truncate">{node.label}</span>
              </div>
              <div className="px-3 py-2 text-xs text-slate-600 min-h-[28px]">
                {preview ? (
                  <p className="truncate">{preview}</p>
                ) : (
                  <p className="text-slate-400 italic">Configurar...</p>
                )}
              </div>
              {isSelected && (
                <button
                  className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full p-0.5 hover:bg-red-600 z-10"
                  onClick={(e) => { e.stopPropagation(); deleteNode(node.id); }}
                  title="Remover nó"
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
        allNodes={nodes}
        onUpdate={updateNode}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
