'use client';
import { useRouter, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { LeadHeader } from '@/components/lead/lead-header';
import { LeadTimeline } from '@/components/lead/lead-timeline';
import { LeadTasks } from '@/components/lead/lead-tasks';
import { LeadSidebar } from '@/components/lead/lead-sidebar';
import { LeadDetail } from '@/types';
import api from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

async function fetchLead(id: string): Promise<LeadDetail> {
  const { data } = await api.get(`/api/leads/${id}`);
  return data;
}

export default function LeadDetailClient() {
  const pathname = usePathname();
  const id = pathname.split('/').pop() || '';
  const router = useRouter();

  const { data: lead, isLoading, refetch } = useQuery({
    queryKey: ['lead', id],
    queryFn: () => fetchLead(id),
  });

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
          <Skeleton className="h-10 w-full" />
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
            <LeadSidebar lead={lead} onRefresh={refetch} />
            <div className="flex-1 overflow-hidden">
              <LeadTimeline messages={lead.messages} />
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
        <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">
          Lead não encontrado
        </div>
      )}
    </div>
  );
}
