'use client';
import { useState, useCallback, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { LeadHeader } from '@/components/lead/lead-header';
import { ChatWindow } from '@/components/inbox/chat-window';
import { LeadTasks } from '@/components/lead/lead-tasks';
import { LeadSidebar } from '@/components/lead/lead-sidebar';
import { LeadDetail, Message } from '@/types';
import api from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

async function fetchLead(id: string): Promise<LeadDetail> {
  const { data } = await api.get(`/api/leads/${id}`);
  return data;
}

interface Props {
  id: string;
}

export default function LeadDetailClient({ id: propId }: Props) {
  const router = useRouter();
  const pathname = usePathname();

  // Com Cloudflare Pages (output: 'export'), o Next.js pré-gera a página com
  // id='placeholder'. No cliente, lemos o id real direto da URL do browser.
  const [id, setId] = useState<string>(
    propId && propId !== 'placeholder' ? propId : ''
  );

  // Re-executa quando o pathname muda (inclui navegação para o mesmo card)
  useEffect(() => {
    const urlId = window.location.pathname.split('/').pop();
    if (urlId && urlId !== 'placeholder') {
      setId(urlId);
    }
  }, [pathname]);

  const [localMessages, setLocalMessages] = useState<Message[]>([]);

  const { data: lead, isLoading, isError, refetch } = useQuery({
    queryKey: ['lead', id],
    queryFn: () => fetchLead(id),
    refetchOnMount: 'always',
    staleTime: 0,
    enabled: !!id && id !== 'placeholder',
    retry: 1,
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

  const isWaiting = !id || id === 'placeholder';

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Detalhe do Lead" />
      <div className="px-6 py-2 bg-white border-b border-af-border">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft size={14} />
          Voltar
        </Button>
      </div>

      {isWaiting || isLoading ? (
        <div className="flex-1 p-6 space-y-4">
          <Skeleton className="h-24 w-full" />
          <div className="grid grid-cols-3 gap-4 h-96">
            <Skeleton className="col-span-1" />
            <Skeleton className="col-span-1" />
            <Skeleton className="col-span-1" />
          </div>
        </div>
      ) : isError ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400 text-sm">
          <p>Erro ao carregar lead. Verifique sua conexão.</p>
          <Button variant="secondary" size="sm" onClick={() => refetch()}>
            <RefreshCw size={13} />
            Tentar novamente
          </Button>
        </div>
      ) : lead ? (
        <>
          <LeadHeader lead={lead} onStageChange={refetch} />
          <div className="flex flex-1 overflow-hidden">
            <LeadSidebar lead={lead} onRefresh={refetch} />

            <div className="flex-1 overflow-hidden relative">
              <ChatWindow
                leadId={lead.id}
                leadName={displayName}
                messages={allMessages}
                onNewMessage={handleNewMessage}
              />
            </div>

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
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400 text-sm">
          <p>Lead não encontrado.</p>
          <Button variant="secondary" size="sm" onClick={() => refetch()}>
            <RefreshCw size={13} />
            Tentar novamente
          </Button>
        </div>
      )}
    </div>
  );
}
