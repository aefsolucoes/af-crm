'use client';
import { Conversation, WhatsAppNumber } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { cn, formatDateTime } from '@/lib/utils';
import { useState } from 'react';
import { Users, UserMinus, Search, X, BadgeCheck } from 'lucide-react';

/** true se a conversa é um grupo: marcada manualmente OU com JID de grupo (@g.us). */
function isGroupConversation(c: Conversation): boolean {
  return c.isGroup === true || !!c.contact?.whatsappPhone?.endsWith('@g.us');
}

/** true se a conversa é da API Oficial (Meta Cloud API) — mensagens têm id `wamid.*`
 *  e não carregam whatsappNumberId (que só existe nos números conectados por QR code). */
function isApiConversation(c: Conversation): boolean {
  const ext = c.messages?.[0]?.externalId;
  return typeof ext === 'string' && ext.startsWith('wamid');
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
  const [search, setSearch] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const groupCount = conversations.filter(isGroupConversation).length;
  const apiCount = conversations.filter((c) => !isGroupConversation(c) && isApiConversation(c)).length;

  const q = search.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');

  const filtered = conversations
    .filter((c) => {
      const isGroup = isGroupConversation(c);
      // Busca por nome ou número — vale sobre qualquer filtro (inclusive grupos).
      if (q) {
        const name = (c.contact?.name || c.name || '').toLowerCase();
        const phone = (c.contact?.whatsappPhone || c.contact?.phone || '').replace(/\D/g, '');
        const hit = name.includes(q) || (qDigits.length >= 3 && phone.includes(qDigits));
        if (!hit) return false;
        return true; // ao buscar, ignora as abas e procura em tudo
      }
      if (filter === 'GROUPS') return isGroup;
      // Nas demais visões, os grupos ficam fora — têm aba própria.
      if (isGroup) return false;
      if (filter === 'ALL') return true;
      // aba da API Oficial (Meta Cloud API)
      if (filter === 'API') return isApiConversation(c);
      // filtro por número de WhatsApp conectado (QR) — API não tem whatsappNumberId
      return (c.whatsappNumber?.id || c.whatsappNumberId) === filter && !isApiConversation(c);
    })
    .sort((a, b) => lastMessageTime(b) - lastMessageTime(a));

  const chip = (active: boolean) =>
    cn(
      'px-2.5 py-1 text-xs rounded-full transition-colors',
      active ? 'bg-[#00a884] text-[#111b21] font-medium' : 'bg-[#202c33] text-[#8696a0] hover:bg-[#2a3942]'
    );

  return (
    <div className="flex flex-col h-full border-r border-[#222e35] bg-[#111b21] w-full md:w-80 flex-shrink-0">
      {/* Busca por nome ou número */}
      <div className="px-3 pt-3">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8696a0] pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pesquisar"
            className="w-full pl-8 pr-8 py-2 text-sm rounded-lg bg-[#202c33] text-[#e9edef] placeholder-[#8696a0] border border-transparent focus:outline-none focus:border-[#00a884]/40"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              title="Limpar busca"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8696a0] hover:text-[#e9edef]"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Channel filter */}
      <div className="px-3 py-3 border-b border-[#222e35]">
        <div className={cn('flex gap-1 flex-wrap', q && 'opacity-40 pointer-events-none')}>
          <button onClick={() => setFilter('ALL')} className={chip(filter === 'ALL')}>
            Todas
          </button>
          {whatsappNumbers.map((n) => (
            <button
              key={n.id}
              onClick={() => setFilter(n.id)}
              title={n.phone ? `+${n.phone}` : n.label}
              className={chip(filter === n.id)}
            >
              {n.label}
            </button>
          ))}
          <button
            onClick={() => setFilter('API')}
            title="Conversas do WhatsApp API oficial (Meta Cloud API)"
            className={cn(chip(filter === 'API'), 'flex items-center gap-1')}
          >
            <BadgeCheck size={12} /> API Oficial{apiCount > 0 ? ` (${apiCount})` : ''}
          </button>
          <button onClick={() => setFilter('GROUPS')} className={cn(chip(filter === 'GROUPS'), 'flex items-center gap-1')}>
            <Users size={12} /> Grupos{groupCount > 0 ? ` (${groupCount})` : ''}
          </button>
        </div>
        {filter === 'GROUPS' && onRefreshGroupNames && (
          <button
            onClick={async () => { setRefreshing(true); try { await onRefreshGroupNames(); } finally { setRefreshing(false); } }}
            disabled={refreshing}
            className="mt-2 w-full text-xs text-[#00a884] hover:text-[#00c49a] underline decoration-dotted disabled:opacity-50"
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
              <div key={i} className="flex gap-3 px-4 py-3 border-b border-[#222e35] animate-pulse">
                <div className="w-9 h-9 bg-[#202c33] rounded-full flex-shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 bg-[#202c33] rounded w-2/3" />
                  <div className="h-3 bg-[#202c33] rounded w-full" />
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
              // No Safari/iOS, um elemento com estilo de :hover (esse tem
              // hover:bg-* e um botão que só aparece com group-hover) gasta
              // o primeiro toque simulando o hover — só o segundo dispara o
              // clique de verdade. Um onTouchStart (mesmo vazio) avisa o
              // WebKit que o toque já está sendo tratado direto, sem passar
              // pela simulação de hover — resolve com um único toque.
              onTouchStart={() => {}}
              className={cn(
                'group w-full flex items-start gap-3 px-4 py-3 border-b border-[#222e35] text-left transition-colors cursor-pointer',
                selectedId === conv.id ? 'bg-[#2a3942]' : 'hover:bg-[#202c33]'
              )}
            >
              <div className="relative flex-shrink-0">
                <Avatar name={conv.contact?.name || conv.name} size="md" />
                {ch && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-[#111b21]"
                    style={{ backgroundColor: '#25D366' }}
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-[#e9edef] truncate flex items-center gap-1.5">
                    {isGroup && (
                      <span className="flex-shrink-0 text-[10px] font-semibold uppercase tracking-wide bg-[#202c33] text-[#8696a0] px-1.5 py-0.5 rounded">Grupo</span>
                    )}
                    <span className="truncate">{conv.contact?.name || conv.name}</span>
                  </span>
                  {lastMsg && <span className={cn('text-xs flex-shrink-0 ml-1', unread > 0 ? 'text-[#00a884]' : 'text-[#8696a0]')}>{formatDateTime(lastMsg.createdAt)}</span>}
                </div>
                {lastMsg && (
                  <p className="text-xs text-[#8696a0] truncate mt-0.5">{lastMsg.content}</p>
                )}
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                {unread > 0 && (
                  <span className="bg-[#00a884] text-[#111b21] text-xs rounded-full min-w-5 h-5 px-1.5 flex items-center justify-center font-semibold">
                    {unread}
                  </span>
                )}
                {onToggleGroup && (
                  <span
                    role="button"
                    tabIndex={0}
                    title={isGroup ? 'Tirar de Grupos' : 'Mover para Grupos'}
                    onClick={(e) => { e.stopPropagation(); onToggleGroup(conv.id, !isGroup); }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-[#8696a0] hover:text-[#e9edef] p-0.5 rounded hover:bg-[#2a3942]"
                  >
                    {isGroup ? <UserMinus size={14} /> : <Users size={14} />}
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {!loading && filtered.length === 0 && (
          <div className="flex items-center justify-center h-40 text-[#8696a0] text-sm">
            Nenhuma conversa encontrada
          </div>
        )}
      </div>
    </div>
  );
}
