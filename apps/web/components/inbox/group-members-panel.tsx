'use client';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { Avatar } from '@/components/ui/avatar';
import { Users, ShieldCheck } from 'lucide-react';

interface Member { phone: string; name: string | null; isAdmin: boolean; }
interface GroupMembers { subject: string; count: number; members: Member[]; }

function fmtPhone(d: string): string {
  if (!d) return '';
  const s = d.startsWith('55') && d.length > 10 ? d.slice(2) : d;
  const ddd = s.slice(0, 2);
  const rest = s.slice(2);
  if (rest.length >= 8) return `(${ddd}) ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
  return `+${d}`;
}

export function GroupMembersPanel({ leadId, groupName }: { leadId: string; groupName: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['group-members', leadId],
    queryFn: async () => (await api.get(`/api/whatsapp-qr/group/${leadId}/members`)).data as GroupMembers,
    retry: false,
  });

  return (
    <div className="w-80 flex-shrink-0 border-l border-af-border bg-white flex flex-col h-full">
      <div className="px-4 py-4 border-b border-af-border">
        <div className="flex items-center gap-2 text-af-mid mb-1">
          <Users size={16} />
          <span className="text-xs font-semibold uppercase tracking-wide">Grupo</span>
        </div>
        <p className="text-sm font-semibold text-slate-800 leading-tight break-words">{data?.subject || groupName}</p>
        {data && <p className="text-xs text-slate-400 mt-0.5">{data.count} integrante{data.count !== 1 ? 's' : ''}</p>}
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {isLoading && <div className="p-4 text-sm text-slate-400">Carregando integrantes…</div>}
        {isError && (
          <div className="p-4 text-sm text-slate-400">
            Não consegui carregar os integrantes agora. O número do WhatsApp precisa estar conectado (Configurações → QR Code).
          </div>
        )}
        {data?.members.map((m, i) => {
          const display = m.name || fmtPhone(m.phone);
          return (
            <div key={i} className="flex items-center gap-3 px-4 py-2.5 border-b border-af-border/40">
              <Avatar name={display} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-slate-800 truncate">{display}</p>
                {m.name && <p className="text-xs text-slate-400 truncate">{fmtPhone(m.phone)}</p>}
              </div>
              {m.isAdmin && (
                <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full flex-shrink-0">
                  <ShieldCheck size={10} /> Admin
                </span>
              )}
            </div>
          );
        })}
        {data && data.members.length === 0 && (
          <div className="p-4 text-sm text-slate-400">Nenhum integrante encontrado.</div>
        )}
      </div>
    </div>
  );
}
