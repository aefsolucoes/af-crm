'use client';
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { Avatar } from '@/components/ui/avatar';
import { Users, ShieldCheck, PanelRightClose } from 'lucide-react';

interface Member { phone: string; name: string | null; isAdmin: boolean; }
interface GroupMembers { subject: string; count: number; members: Member[]; }

function fmtPhone(d: string): string {
  if (!d) return '';
  // LID do Baileys 7 (identificador longo, não é telefone real) — mostra genérico.
  if (d.length > 13) return 'Participante';
  const s = d.startsWith('55') && d.length > 10 ? d.slice(2) : d;
  const ddd = s.slice(0, 2);
  const rest = s.slice(2);
  if (rest.length >= 8) return `(${ddd}) ${rest.slice(0, rest.length - 4)}-${rest.slice(-4)}`;
  return `+${d}`;
}

export function GroupMembersPanel({ leadId, groupName, onHide, className }: { leadId: string; groupName: string; onHide?: () => void; className?: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['group-members', leadId],
    queryFn: async () => (await api.get(`/api/whatsapp-qr/group/${leadId}/members`)).data as GroupMembers,
    retry: false,
  });

  return (
    <div className={cn('w-80 flex-shrink-0 border-l border-[#222e35] bg-[#111b21] flex flex-col h-full', className)}>
      <div className="px-4 py-4 border-b border-[#222e35]">
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2 text-[#00a884]">
            <Users size={16} />
            <span className="text-xs font-semibold uppercase tracking-wide">Grupo</span>
          </div>
          {onHide && (
            <button
              onClick={onHide}
              className="flex-shrink-0 p-1.5 rounded-lg text-[#8696a0] hover:text-[#e9edef] hover:bg-white/10 transition-colors"
              title="Esconder integrantes"
            >
              <PanelRightClose size={18} />
            </button>
          )}
        </div>
        <p className="text-sm font-semibold text-[#e9edef] leading-tight break-words">{data?.subject || groupName}</p>
        {data && <p className="text-xs text-[#8696a0] mt-0.5">{data.count} integrante{data.count !== 1 ? 's' : ''}</p>}
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {isLoading && <div className="p-4 text-sm text-[#8696a0]">Carregando integrantes…</div>}
        {isError && (
          <div className="p-4 text-sm text-[#8696a0]">
            Não consegui carregar os integrantes agora. O número do WhatsApp precisa estar conectado (Configurações → QR Code).
          </div>
        )}
        {data?.members.map((m, i) => {
          const display = m.name || fmtPhone(m.phone);
          const showPhone = m.name && m.phone.length <= 13;
          return (
            <div key={i} className="flex items-center gap-3 px-4 py-2.5 border-b border-[#222e35]">
              <Avatar name={display} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-[#e9edef] truncate">{display}</p>
                {showPhone && <p className="text-xs text-[#8696a0] truncate">{fmtPhone(m.phone)}</p>}
              </div>
              {m.isAdmin && (
                <span className="flex items-center gap-1 text-[10px] font-semibold text-[#00a884] bg-[#00a884]/15 px-1.5 py-0.5 rounded-full flex-shrink-0">
                  <ShieldCheck size={10} /> Admin
                </span>
              )}
            </div>
          );
        })}
        {data && data.members.length === 0 && (
          <div className="p-4 text-sm text-[#8696a0]">Nenhum integrante encontrado.</div>
        )}
      </div>
    </div>
  );
}
