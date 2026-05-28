'use client';
import { useState, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { LeadHeader } from '@/components/lead/lead-header';
import { ChatWindow } from '@/components/inbox/chat-window';
import { LeadTasks } from '@/components/lead/lead-tasks';
import { LeadSidebar } from '@/components/lead/lead-sidebar';
import { LeadDetail, Message } from '@/types';
import api from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

async function fetchLead(id: string): Promise<LeadDetail> {
  const { data } = await api.get(`/api/leads/${id}`);
  return data;
}

export default function LeadDetailClient() {
  const params = useParams();
  const id = (params?.id as string) || '';
  const router = useRouter();

  const [localMessages, setLocalMessages] = useState<Message[]>([]);

  const { data: lead, isLoading, refetch } = useQuery({
    queryKey: ['lead', id],
    queryFn: () => fetchLead(id),
    refetchOnMount: 'always',
    staleTime: 0,
    enabled: !!id,
  });

  const handleNewMessage = useCallback((msg: Message) => {
    setLocalMessages(prev => [...prev, msg]);
  }, []);

  // Merge server messages + local (optimistic)
  const allMessages = lead
    ? [...lead.messages, ...localMessages.filter(m => !lead.messages.find(x => x.id === m.id))]
    : [];

  // Nome do lead: participante_1 / participante_2
  const cf = (lead?.customFields || {}) as Record<string, string>;
  const p1 = cf.participante_1 || lead?.contact?.name || lead?.name || '';
  const p2 = cf.participante_2;
  const displayName = p2 ? `${p1} / ${p2}` : p1;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Detalhe do Lead" />
      <div className="px-6 py-2 bg-white border-b border-af-border">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft size={14} />
          Voltar
        </Button>
      </div>

      {isLoading ? (
        <div className="flex-1 p-6 space-y-4">
          <Skeleton className="h-24 w-full" />
          <div className="grid grid-cols-3 gap-4 h-96">
            <Skeleton className="col-span-1" />
            <Skeleton className="col-span-1" />
            <Skeleton className="col-span-1" />
          </div>
        </div>
      ) : lead ? (
        <>
          <LeadHeader lead={lead} onStageChange={refetch} />
          <div className="flex flex-1 overflow-hidden">
            {/* Sidebar esquerda: campos personalizados */}
            <LeadSidebar lead={lead} onRefresh={refetch} />

            {/* Centro: conversa WhatsApp */}
            <div className="flex-1 overflow-hidden relative">
              <ChatWindow
                leadId={lead.id}
                leadName={displayName}
                messages={allMessages}
                onNewMessage={handleNewMessage}
              />
            </div>

            {/* Painel direito: tarefas, notas, histórico */}
            <div className="w-72 flex-shrink-0 border-l border-af-border overflow-hidden flex flex-col">
              <LeadTasks
                tasks={lead.tasks}
                notes={lead.notes}
                leadId={lead.id}
                onRefresh={refetch}
              />
            </div>
          </div>
        </>
      ) : (
        <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
          Lead não encontrado
        </div>
      )}
    </div>
  );
}
