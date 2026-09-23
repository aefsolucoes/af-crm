'use client';
import { useEffect, useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, MessageCircle, LayoutList, ListChecks } from 'lucide-react';
import { LeadHeaderTop, LeadHeaderActions } from '@/components/lead/lead-header';
import { LeadSidebar } from '@/components/lead/lead-sidebar';
import { LeadTasks } from '@/components/lead/lead-tasks';
import { LeadMetaPanel } from '@/components/lead/lead-meta-panel';
import { LeadDetail } from '@/types';
import api from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { useIsMobile } from '@/hooks/use-media-query';

async function fetchLead(id: string): Promise<LeadDetail> {
  const { data } = await api.get(`/api/leads/${id}`);
  return data;
}

interface LeadDetailModalProps {
  leadId: string | null;
  onClose: () => void;
}

export function LeadDetailModal({ leadId, onClose }: LeadDetailModalProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  // No mobile os dois lados não cabem um do lado do outro nem empilhados de
  // forma legível (viravam um scroll só, gigante e "misturado" — usuário
  // reportou exatamente isso). Mesma solução que já funcionou no painel da
  // Inbox (InboxLeadPanel): abas Dados/Atividades, um bloco por vez.
  const [mobileTab, setMobileTab] = useState<'dados' | 'atividades'>('dados');

  const { data: lead, isLoading, refetch } = useQuery({
    queryKey: ['lead', leadId],
    queryFn: () => fetchLead(leadId!),
    enabled: !!leadId,
    staleTime: 0,
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (leadId) document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [leadId, onClose]);

  const handleRefresh = useCallback(() => {
    refetch();
    queryClient.invalidateQueries({ queryKey: ['leads'] });
  }, [refetch, queryClient]);

  // Arquivar aqui dentro NUNCA deve navegar a página (o modal abre tanto de
  // cima do Funil quanto da Inbox) — só fecha o modal e atualiza a lista de
  // quem chamou (leads do Funil, conversations da Inbox — invalida as duas,
  // já que este componente não sabe de qual das duas telas veio).
  const handleArchived = useCallback(() => {
    onClose();
    queryClient.invalidateQueries({ queryKey: ['leads'] });
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
  }, [onClose, queryClient]);

  function goToWhatsApp() {
    if (!leadId) return;
    router.push(`/inbox?leadId=${leadId}`);
    onClose();
  }

  if (!leadId) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-0 md:p-4 bg-black/40" onClick={onClose}>
      <div
        className="app-column-surface rounded-none md:rounded-2xl shadow-2xl w-full h-full md:max-w-3xl md:h-[75vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Barra de título — estilo janela */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-af-border bg-slate-50 flex-shrink-0">
          <h2 className="text-sm font-semibold text-slate-700">Detalhe do Lead</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={goToWhatsApp}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors"
            >
              <MessageCircle size={13} /> Ir para o WhatsApp
            </button>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors p-1">
              <X size={18} />
            </button>
          </div>
        </div>

        {isLoading || !lead ? (
          <div className="flex-1 p-6 space-y-4">
            <Skeleton className="h-24 w-full" />
            <div className="grid grid-cols-2 gap-4 h-72">
              <Skeleton className="col-span-1" />
              <Skeleton className="col-span-1" />
            </div>
          </div>
        ) : isMobile ? (
          // Mobile: abas Dados/Atividades (um bloco por vez) — mesmo padrão
          // que já funcionou no painel da Inbox (InboxLeadPanel). Empilhar
          // tudo visível de uma vez (like antes) virava um scroll gigante e
          // "misturado", foi o que o usuário reportou.
          <div className="flex-1 flex flex-col overflow-hidden">
            <LeadHeaderTop lead={lead} />
            <LeadHeaderActions lead={lead} onStageChange={handleRefresh} onArchived={handleArchived} />
            <div className="flex border-b border-af-border flex-shrink-0">
              <button
                onClick={() => setMobileTab('dados')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold transition-colors border-b-2 ${
                  mobileTab === 'dados' ? 'border-af-mid text-af-mid' : 'border-transparent text-slate-400 hover:text-slate-600'
                }`}
              >
                <LayoutList size={13} /> Dados
              </button>
              <button
                onClick={() => setMobileTab('atividades')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold transition-colors border-b-2 ${
                  mobileTab === 'atividades' ? 'border-af-mid text-af-mid' : 'border-transparent text-slate-400 hover:text-slate-600'
                }`}
              >
                <ListChecks size={13} /> Atividades
                {(lead.tasks?.filter((t) => !t.done).length ?? 0) > 0 && (
                  <span className="bg-af-mid text-white text-[10px] px-1.5 py-0.5 rounded-full leading-none">
                    {lead.tasks.filter((t) => !t.done).length}
                  </span>
                )}
              </button>
            </div>
            {mobileTab === 'dados' ? (
              <div className="flex-1 min-h-0 flex flex-col overflow-y-auto">
                <LeadMetaPanel lead={lead} onRefresh={handleRefresh} />
                <LeadSidebar lead={lead} onRefresh={handleRefresh} className="w-full flex-1 border-r-0" />
              </div>
            ) : (
              <div className="flex-1 min-h-0">
                <LeadTasks tasks={lead.tasks} notes={lead.notes} leadId={lead.id} onRefresh={handleRefresh} />
              </div>
            )}
          </div>
        ) : (
          // Desktop — layout original, inalterado: ações+dados na coluna da
          // esquerda, responsável/funil/estágio+tarefas numa coluna fixa à
          // direita, lado a lado.
          <div className="flex-1 flex flex-col overflow-hidden">
            <LeadHeaderTop lead={lead} />
            <div className="flex flex-1 overflow-hidden">
              <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
                <LeadHeaderActions lead={lead} onStageChange={handleRefresh} onArchived={handleArchived} />
                <LeadSidebar lead={lead} onRefresh={handleRefresh} className="w-auto flex-1 border-r-0" />
              </div>
              <div className="w-72 flex-shrink-0 border-l border-af-border overflow-hidden flex flex-col">
                <LeadMetaPanel lead={lead} onRefresh={handleRefresh} />
                <div className="flex-1 min-h-0">
                  <LeadTasks tasks={lead.tasks} notes={lead.notes} leadId={lead.id} onRefresh={handleRefresh} />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
