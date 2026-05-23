import { MessageSquare, Clock, GitBranch, Database, UserCheck, ArrowRight, Users } from 'lucide-react';

export interface FlowNode {
  id: string;
  type: NodeType;
  label: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
}

export type NodeType = 'message' | 'wait' | 'condition' | 'collect' | 'assign' | 'move_stage' | 'human';

export const NODE_TYPES: { type: NodeType; label: string; icon: React.ReactNode; color: string; description: string }[] = [
  { type: 'message', label: 'Mensagem', icon: <MessageSquare size={14} />, color: '#2261a8', description: 'Envia uma mensagem ao lead' },
  { type: 'wait', label: 'Aguardar Resposta', icon: <Clock size={14} />, color: '#f59e0b', description: 'Aguarda resposta do lead' },
  { type: 'condition', label: 'Condição', icon: <GitBranch size={14} />, color: '#8b5cf6', description: 'Bifurca o fluxo por condição' },
  { type: 'collect', label: 'Coletar Dado', icon: <Database size={14} />, color: '#10b981', description: 'Coleta informação do lead' },
  { type: 'assign', label: 'Atribuir Lead', icon: <UserCheck size={14} />, color: '#3b82f6', description: 'Atribui lead a um agente' },
  { type: 'move_stage', label: 'Mover Estágio', icon: <ArrowRight size={14} />, color: '#f97316', description: 'Move o lead para outro estágio' },
  { type: 'human', label: 'Passar p/ Humano', icon: <Users size={14} />, color: '#ef4444', description: 'Encaminha para atendimento humano' },
];

export function getNodeMeta(type: NodeType) {
  return NODE_TYPES.find((n) => n.type === type)!;
}
