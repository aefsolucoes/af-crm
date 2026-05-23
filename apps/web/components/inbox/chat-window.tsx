'use client';
import { useEffect, useRef, useState } from 'react';
import { Message, Channel } from '@/types';
import { cn, formatDateTime, CHANNEL_COLORS, CHANNEL_LABELS } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Send, Paperclip } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { getSocket } from '@/lib/socket';

interface ChatWindowProps {
  leadId: string;
  leadName: string;
  messages: Message[];
  onNewMessage: (msg: Message) => void;
}

export function ChatWindow({ leadId, leadName, messages, onNewMessage }: ChatWindowProps) {
  const [content, setContent] = useState('');
  const [channel, setChannel] = useState<Channel>('WHATSAPP');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const socket = getSocket();
    socket.emit('join_lead', leadId);
    socket.on('new_message', (msg: Message) => { if (msg.leadId === leadId) onNewMessage(msg); });
    return () => {
      socket.emit('leave_lead', leadId);
      socket.off('new_message');
    };
  }, [leadId, onNewMessage]);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    setSending(true);
    try {
      const { data } = await api.post('/api/messages', {
        content: content.trim(),
        direction: 'OUTBOUND',
        channel,
        leadId,
      });
      onNewMessage(data);
      setContent('');
    } catch {
      toast('Erro ao enviar mensagem', 'error');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col flex-1 bg-slate-50 h-full">
      {/* Header */}
      <div className="px-6 py-3 bg-white border-b border-af-border flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-900">{leadName}</p>
          <p className="text-xs text-slate-500">{messages.length} mensagens</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 scrollbar-thin">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn('flex', msg.direction === 'OUTBOUND' ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-xs lg:max-w-md px-4 py-2.5 rounded-2xl text-sm shadow-sm',
                msg.direction === 'OUTBOUND'
                  ? 'bg-af-mid text-white rounded-br-sm'
                  : 'bg-white text-slate-800 border border-af-border rounded-bl-sm'
              )}
            >
              <p className="leading-relaxed">{msg.content}</p>
              <div className={cn('flex items-center gap-1.5 mt-1 text-xs', msg.direction === 'OUTBOUND' ? 'text-white/60 justify-end' : 'text-slate-400')}>
                <span style={{ color: CHANNEL_COLORS[msg.channel] }}>●</span>
                {CHANNEL_LABELS[msg.channel]}
                <span>·</span>
                {formatDateTime(msg.createdAt)}
              </div>
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSend} className="px-6 py-4 bg-white border-t border-af-border">
        <div className="flex items-center gap-3">
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value as Channel)}
            className="text-xs border border-af-border rounded-lg px-2 py-2 bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-af-accent"
          >
            {(['WHATSAPP', 'INSTAGRAM', 'TELEGRAM', 'WEBCHAT', 'EMAIL'] as Channel[]).map((ch) => (
              <option key={ch} value={ch}>{CHANNEL_LABELS[ch]}</option>
            ))}
          </select>
          <input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Digite sua mensagem..."
            className="flex-1 px-4 py-2 text-sm border border-af-border rounded-xl bg-slate-50 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-af-accent focus:bg-white"
          />
          <Button type="button" variant="ghost" size="sm" className="text-slate-400">
            <Paperclip size={16} />
          </Button>
          <Button type="submit" size="sm" loading={sending} disabled={!content.trim()}>
            <Send size={14} />
          </Button>
        </div>
      </form>
    </div>
  );
}
