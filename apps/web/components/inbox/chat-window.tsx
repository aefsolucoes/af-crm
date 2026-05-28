'use client';
import { useEffect, useRef, useState } from 'react';
import { Message, Channel } from '@/types';
import { cn, formatDateTime } from '@/lib/utils';
import { Send, Paperclip, Smile, Phone, MoreVertical, Check, CheckCheck, Sparkles, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { getSocket } from '@/lib/socket';
import { Avatar } from '@/components/ui/avatar';

const CHANNEL_ICONS: Record<Channel, string> = {
  WHATSAPP: '📱',
  INSTAGRAM: '📸',
  TELEGRAM: '✈️',
  WEBCHAT: '💬',
  EMAIL: '📧',
};

const CHANNEL_LABELS: Record<Channel, string> = {
  WHATSAPP: 'WhatsApp',
  INSTAGRAM: 'Instagram',
  TELEGRAM: 'Telegram',
  WEBCHAT: 'Web Chat',
  EMAIL: 'E-mail',
};

interface ChatWindowProps {
  leadId: string;
  leadName: string;
  messages: Message[];
  onNewMessage: (msg: Message) => void;
}

type AIMode = 'grammar' | 'professional' | 'friendly' | 'fun';

const AI_BUTTONS: { mode: AIMode; label: string; emoji: string }[] = [
  { mode: 'grammar',      label: 'Corrigir gramática', emoji: '✏️' },
  { mode: 'professional', label: 'Profissional',        emoji: '💼' },
  { mode: 'friendly',     label: 'Amigável',            emoji: '😊' },
  { mode: 'fun',          label: 'Divertido',           emoji: '🎉' },
];

export function ChatWindow({ leadId, leadName, messages, onNewMessage }: ChatWindowProps) {
  const [content, setContent] = useState('');
  const [channel, setChannel] = useState<Channel>('WHATSAPP');
  const [sending, setSending] = useState(false);
  const [aiLoading, setAiLoading] = useState<AIMode | null>(null);
  const [showAI, setShowAI] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const socket = getSocket();
    socket.emit('join_lead', leadId);
    socket.on('new_message', (msg: Message) => {
      if (msg.leadId === leadId) onNewMessage(msg);
    });
    return () => {
      socket.emit('leave_lead', leadId);
      socket.off('new_message');
    };
  }, [leadId, onNewMessage]);

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault();
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

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleAI(mode: AIMode) {
    const text = content.trim();
    if (!text) {
      toast('Digite uma mensagem primeiro para usar a IA', 'error');
      return;
    }
    setAiLoading(mode);
    try {
      const { data } = await api.post('/api/ai/rewrite', { text, mode });
      setContent(data.result);
      inputRef.current?.focus();
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.message || 'Erro desconhecido';
      toast(`IA: ${msg}`, 'error');
    } finally {
      setAiLoading(null);
    }
  }

  function StatusTick({ status }: { status?: string }) {
    if (status === 'READ') return <CheckCheck size={14} className="text-blue-400" />;
    if (status === 'DELIVERED') return <CheckCheck size={14} className="text-slate-300" />;
    return <Check size={14} className="text-slate-300" />;
  }

  // Group messages by date
  const grouped: { date: string; messages: Message[] }[] = [];
  for (const msg of messages) {
    const date = new Date(msg.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    const last = grouped[grouped.length - 1];
    if (last && last.date === date) {
      last.messages.push(msg);
    } else {
      grouped.push({ date, messages: [msg] });
    }
  }

  return (
    <div className="flex flex-col flex-1 h-full" style={{ background: '#e5ddd5' }}>
      {/* WhatsApp-style background pattern */}
      <div
        className="absolute inset-0 pointer-events-none opacity-5"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }}
      />

      {/* Header — WhatsApp green */}
      <div className="relative z-10 flex items-center gap-3 px-4 py-3 text-white shadow-md" style={{ backgroundColor: '#075e54' }}>
        <Avatar name={leadName} size="md" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{leadName}</p>
          <p className="text-xs opacity-80">
            {CHANNEL_ICONS[channel]} {CHANNEL_LABELS[channel]}
          </p>
        </div>
        <div className="flex items-center gap-3 text-white/80">
          <Phone size={18} className="cursor-pointer hover:text-white" />
          <MoreVertical size={18} className="cursor-pointer hover:text-white" />
        </div>
      </div>

      {/* Channel selector */}
      <div className="relative z-10 flex items-center gap-2 px-4 py-2 bg-white/80 backdrop-blur border-b border-black/5">
        <span className="text-xs text-slate-500 font-medium">Canal:</span>
        {(['WHATSAPP', 'INSTAGRAM', 'TELEGRAM', 'WEBCHAT', 'EMAIL'] as Channel[]).map((ch) => (
          <button
            key={ch}
            onClick={() => setChannel(ch)}
            className={cn(
              'flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-all',
              channel === ch
                ? 'bg-[#075e54] text-white shadow-sm'
                : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
            )}
          >
            {CHANNEL_ICONS[ch]} {CHANNEL_LABELS[ch]}
          </button>
        ))}
      </div>

      {/* Messages */}
      <div className="relative z-10 flex-1 overflow-y-auto px-4 py-4 space-y-1 scrollbar-thin">
        {grouped.map(({ date, messages: dayMsgs }) => (
          <div key={date}>
            {/* Date separator */}
            <div className="flex justify-center my-3">
              <span className="bg-white/90 text-slate-500 text-xs px-3 py-1 rounded-full shadow-sm">
                {date}
              </span>
            </div>

            {dayMsgs.map((msg, i) => {
              const isOut = msg.direction === 'OUTBOUND';
              const time = new Date(msg.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
              const showTail = i === 0 || dayMsgs[i - 1]?.direction !== msg.direction;

              return (
                <div
                  key={msg.id}
                  className={cn('flex mb-0.5', isOut ? 'justify-end' : 'justify-start')}
                >
                  <div
                    className={cn(
                      'relative max-w-xs lg:max-w-md px-3 py-2 shadow-sm',
                      isOut
                        ? 'rounded-tl-2xl rounded-tr-2xl rounded-bl-2xl text-slate-800'
                        : 'rounded-tl-2xl rounded-tr-2xl rounded-br-2xl text-slate-800',
                      showTail && isOut ? 'rounded-br-sm' : '',
                      showTail && !isOut ? 'rounded-bl-sm' : '',
                    )}
                    style={{ backgroundColor: isOut ? '#d9fdd3' : '#ffffff' }}
                  >
                    <p className="text-sm leading-relaxed whitespace-pre-wrap pr-12">{msg.content}</p>
                    <div className={cn('absolute bottom-2 right-3 flex items-center gap-1')}>
                      <span className="text-xs text-slate-400">{time}</span>
                      {isOut && <StatusTick status={(msg as any).status} />}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* AI assistant toolbar */}
      {showAI && (
        <div className="relative z-10 flex items-center gap-2 px-3 py-2 bg-white/95 border-t border-black/5 flex-wrap">
          <Sparkles size={13} className="text-af-mid flex-shrink-0" />
          <span className="text-xs text-slate-500 font-medium mr-1">IA:</span>
          {AI_BUTTONS.map(({ mode, label, emoji }) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleAI(mode)}
              disabled={!!aiLoading}
              className={cn(
                'flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-all border',
                aiLoading === mode
                  ? 'bg-af-mid text-white border-af-mid'
                  : 'bg-white text-slate-600 border-af-border hover:bg-af-light hover:border-af-mid hover:text-af-mid',
                !!aiLoading && aiLoading !== mode && 'opacity-50 cursor-not-allowed'
              )}
            >
              {aiLoading === mode
                ? <Loader2 size={10} className="animate-spin" />
                : <span className="text-sm leading-none">{emoji}</span>}
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Input bar */}
      <form
        onSubmit={handleSend}
        className="relative z-10 flex items-end gap-2 px-3 py-3 bg-[#f0f2f5]"
      >
        <button
          type="button"
          className="flex-shrink-0 p-2 text-slate-500 hover:text-slate-700"
        >
          <Smile size={22} />
        </button>
        <button
          type="button"
          className="flex-shrink-0 p-2 text-slate-500 hover:text-slate-700"
        >
          <Paperclip size={22} />
        </button>
        <textarea
          ref={inputRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Digite uma mensagem"
          rows={1}
          className="flex-1 resize-none px-4 py-2.5 text-sm bg-white rounded-3xl border-none outline-none text-slate-900 placeholder-slate-400 scrollbar-thin max-h-32"
          style={{ lineHeight: '1.4' }}
        />
        {/* AI toggle button */}
        <button
          type="button"
          onClick={() => setShowAI(v => !v)}
          title="Assistente IA"
          className={cn(
            'flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all',
            showAI ? 'bg-af-mid text-white' : 'bg-white/80 text-slate-500 hover:bg-white hover:text-af-mid'
          )}
        >
          <Sparkles size={18} />
        </button>
        <button
          type="submit"
          disabled={!content.trim() || sending}
          className={cn(
            'flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-white transition-all',
            content.trim() ? 'opacity-100 scale-100' : 'opacity-50 scale-95',
          )}
          style={{ backgroundColor: '#075e54' }}
        >
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}
