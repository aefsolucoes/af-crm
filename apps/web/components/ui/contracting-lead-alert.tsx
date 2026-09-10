'use client';
import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Modal } from '@/components/ui/modal';
import { getSocket } from '@/lib/socket';
import { FileText, MessageCircle } from 'lucide-react';

/**
 * Popup "cliente chegou pra contratação". O backend (PATCH /leads/:id/stage,
 * ao entrar na etapa "Fechado") emite `contracting_lead` só pros usuários do
 * setor do lead (Financiamento Habitacional ou Home Equity), via a sala
 * user_<id>. Então quem não é do setor nunca recebe — o componente fica
 * montado no layout pra todos, mas só abre pra quem o servidor avisou.
 *
 * Vários leads seguidos entram numa fila; o popup mostra um por vez.
 */
interface ContractingLead {
  leadId: string;
  leadName: string;
  pipelineName: string;
}

export function ContractingLeadAlert() {
  const router = useRouter();
  const [queue, setQueue] = useState<ContractingLead[]>([]);
  const current = queue[0] || null;

  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();
    function onContracting(data: ContractingLead) {
      if (!data?.leadId) return;
      setQueue((q) => (q.some((x) => x.leadId === data.leadId) ? q : [...q, data]));
    }
    socket.on('contracting_lead', onContracting);
    return () => { socket.off('contracting_lead', onContracting); };
  }, []);

  const dismissCurrent = useCallback(() => setQueue((q) => q.slice(1)), []);

  const goToCard = useCallback(() => {
    if (current) router.push(`/leads/${current.leadId}`);
    dismissCurrent();
  }, [current, router, dismissCurrent]);

  const goToChat = useCallback(() => {
    if (current) router.push(`/inbox?leadId=${current.leadId}`);
    dismissCurrent();
  }, [current, router, dismissCurrent]);

  if (!current) return null;

  return (
    <Modal title="Cliente pronto para contratação" onClose={dismissCurrent} size="sm">
      <div className="space-y-3 text-sm text-slate-600">
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-800">
          <strong>{current.leadName}</strong> foi fechado e entrou no funil{' '}
          <strong>{current.pipelineName}</strong>. Faça o atendimento da contratação.
        </div>
        {queue.length > 1 && (
          <p className="text-xs text-slate-400">+{queue.length - 1} outro(s) cliente(s) na fila.</p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2 mt-5">
        <button onClick={dismissCurrent} className="text-sm px-3 py-1.5 rounded-lg text-slate-500 hover:text-slate-700">
          Depois
        </button>
        <button
          onClick={goToChat}
          className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-af-border text-slate-700 hover:bg-slate-50"
        >
          <MessageCircle size={14} /> Abrir conversa
        </button>
        <button
          onClick={goToCard}
          className="flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-lg text-white font-medium"
          style={{ backgroundColor: '#2261a8' }}
        >
          <FileText size={14} /> Abrir card
        </button>
      </div>
    </Modal>
  );
}
