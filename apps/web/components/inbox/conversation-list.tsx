'use client';
import { Conversation, WhatsAppNumber } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { cn, formatDateTime } from '@/lib/utils';
import { useState } from 'react';
import { Users, UserMinus } from 'lucide-react';

/** true se a conversa é um grupo: marcada manualmente OU com JID de grupo (@g.us). */
function isGroupConversation(c: Conversation): boolean {
  return c.isGroup === true || !!c.contact?.whatsappPhone?.endsWith('@g.us');
}

/** data da última mensagem (para ordenar as conversas) */
function lastMessageTime(c: Conversation): number {
  const t = c.messages?.[0]?.createdAt || c.updatedAt;
  return t ? new Date(t).getTime() : 0;
}

interface ConversationListProps {
  conversations: Conversation[];
  selectedId?: string;
  onSelect: (id: string) => void;
  onToggleGroup?: (id: string, isGroup: boolean) => void;
  onRefreshGroupNames?: () => Promise<void>;
  whatsappNumbers?: WhatsAppNumber[];
  loading?: boolean;
}

// 'ALL' | 'GROUPS' | <whatsappNumberId>
type Filter = string;

export function ConversationList({ conversations, selectedId, onSelect, onToggleGroup, onRefreshGroupNames, whatsappNumbers = [], loading }: ConversationListProps) {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [refreshing, setRefreshing] = useState(false);

  const groupCount = conversations.filter(isGroupConversation).length;

  const filtered = conversations
    .filter((c) => {
      const isGroup = isGroupConversation(c);
      if (filter === 'GROUPS') return isGroup;
      // Nas demais visões, os grupos ficam fora — têm aba própria.
      if (isGroup) return false;
      if (filter === 'ALL') return true;
      // filtro por número de WhatsApp conectado
      return (c.whatsappNumber?.id || c.whatsappNumberId) === filter;
    })
    .sort((a, b) => lastMessageTime(b) - lastMessageTime(a));

  return (
    <div className="flex flex-col h-full border-r border-af-border app-column-surface w-80 flex-shrink-0">
      {/* Channel filter */}
      <div className="px-3 py-3 border-b border-af-border">
        <div className="flex gap-1 flex-wrap">
          <button
            onClick={() => setFilter('ALL')}
            className={cn('px-2 py-1 text-xs rounded-full transition-colors', filter === 'ALL' ? 'bg-af-mid text-white' : 'bg-af-light text-af-mid hover:bg-af-border')}
          >
            Todos
          </button>
          {whatsappNumbers.map((n) => (
            <button
              key={n.id}
              onClick={() => setFilter(n.id)}
              title={n.phone ? `+${n.phone}` : n.label}
              className={cn('px-2 py-1 text-xs rounded-full transition-colors', filter === n.id ? 'bg-af-mid text-white' : 'bg-af-light text-af-mid hover:bg-af-border')}
            >
              {n.label}
            </button>
          ))}
          <button
            onClick={() => setFilter('GROUPS')}
            className={cn('px-2 py-1 text-xs rounded-full transition-colors flex items-center gap-1', filter === 'GROUPS' ? 'bg-af-mid text-white' : 'bg-af-light text-af-mid hover:bg-af-border')}
          >
            <Users size={12} /> Grupos{groupCount > 0 ? ` (${groupCount})` : ''}
          </button>
        </div>
        {filter === 'GROUPS' && onRefreshGroupNames && (
          <button
            onClick={async () => { setRefreshing(true); try { await onRefreshGroupNames(); } finally { setRefreshing(false); } }}
            disabled={refreshing}
            className="mt-2 w-full text-xs text-af-mid hover:text-af-dark underline decoration-dotted disabled:opacity-50"
          >
            {refreshing ? 'Atualizando nomes…' : 'Atualizar nomes dos grupos'}
          </button>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {loading && (
          <div className="flex flex-col gap-0">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="flex gap-3 px-4 py-3 border-b border-af-border/50 animate-pulse">
                <div className="w-9 h-9 bg-slate-200 rounded-full flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-slate-200 rounded w-2/3" />
                  <div className="h-3 bg-slate-200 rounded w-full" />
                </div>
              </div>
            ))}
          </div>
        )}
        {filtered.map((conv) => {
          const lastMsg = conv.messages[0];
          const unread = conv._count.messages;
          const ch = lastMsg?.channel;
          const isGroup = isGroupConversation(conv);
          return (
            <div
              key={conv.id}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(conv.id)}
              className={cn(
                'group w-full flex items-start gap-3 px-4 py-3 border-b border-af-border/40 text-left transition-colors hover:bg-af-light cursor-pointer',
                selectedId === conv.id ? 'bg-af-light' : ''
              )}
            >
              <div className="relative flex-shrink-0">
                <Avatar name={conv.contact?.name || conv.name} size="md" />
                {ch && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white"
                    style={{ backgroundColor: '#25D366' }}
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-900 truncate flex items-center gap-1.5">
                    {isGroup && (
                      <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide bg-af-light text-af-mid px-1.5 py-0.5 rounded">Grupo</span>
                    )}
                    <span className="truncate">{conv.contact?.name || conv.name}</span>
                  </span>
                  {lastMsg && <span className="text-xs text-slate-400 flex-shrink-0 ml-1">{formatDateTime(lastMsg.createdAt)}</span>}
                </div>
                {lastMsg && (
                  <p className="text-xs text-slate-500 truncate mt-0.5">{lastMsg.content}</p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                {unread > 0 && (
                  <span className="bg-af-mid text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-medium">
                    {unread}
                  </span>
                )}
                {onToggleGroup && (
                  <span
                    role="button"
                    tabIndex={0}
                    title={isGroup ? 'Tirar de Grupos' : 'Mover para Grupos'}
                    onClick={(e) => { e.stopPropagation(); onToggleGroup(conv.id, !isGroup); }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-af-mid hover:text-af-dark p-0.5 rounded hover:bg-af-border/50"
                  >
                    {isGroup ? <UserMinus size={14} /> : <Users size={14} />}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {!loading && filtered.length === 0 && (
          <div className="flex items-center justify-center h-40 text-slate-400 text-sm">
            Nenhuma conversa encontrada
          </div>
        )}
      </div>
    </div>
  );
}
