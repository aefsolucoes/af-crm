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
import { PanelRightOpen, PanelRightClose } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-media-query';

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
  // Timeout explícito: sem ele, uma consulta lenta no servidor deixava a lista
  // presa no esqueleto de carregamento pra sempre, sem erro e sem retry —
  // parecia que "sumiram todas as conversas". Melhor falhar e mostrar o botão
  // de tentar de novo do que pendurar em silêncio.
  const { data } = await api.get('/api/messages', { timeout: 20000 });
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
  // No mobile as 3 colunas (lista/chat/painel) não cabem lado a lado — mostra
  // um painel por vez. Lista some ao abrir uma conversa (ChatWindow ganha um
  // botão de voltar); o painel de dados vira um overlay sob demanda.
  const isMobile = useIsMobile();
  const [showMobileInfo, setShowMobileInfo] = useState(false);
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

  const { data: conversations, isLoading: loadingConvs, isError: convsError, refetch: refetchConvs } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    refetchInterval: 30000, // rede de segurança; o tempo real vem pelo socket abaixo
    // Blip de rede/servidor não pode zerar a lista: tenta de novo sozinho antes
    // de desistir, e o que já tinha carregado continua na tela enquanto isso.
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
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

  // No mobile: lista cheia quando nada selecionado, chat cheio quando
  // selecionado (nunca os dois ao mesmo tempo — não cabe). No desktop os
  // dois sempre convivem lado a lado, como sempre foi.
  const showList = !isMobile || !selectedId;
  const showChatArea = !isMobile || !!selectedId;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Inbox" subtitle="Mensagens unificadas" />
      <div className="flex flex-1 overflow-hidden relative">
        {showList && (
          <ConversationList
            conversations={conversations || []}
            selectedId={selectedId || undefined}
            onSelect={(id) => { setSelectedId(id); setLocalMessages([]); setShowMobileInfo(false); }}
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
            loadError={convsError}
            onRetry={() => { refetchConvs(); }}
          />
        )}

        {showChatArea && (selectedId && lead ? (
          <>
            <ChatWindow
              leadId={selectedId}
              leadName={selectedConv?.contact?.name || selectedConv?.name || displayName}
              messages={allMessages}
              notes={lead.notes}
              aiAutoReplyActive={(lead as any).aiAutoReplyActive}
              onNewMessage={handleNewMessage}
              onClose={() => { setSelectedId(null); setShowMobileInfo(false); }}
              onOpenInfo={() => setShowMobileInfo(true)}
            />
            {/* Painel de dados: desktop mostra sempre ao lado; mobile só como
                overlay sob demanda (botão "i" no cabeçalho do chat). A barra
                de mostrar/esconder fica SEMPRE na mesma posição (borda entre
                chat e painel), nos dois estados — antes cada lado tinha um
                botão num lugar diferente (um preso no cabeçalho do painel,
                outro só quando colapsado); usuário pediu "quero que ele
                fique na barra, tanto de um lado quanto do outro". */}
            {!isMobile && (
              <>
                {/* Transparente parado, cor só aparece no hover — mesmo
                    padrão do botão "Esconder dados do cliente" de dentro do
                    painel (usuário pediu pra ficar igual dos dois lados). */}
                <button
                  onClick={() => toggleLeadPanel(!hideLeadPanel)}
                  title={hideLeadPanel ? 'Mostrar dados do cliente' : 'Esconder dados do cliente'}
                  className="group flex-shrink-0 w-5 border-l border-af-border bg-af-light hover:bg-af-mid flex items-center justify-center transition-colors"
                >
                  {hideLeadPanel
                    ? <PanelRightOpen size={14} className="text-af-mid group-hover:text-white transition-colors" />
                    : <PanelRightClose size={14} className="text-af-mid group-hover:text-white transition-colors" />}
                </button>
                {!hideLeadPanel && (
                  (lead as any).isGroup ? (
                    <GroupMembersPanel leadId={selectedId} groupName={displayName} />
                  ) : (
                    <InboxLeadPanel lead={lead} onRefresh={handleRefresh} />
                  )
                )}
              </>
            )}
            {isMobile && showMobileInfo && (
              <div className="fixed inset-0 z-50 flex flex-col md:hidden">
                {(lead as any).isGroup ? (
                  <GroupMembersPanel leadId={selectedId} groupName={displayName} onHide={() => setShowMobileInfo(false)} className="w-full" />
                ) : (
                  <InboxLeadPanel lead={lead} onRefresh={handleRefresh} onHide={() => setShowMobileInfo(false)} className="w-full" />
                )}
              </div>
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
        ))}
      </div>
    </div>
  );
}
