'use client';
import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { ConversationList } from '@/components/inbox/conversation-list';
import { ChatWindow } from '@/components/inbox/chat-window';
import { LeadPanel } from '@/components/inbox/lead-panel';
import { Conversation, Message, Lead } from '@/types';
import api from '@/lib/api';

async function fetchConversations(): Promise<Conversation[]> {
  const { data } = await api.get('/api/messages');
  return data;
}

async function fetchMessages(leadId: string): Promise<Message[]> {
  const { data } = await api.get(`/api/messages?leadId=${leadId}`);
  return data;
}

async function fetchLead(id: string): Promise<Lead> {
  const { data } = await api.get(`/api/leads/${id}`);
  return data;
}

export default function InboxPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [localMessages, setLocalMessages] = useState<Message[]>([]);

  const { data: conversations, isLoading: loadingConvs } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    refetchInterval: 30000,
  });

  const { data: messages, isLoading: loadingMsgs } = useQuery({
    queryKey: ['messages', selectedId],
    queryFn: () => fetchMessages(selectedId!),
    enabled: !!selectedId,
  });

  const { data: lead } = useQuery({
    queryKey: ['lead', selectedId],
    queryFn: () => fetchLead(selectedId!),
    enabled: !!selectedId,
  });

  const handleNewMessage = useCallback((msg: Message) => {
    setLocalMessages((prev) => [...prev, msg]);
  }, []);

  const allMessages = [...(messages || []), ...localMessages.filter((m) => !messages?.find((x) => x.id === m.id))];

  const selectedConv = conversations?.find((c) => c.id === selectedId);

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
              leadName={selectedConv?.contact?.name || selectedConv?.name || lead.name}
              messages={allMessages}
              onNewMessage={handleNewMessage}
            />
            <LeadPanel lead={lead} />
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
