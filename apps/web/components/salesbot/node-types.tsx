'use client';
import { MessageSquare, Pause, Zap, GitBranch, CheckCircle2, StopCircle } from 'lucide-react';

// Só os 6 tipos que o motor (apps/api/src/services/salesbot.service.ts) sabe
// executar de verdade — a paleta do editor não oferece mais tipo nenhum que
// não rode. Os outros 10 do mockup original (reação, comentário, mensagem
// interna, list message, subscrever Meta, ir para etapa solto, iniciar outro
// bot, etapa em código, widget, round robin) ficam fora do MVP de propósito
// (ver plano) — reintroduzir qualquer um deles exige dar suporte no motor
// primeiro, senão o fluxo trava com "tipo não suportado" ao chegar nele.
export type StepType = 'send_message' | 'pause' | 'condition' | 'action' | 'validation' | 'stop_salesbot';

interface StepMeta {
  type: StepType;
  label: string;
  icon: React.ReactNode;
  color: string;
  description: string;
}

export const STEP_TYPES: StepMeta[] = [
  {
    type: 'send_message',
    label: 'Enviar mensagem',
    icon: <MessageSquare size={14} />,
    color: '#2261a8',
    description: 'Manda um texto pro lead — com botões de resposta rápida (Sim/Não etc.), se quiser',
  },
  {
    type: 'pause',
    label: 'Pausar',
    icon: <Pause size={14} />,
    color: '#64748b',
    description: 'Aguarda a resposta do lead, ou um tempo determinado, antes de continuar',
  },
  {
    type: 'condition',
    label: 'Condição',
    icon: <GitBranch size={14} />,
    color: '#7c3aed',
    description: 'Bifurca o fluxo com base na última mensagem ou num dado do lead',
  },
  {
    type: 'action',
    label: 'Ação no CRM',
    icon: <Zap size={14} />,
    color: '#16a34a',
    description: 'Move de etapa, atribui a alguém, marca tag ou preenche um campo',
  },
  {
    type: 'validation',
    label: 'Validação',
    icon: <CheckCircle2 size={14} />,
    color: '#16a34a',
    description: 'Confere se a resposta é um e-mail/telefone/CPF válido e guarda no lead',
  },
  {
    type: 'stop_salesbot',
    label: 'Parar bot',
    icon: <StopCircle size={14} />,
    color: '#dc2626',
    description: 'Encerra o fluxo — com uma mensagem de despedida, se quiser',
  },
];

export function getStepMeta(type: string): StepMeta {
  return STEP_TYPES.find((n) => n.type === type) ?? STEP_TYPES[0];
}
