'use client';
import { Conversation } from '@/types';
import { Avatar } from '@/components/ui/avatar';
import { cn, formatDateTime } from '@/lib/utils';
import { useState, useRef, useLayoutEffect, useEffect, useCallback } from 'react';
import { Search, X, AlertCircle, RefreshCw, Star, Phone } from 'lucide-react';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';

/** true se a conversa é um grupo do WhatsApp (só existiam pelo canal QR,
 *  removido do CRM — grupos ficam de fora da Inbox, mas o Lead/Message
 *  continuam no banco intactos, sem nenhuma exclusão de dado). */
function isGroupConversation(c: Conversation): boolean {
  return c.isGroup === true || !!c.contact?.whatsappPhone?.endsWith('@g.us');
}

/** minúsculo e sem acento — pra "Mônica" achar "Monica" e vice-versa. */
function normalizeSearch(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Busca avançada da Inbox: não precisa ser o nome/número exato.
 *  - Nome: quebra o texto digitado em palavras — cada palavra precisa
 *    aparecer em algum lugar do nome OU dos participantes do card (não
 *    precisa ser a frase inteira nem estar na ordem certa: "silva monica"
 *    acha "Mônica da Silva Santos"). Olha contact.name/lead.name E
 *    customFields.participante_1/2 — o card pode ter o nome corrigido ali
 *    mesmo quando o nome do perfil do WhatsApp ficou errado/apelido.
 *  - Telefone: aceita busca parcial (só os últimos dígitos que a pessoa
 *    lembra) E ignora o "9" a mais/a menos do celular (o Brasil passou a
 *    exigir esse dígito depois de muito número já estar salvo sem ele —
 *    compara pelos últimos 8 dígitos quando o texto digitado é longo o
 *    bastante pra ser um número quase inteiro). */
function matchesSearch(c: Conversation, query: string): boolean {
  const q = normalizeSearch(query.trim());
  const qDigits = query.replace(/\D/g, '');
  if (!q && !qDigits) return true;

  if (qDigits.length >= 4) {
    const cf = c.customFields || {};
    const phones = [c.contact?.whatsappPhone, c.contact?.phone, cf.telefone_1, cf.telefone_2]
      .filter((p): p is string => !!p)
      .map((p) => p.replace(/\D/g, ''));
    const phoneHit = phones.some((p) =>
      p.includes(qDigits) || (qDigits.length >= 8 && p.length >= 8 && p.slice(-8) === qDigits.slice(-8))
    );
    if (phoneHit) return true;
  }

  if (q) {
    const cf = c.customFields || {};
    const haystack = normalizeSearch(
      [c.contact?.name, c.name, cf.participante_1, cf.participante_2].filter(Boolean).join(' ')
    );
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length > 0 && words.every((w) => haystack.includes(w))) return true;
  }

  return false;
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
  loading?: boolean;
  /** A busca das conversas falhou (rede/servidor) — precisa aparecer como ERRO,
   *  nunca como "nenhuma conversa" (some a lista inteira e parece perda de dados). */
  loadError?: boolean;
  onRetry?: () => void;
}

// 'ALL' | 'UNREAD' | 'CALL' — conversas de grupo nunca aparecem em nenhuma aba (ver isGroupConversation).
// CALL = clientes que permitiram ligação pelo WhatsApp (pedido do Fabio 26/09).
type Filter = 'ALL' | 'UNREAD' | 'CALL';

export function ConversationList({ conversations, selectedId, onSelect, loading, loadError, onRetry }: ConversationListProps) {
  const [filter, setFilter] = useState<Filter>('ALL');
  const [search, setSearch] = useState('');

  // Quem permitiu ligação: confirmado ao vivo na Meta pelo servidor; atualiza
  // quando alguém toca em "Permitir ligações" e a cada 2 min (permissão vence).
  const [callPermitted, setCallPermitted] = useState<Set<string>>(new Set());
  const loadCallPermitted = useCallback((fresh = false) => {
    api.get('/api/calls/permitted-leads', { params: fresh ? { fresh: 1 } : {} })
      .then(({ data }) => setCallPermitted(new Set<string>(data.leadIds || [])))
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadCallPermitted();
    const timer = setInterval(() => loadCallPermitted(), 120_000);
    const socket = getSocket();
    const onChange = () => setTimeout(() => loadCallPermitted(true), 1500);
    socket.on('call_permission_granted', onChange);
    socket.on('call_permission_denied', onChange);
    return () => {
      clearInterval(timer);
      socket.off('call_permission_granted', onChange);
      socket.off('call_permission_denied', onChange);
    };
  }, [loadCallPermitted]);

  // Trava a rolagem da lista: quando chega/sai mensagem, a conversa envolvida
  // reordena pra posição 0 normalmente (igual antes) — mas a TELA do usuário
  // não deve se mexer por causa disso (ele pode estar no meio de um
  // follow-up, descendo a lista uma a uma, e tinha que ficar descendo de novo
  // toda vez que respondia). Guarda a posição que o próprio usuário definiu
  // ao rolar, e força de volta pra ela a cada atualização — roda em
  // useLayoutEffect (antes do navegador pintar a tela), então o usuário
  // nunca chega a ver o salto.
  const listRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);

  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = scrollTopRef.current;
  });

  function handleListScroll(e: React.UIEvent<HTMLDivElement>) {
    scrollTopRef.current = e.currentTarget.scrollTop;
  }

  const unreadCount = conversations.filter((c) => !isGroupConversation(c) && c._count.messages > 0).length;
  const callCount = conversations.filter((c) => !isGroupConversation(c) && callPermitted.has(c.id)).length;

  const q = search.trim();

  const filtered = conversations
    .filter((c) => {
      // Busca por nome ou número — vale sobre qualquer filtro.
      if (q) {
        return matchesSearch(c, q); // ao buscar, ignora as abas e procura em tudo
      }
      // Grupos do WhatsApp nunca aparecem na Inbox (o dado continua no banco,
      // só não tem mais como abrir pela tela — o canal QR/Baileys, único que
      // dava acesso a grupos, foi removido do CRM).
      if (isGroupConversation(c)) return false;
      if (filter === 'ALL') return true;
      if (filter === 'CALL') return callPermitted.has(c.id);
      // aba de não lidas — mesmo critério do badge (contagem de mensagens não lidas)
      return c._count.messages > 0;
    })
    .sort((a, b) => {
      // Estrela primeiro: cliente marcado como importante fica fixo no topo
      // da Inbox, mesma lógica do Kanban (Lead.starred). Dentro de cada
      // grupo (com/sem estrela), mantém a ordem normal por última mensagem.
      const starredDiff = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
      if (starredDiff !== 0) return starredDiff;
      return lastMessageTime(b) - lastMessageTime(a);
    });

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
          <button onClick={() => setFilter('UNREAD')} className={chip(filter === 'UNREAD')}>
            Não lidas{unreadCount > 0 ? ` (${unreadCount})` : ''}
          </button>
          <button onClick={() => setFilter('CALL')} className={cn(chip(filter === 'CALL'), 'inline-flex items-center gap-1')} title="Clientes que permitiram ligação pelo WhatsApp">
            <Phone size={11} /> Permitiram ligar{callCount > 0 ? ` (${callCount})` : ''}
          </button>
        </div>
      </div>

      {/* List */}
      <div ref={listRef} onScroll={handleListScroll} className="flex-1 overflow-y-auto scrollbar-thin">
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
                    {conv.starred && (
                      <Star size={12} className="flex-shrink-0 text-amber-400 fill-amber-400" />
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
              </div>
            </div>
          );
        })}
        {!loading && loadError && conversations.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-3 h-48 px-6 text-center">
            <AlertCircle size={28} className="text-amber-400" />
            <div>
              <p className="text-sm text-[#e9edef] font-medium">Não consegui carregar as conversas</p>
              <p className="text-xs text-[#8696a0] mt-1">
                Falha de conexão com o servidor — nada foi perdido, é só recarregar.
              </p>
            </div>
            {onRetry && (
              <button
                onClick={onRetry}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg font-medium bg-[#00a884] text-[#111b21] hover:bg-[#02c093] transition-colors"
              >
                <RefreshCw size={12} /> Tentar de novo
              </button>
            )}
          </div>
        )}
        {!loading && !(loadError && conversations.length === 0) && filtered.length === 0 && (
          <div className="flex items-center justify-center h-40 text-[#8696a0] text-sm">
            Nenhuma conversa encontrada
          </div>
        )}
      </div>
    </div>
  );
}
