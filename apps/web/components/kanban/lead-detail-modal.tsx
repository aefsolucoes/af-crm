'use client';
import { useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, MessageCircle } from 'lucide-react';
import { LeadHeader } from '@/components/lead/lead-header';
import { LeadSidebar } from '@/components/lead/lead-sidebar';
import { LeadTasks } from '@/components/lead/lead-tasks';
import { LeadDetail } from '@/types';
import api from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';

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

  function goToWhatsApp() {
    if (!leadId) return;
    router.push(`/inbox?leadId=${leadId}`);
    onClose();
  }

  if (!leadId) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div
        className="app-column-surface rounded-2xl shadow-2xl w-full max-w-4xl h-[85vh] flex flex-col overflow-hidden"
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
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            <LeadHeader lead={lead} onStageChange={handleRefresh} />
            <div className="flex flex-1 overflow-hidden">
              <LeadSidebar lead={lead} onRefresh={handleRefresh} />
              <div className="w-72 flex-shrink-0 border-l border-af-border overflow-hidden flex flex-col">
                <LeadTasks
                  tasks={lead.tasks}
                  notes={lead.notes}
                  leadId={lead.id}
                  onRefresh={handleRefresh}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
