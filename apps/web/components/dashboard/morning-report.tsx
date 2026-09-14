'use client';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import api from '@/lib/api';
import { Sun, CheckSquare, MessageCircle, AlertCircle } from 'lucide-react';

interface MorningData {
  user: { name: string };
  numbers: { id: string; label: string }[];
  tasks: { id: string; title: string; dueAt: string; overdue: boolean; leadId: string | null; leadName: string | null }[];
  clients: { leadId: string; name: string; phone: string | null; lastMessage: string; at: string | null }[];
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

export function MorningReport() {
  const { data, isLoading } = useQuery({
    queryKey: ['morning-report'],
    queryFn: async () => (await api.get('/api/reports/morning')).data as MorningData,
    refetchInterval: 5 * 60 * 1000,
  });

  if (isLoading || !data) {
    return <div className="rounded-2xl border border-af-border bg-af-navy/90 h-40 animate-pulse" />;
  }

  const firstName = data.user.name.split(' ')[0];
  const nothing = data.tasks.length === 0 && data.clients.length === 0;

  return (
    <div className="rounded-2xl bg-af-navy text-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <Sun size={20} className="text-amber-300" />
        <h2 className="text-lg font-semibold">{greeting()}, {firstName}!</h2>
      </div>
      <p className="text-sm text-white/80 mt-1">
        {nothing
          ? 'Tudo em dia por aqui — nenhuma tarefa pendente nem cliente esperando. 🎉'
          : `Hoje você tem ${data.tasks.length} tarefa(s) e ${data.clients.length} cliente(s) esperando resposta.`}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        {/* Tarefas */}
        <div className="bg-white/10 rounded-xl p-3.5 min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold mb-2"><CheckSquare size={15} /> Suas tarefas</div>
          {data.tasks.length === 0 ? (
            <p className="text-xs text-white/60">Nenhuma tarefa pra hoje. 👏</p>
          ) : (
            <ul className="space-y-1.5">
              {data.tasks.slice(0, 6).map((t) => (
                <li key={t.id} className="text-sm flex items-start gap-1.5">
                  {t.overdue && <AlertCircle size={13} className="text-amber-300 mt-0.5 flex-shrink-0" aria-label="Atrasada" />}
                  <span className="flex-1">{t.title}{t.leadName ? <span className="text-white/60"> · {t.leadName}</span> : null}</span>
                </li>
              ))}
            </ul>
          )}
          {data.tasks.length > 6 && (
            <Link href="/tarefas" className="text-xs text-white/70 underline mt-2 inline-block">ver todas ({data.tasks.length})</Link>
          )}
        </div>

        {/* Clientes esperando resposta */}
        <div className="bg-white/10 rounded-xl p-3.5 min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold mb-2">
            <MessageCircle size={15} /> Clientes esperando resposta {data.numbers.length ? <span className="text-white/50 font-normal">· {data.numbers.map((n) => n.label).join(', ')}</span> : null}
          </div>
          {!data.numbers.length ? (
            <p className="text-xs text-amber-200">Peça a um admin pra liberar a API Oficial pra você em Usuários.</p>
          ) : data.clients.length === 0 ? (
            <p className="text-xs text-white/60">Ninguém esperando — tudo respondido. 👏</p>
          ) : (
            <ul className="space-y-1.5">
              {data.clients.slice(0, 6).map((c) => (
                <li key={c.leadId} className="text-sm truncate">
                  <Link href={`/inbox?leadId=${c.leadId}`} className="hover:underline">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-white/60"> — {c.lastMessage}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {data.clients.length > 6 && (
            <Link href="/inbox" className="text-xs text-white/70 underline mt-2 inline-block">ver na Inbox ({data.clients.length})</Link>
          )}
        </div>
      </div>
    </div>
  );
}
