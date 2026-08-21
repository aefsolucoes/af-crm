'use client';
import { useState, useCallback, useEffect, useMemo, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { ConversationList } from '@/components/inbox/conversation-list';
import { ChatWindow } from '@/components/inbox/chat-window';
import { InboxLeadPanel } from '@/components/inbox/inbox-lead-panel';
import { GroupMembersPanel } from '@/components/inbox/group-members-panel';
import { Conversation, Message, LeadDetail } from '@/types';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { PanelRightOpen } from 'lucide-react';

// Lembra se o painel de dados do cliente/grupo deve ficar escondido — pra
// quem prefere mais espaço pra conversa e não quer reesconder toda vez.
const HIDE_LEAD_PANEL_KEY = 'af-crm:inbox:hideLeadPanel';
function readHideLeadPanel(): boolean {
  if (typeof window === 'undefined') return false;
  try { return localStorage.getItem(HIDE_LEAD_PANEL_KEY) === '1'; } catch { return false; }
}
function storeHideLeadPanel(hidden: boolean) {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(HIDE_LEAD_PANEL_KEY, hidden ? '1' : '0'); } catch { /* modo privado etc. */ }
}

async function fetchConversations(): Promise<Conversation[]> {
  const { data } = await api.get('/api/messages');
  return data;
}

async function fetchMessages(leadId: string): Promise<Message[]> {
  const { data } = await api.get(`/api/messages?leadId=${leadId}`);
  return data;
}

async function fetchLead(id: string): Promise<LeadDetail> {
  const { data } = await api.get(`/api/leads/${id}`);
  return data;
}

export default function InboxPage() {
  return (
    <Suspense fallback={<div className="flex flex-col h-full" />}>
      <InboxPageInner />
    </Suspense>
  );
}

function InboxPageInner() {
  const searchParams = useSearchParams();
  const leadIdParam = searchParams.get('leadId');
  const [selectedId, setSelectedId] = useState<string | null>(leadIdParam);
  const [localMessages, setLocalMessages] = useState<Message[]>([]);
  const [hideLeadPanel, setHideLeadPanel] = useState(readHideLeadPanel);
  const queryClient = useQueryClient();

  function toggleLeadPanel(hidden: boolean) {
    setHideLeadPanel(hidden);
    storeHideLeadPanel(hidden);
  }

  // Abre a conversa direto via ?leadId= (ex: vindo de um card do Funil)
  useEffect(() => {
    if (leadIdParam && leadIdParam !== selectedId) {
      setSelectedId(leadIdParam);
      setLocalMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadIdParam]);

  const { data: conversations, isLoading: loadingConvs } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    refetchInterval: 30000, // rede de segurança; o tempo real vem pelo socket abaixo
  });

  // Atualiza a lista de conversas em TEMPO REAL (sem esperar o poll de 30s).
  // O backend emite 'new_conversation' a cada mensagem nova (recebida ou enviada).
  useEffect(() => {
    const socket = getSocket();
    let t: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (t) return; // agrupa rajadas de eventos em 1 atualização
      t = setTimeout(() => { t = null; queryClient.invalidateQueries({ queryKey: ['conversations'] }); }, 300);
    };
    socket.on('new_conversation', refresh);
    socket.on('new_notification', refresh);
    return () => {
      if (t) clearTimeout(t);
      socket.off('new_conversation', refresh);
      socket.off('new_notification', refresh);
    };
  }, [queryClient]);

  // Números de WhatsApp conectados — para as abas por número na Inbox
  const { data: whatsappNumbers } = useQuery({
    queryKey: ['whatsapp-numbers'],
    queryFn: async () => { const { data } = await api.get('/api/whatsapp-qr/numbers'); return data; },
  });

  // Ao abrir uma conversa, marca as mensagens como lidas (some o contador azul)
  useEffect(() => {
    if (!selectedId) return;
    api.post('/api/messages/read', { leadId: selectedId })
      .then(() => queryClient.invalidateQueries({ queryKey: ['conversations'] }))
      .catch(() => {});
  }, [selectedId, queryClient]);

  const { data: messages } = useQuery({
    queryKey: ['messages', selectedId],
    queryFn: () => fetchMessages(selectedId!),
    enabled: !!selectedId,
  });

  const { data: lead, refetch: refetchLead } = useQuery({
    queryKey: ['lead', selectedId],
    queryFn: () => fetchLead(selectedId!),
    enabled: !!selectedId,
    staleTime: 0,
  });

  const handleNewMessage = useCallback((msg: Message) => {
    // Evita duplicata: a mesma mensagem chega pela resposta do POST e pelo eco do socket
    setLocalMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
  }, []);

  const handleRefresh = useCallback(() => {
    refetchLead();
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
  }, [refetchLead, queryClient]);

  // Memoizado: sem isso, virava um array NOVO em toda renderização do Inbox
  // (poll de 30s de `conversations`, socket de outras conversas etc.) — o
  // efeito de auto-scroll do ChatWindow reage a QUALQUER troca de referência
  // de `messages`, então a conversa era puxada de volta pro final mesmo sem
  // nenhuma mensagem nova, no meio de o usuário rolar pra cima pra ler o
  // histórico. Agora só muda de referência quando o conteúdo realmente muda.
  const allMessages = useMemo(
    () => [...(messages || []), ...localMessages.filter((m) => !messages?.find((x) => x.id === m.id))],
    [messages, localMessages]
  );

  const selectedConv = conversations?.find((c) => c.id === selectedId);
  const cf = ((lead as any)?.customFields || {}) as Record<string, string>;
  const displayName = cf.participante_1 || lead?.contact?.name || lead?.name || '';

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Inbox" subtitle="Mensagens unificadas" />
      <div className="flex flex-1 overflow-hidden">
        <ConversationList
          conversations={conversations || []}
          selectedId={selectedId || undefined}
          onSelect={(id) => { setSelectedId(id); setLocalMessages([]); }}
          onToggleGroup={async (id, isGroup) => {
            await api.put(`/api/leads/${id}`, { isGroup });
            queryClient.invalidateQueries({ queryKey: ['conversations'] });
          }}
          onRefreshGroupNames={async () => {
            await api.post('/api/whatsapp-qr/refresh-groups');
            queryClient.invalidateQueries({ queryKey: ['conversations'] });
          }}
          whatsappNumbers={whatsappNumbers || []}
          loading={loadingConvs}
        />

        {selectedId && lead ? (
          <>
            <ChatWindow
              leadId={selectedId}
              leadName={selectedConv?.contact?.name || selectedConv?.name || displayName}
              messages={allMessages}
              notes={lead.notes}
              aiAutoReplyActive={(lead as any).aiAutoReplyActive}
              onNewMessage={handleNewMessage}
              onClose={() => setSelectedId(null)}
            />
            {hideLeadPanel ? (
              <button
                onClick={() => toggleLeadPanel(false)}
                title="Mostrar dados do cliente"
                className="flex-shrink-0 w-6 border-l border-af-border app-column-surface flex items-center justify-center hover:bg-af-light/60 transition-colors"
              >
                <PanelRightOpen size={14} className="text-slate-400" />
              </button>
            ) : (lead as any).isGroup ? (
              <GroupMembersPanel leadId={selectedId} groupName={displayName} onHide={() => toggleLeadPanel(true)} />
            ) : (
              <InboxLeadPanel lead={lead} onRefresh={handleRefresh} onHide={() => toggleLeadPanel(true)} />
            )}
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center bg-slate-50">
            <div className="text-center text-slate-400">
              <p className="text-4xl mb-3">💬</p>
              <p className="text-sm font-medium">Selecione uma conversa</p>
              <p className="text-xs mt-1">para visualizar as mensagens</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
