'use client';
import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { ConversationList } from '@/components/inbox/conversation-list';
import { ChatWindow } from '@/components/inbox/chat-window';
import { InboxLeadPanel } from '@/components/inbox/inbox-lead-panel';
import { Conversation, Message, LeadDetail } from '@/types';
import api from '@/lib/api';

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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [localMessages, setLocalMessages] = useState<Message[]>([]);
  const queryClient = useQueryClient();

  const { data: conversations, isLoading: loadingConvs } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    refetchInterval: 30000,
  });

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
    setLocalMessages((prev) => [...prev, msg]);
  }, []);

  const handleRefresh = useCallback(() => {
    refetchLead();
    queryClient.invalidateQueries({ queryKey: ['conversations'] });
  }, [refetchLead, queryClient]);

  const allMessages = [...(messages || []), ...localMessages.filter((m) => !messages?.find((x) => x.id === m.id))];

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
          loading={loadingConvs}
        />

        {selectedId && lead ? (
          <>
            <ChatWindow
              leadId={selectedId}
              leadName={selectedConv?.contact?.name || selectedConv?.name || displayName}
              messages={allMessages}
              notes={lead.notes}
              onNewMessage={handleNewMessage}
            />
            <InboxLeadPanel lead={lead} onRefresh={handleRefresh} />
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
