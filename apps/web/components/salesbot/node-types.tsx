'use client';
import {
  MessageSquare, Heart, MessageCircle, Mail, List, Pause,
  Layers, Zap, GitBranch, CheckCircle2, ArrowRightCircle,
  PlayCircle, Code2, LayoutDashboard, RefreshCw, StopCircle,
} from 'lucide-react';

export type NodeType =
  | 'send_message'
  | 'reaction'
  | 'comment'
  | 'internal_message'
  | 'list_message'
  | 'pause'
  | 'subscribe_meta'
  | 'action'
  | 'condition'
  | 'validation'
  | 'goto_step'
  | 'start_salesbot'
  | 'custom_step'
  | 'widget'
  | 'round_robin'
  | 'stop_salesbot';

export interface FlowNode {
  id: string;
  type: NodeType;
  label: string;
  x: number;
  y: number;
  config: Record<string, unknown>;
  connections?: string[];
}

interface NodeMeta {
  type: NodeType;
  label: string;
  icon: React.ReactNode;
  color: string;
  description: string;
}

export const NODE_TYPES: NodeMeta[] = [
  {
    type: 'send_message',
    label: 'Enviar mensagem',
    icon: <MessageSquare size={14} />,
    color: '#2261a8',
    description: 'Envia uma mensagem de texto ao lead',
  },
  {
    type: 'reaction',
    label: 'Reação',
    icon: <Heart size={14} />,
    color: '#e11d48',
    description: 'Reage a uma mensagem com emoji',
  },
  {
    type: 'comment',
    label: 'Comentário',
    icon: <MessageCircle size={14} />,
    color: '#e11d48',
    description: 'Adiciona um comentário na conversa',
  },
  {
    type: 'internal_message',
    label: 'Mensagem interna',
    icon: <Mail size={14} />,
    color: '#64748b',
    description: 'Envia uma mensagem interna para a equipe',
  },
  {
    type: 'list_message',
    label: 'List Message (WhatsApp)',
    icon: <List size={14} />,
    color: '#25d366',
    description: 'Envia uma lista interativa do WhatsApp',
  },
  {
    type: 'pause',
    label: 'Pausar',
    icon: <Pause size={14} />,
    color: '#64748b',
    description: 'Aguarda por um tempo ou resposta do lead',
  },
  {
    type: 'subscribe_meta',
    label: 'Inscrever-se (Meta)',
    icon: <Layers size={14} />,
    color: '#0082fb',
    description: 'Inscreve o lead em uma sequência Meta/Facebook',
  },
  {
    type: 'action',
    label: 'Ação',
    icon: <Zap size={14} />,
    color: '#16a34a',
    description: 'Executa uma ação no CRM (mover, atribuir, marcar)',
  },
  {
    type: 'condition',
    label: 'Condição',
    icon: <GitBranch size={14} />,
    color: '#7c3aed',
    description: 'Bifurca o fluxo com base em uma condição',
  },
  {
    type: 'validation',
    label: 'Validação',
    icon: <CheckCircle2 size={14} />,
    color: '#16a34a',
    description: 'Valida dados do lead (e-mail, CPF, telefone)',
  },
  {
    type: 'goto_step',
    label: 'Ir para outra etapa',
    icon: <ArrowRightCircle size={14} />,
    color: '#0891b2',
    description: 'Redireciona para outra etapa do fluxo',
  },
  {
    type: 'start_salesbot',
    label: 'Iniciar Salesbot',
    icon: <PlayCircle size={14} />,
    color: '#059669',
    description: 'Inicia outro salesbot a partir deste ponto',
  },
  {
    type: 'custom_step',
    label: 'Etapa adaptada (cód.)',
    icon: <Code2 size={14} />,
    color: '#0891b2',
    description: 'Executa código JavaScript personalizado',
  },
  {
    type: 'widget',
    label: 'Widget',
    icon: <LayoutDashboard size={14} />,
    color: '#2563eb',
    description: 'Exibe um widget interativo ao lead',
  },
  {
    type: 'round_robin',
    label: 'Round Robin',
    icon: <RefreshCw size={14} />,
    color: '#d97706',
    description: 'Distribui o lead entre agentes em rodízio',
  },
  {
    type: 'stop_salesbot',
    label: 'Parar Salesbot',
    icon: <StopCircle size={14} />,
    color: '#dc2626',
    description: 'Encerra a execução do salesbot',
  },
];

export function getNodeMeta(type: NodeType): NodeMeta {
  return NODE_TYPES.find((n) => n.type === type) ?? NODE_TYPES[0];
}
