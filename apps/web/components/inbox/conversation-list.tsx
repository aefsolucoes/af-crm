'use client';
import { Conversation, Channel } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { cn, CHANNEL_COLORS, CHANNEL_LABELS, formatDateTime } from '@/lib/utils';
import { useState } from 'react';

const CHANNELS: Channel[] = ['WHATSAPP'];

/** true se a conversa é um grupo do WhatsApp (JID @g.us). */
function isGroupConversation(c: Conversation): boolean {
  return !!c.contact?.whatsappPhone?.endsWith('@g.us');
}

interface ConversationListProps {
  conversations: Conversation[];
  selectedId?: string;
  onSelect: (id: string) => void;
  loading?: boolean;
}

type Filter = 'ALL' | 'GROUPS' | Channel;

export function ConversationList({ conversations, selectedId, onSelect, loading }: ConversationListProps) {
  const [filter, setFilter] = useState<Filter>('ALL');

  const groupCount = conversations.filter(isGroupConversation).length;

  const filtered = conversations.filter((c) => {
    const isGroup = isGroupConversation(c);
    if (filter === 'GROUPS') return isGroup;
    // Nas demais visões (Todos / WhatsApp), os grupos ficam fora — têm aba própria.
    if (isGroup) return false;
    if (filter === 'ALL') return true;
    return c.messages[0]?.channel === filter;
  });

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
          {CHANNELS.map((ch) => (
            <button
              key={ch}
              onClick={() => setFilter(ch)}
              className={cn('px-2 py-1 text-xs rounded-full transition-colors', filter === ch ? 'text-white' : 'bg-af-light text-af-mid hover:bg-af-border')}
              style={filter === ch ? { backgroundColor: CHANNEL_COLORS[ch] } : {}}
            >
              {CHANNEL_LABELS[ch]}
            </button>
          ))}
          {groupCount > 0 && (
            <button
              onClick={() => setFilter('GROUPS')}
              className={cn('px-2 py-1 text-xs rounded-full transition-colors', filter === 'GROUPS' ? 'bg-af-mid text-white' : 'bg-af-light text-af-mid hover:bg-af-border')}
            >
              Grupos ({groupCount})
            </button>
          )}
        </div>
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
          return (
            <button
              key={conv.id}
              onClick={() => onSelect(conv.id)}
              className={cn(
                'w-full flex items-start gap-3 px-4 py-3 border-b border-af-border/40 text-left transition-colors hover:bg-af-light',
                selectedId === conv.id ? 'bg-af-light' : ''
              )}
            >
              <div className="relative flex-shrink-0">
                <Avatar name={conv.contact?.name || conv.name} size="md" />
                {ch && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-white"
                    style={{ backgroundColor: CHANNEL_COLORS[ch] }}
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-900 truncate flex items-center gap-1.5">
                    {isGroupConversation(conv) && (
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
              {unread > 0 && (
                <span className="flex-shrink-0 bg-af-mid text-white text-xs rounded-full w-5 h-5 flex items-center justify-center font-medium">
                  {unread}
                </span>
              )}
            </button>
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
