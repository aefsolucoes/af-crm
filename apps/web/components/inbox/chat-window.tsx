'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Message, Channel, Note } from '@/types';
import { cn, formatDateTime } from '@/lib/utils';
import { Send, Paperclip, Smile, Phone, MoreVertical, Check, CheckCheck, Sparkles, Loader2, FileText } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { getSocket } from '@/lib/socket';
import { Avatar } from '@/components/ui/avatar';
import { AttachmentView } from '@/components/inbox/message-attachment';
import { MessageTemplate, CATEGORY_META, getTemplates, fillTemplate } from '@/lib/templates';

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
  notes?: Note[];
  onNewMessage: (msg: Message) => void;
}

type AIMode = 'grammar' | 'professional' | 'friendly' | 'fun';

const AI_BUTTONS: { mode: AIMode; label: string; emoji: string }[] = [
  { mode: 'grammar',      label: 'Corrigir gramática', emoji: '✏️' },
  { mode: 'professional', label: 'Profissional',        emoji: '💼' },
  { mode: 'friendly',     label: 'Amigável',            emoji: '😊' },
  { mode: 'fun',          label: 'Divertido',           emoji: '🎉' },
];

type WhatsAppVia = 'qr' | 'api';

export function ChatWindow({ leadId, leadName, messages, notes = [], onNewMessage }: ChatWindowProps) {
  const [content, setContent] = useState('');
  const [channel, setChannel] = useState<Channel>('WHATSAPP');
  const [via, setVia] = useState<WhatsAppVia | null>(null);
  const [sending, setSending] = useState(false);

  // Disponibilidade dos canais de WhatsApp (números via QR Code e API oficial)
  const { data: qrNumbers } = useQuery({
    queryKey: ['whatsapp-qr-numbers'],
    queryFn: async () => { const { data } = await api.get('/api/whatsapp-qr/numbers'); return data as { id: string; label: string; status: string }[]; },
    refetchInterval: 30000,
  });
  const { data: apiConfig } = useQuery({
    queryKey: ['whatsapp-api-config'],
    queryFn: async () => { const { data } = await api.get('/api/settings/whatsapp'); return data as { active?: boolean } | null; },
  });

  const qrConnected = !!qrNumbers?.some(n => n.status === 'connected');
  const apiActive = !!apiConfig?.active;
  // Canal efetivo: escolha manual, senão QR se conectado, senão API
  const effectiveVia: WhatsAppVia = via ?? (qrConnected ? 'qr' : 'api');
  const [aiLoading, setAiLoading] = useState<AIMode | null>(null);
  const [showAI, setShowAI] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  // Mapa de status atualizado via socket: messageId → status
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
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

    // Atualiza tick em tempo real quando a Meta confirma entrega/leitura
    socket.on('message_status', ({ id, status }: { id: string; status: string }) => {
      setStatusMap(prev => ({ ...prev, [id]: status }));
    });

    return () => {
      socket.emit('leave_lead', leadId);
      socket.off('new_message');
      socket.off('message_status');
    };
  }, [leadId, onNewMessage]);

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault();
    const text = content.trim();
    if (!text || sending) return;   // trava contra envio duplo
    setSending(true);
    setContent('');                 // feedback imediato: o campo esvazia na hora
    try {
      const { data } = await api.post('/api/messages', {
        content: text,
        direction: 'OUTBOUND',
        channel,
        leadId,
        ...(channel === 'WHATSAPP' ? { via: effectiveVia } : {}),
      });
      onNewMessage(data);
    } catch (err: any) {
      setContent(text);             // falhou: devolve o texto para tentar de novo
      const msg = err?.response?.data?.error || err?.message || 'Erro ao enviar mensagem';
      toast(msg, 'error');
    } finally {
      setSending(false);
    }
  }

  function handleOpenTemplates() {
    setTemplates(getTemplates());
    setShowTemplates(v => !v);
    setShowAI(false);
  }

  function handleUseTemplate(template: MessageTemplate) {
    const firstName = leadName?.split(' ')[0] || leadName || '';
    const filled = fillTemplate(template.body, { nome: leadName, primeiro_nome: firstName });
    setContent(filled);
    setShowTemplates(false);
    inputRef.current?.focus();
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

  // ── Timeline unificado: mensagens + notas de fluxo ordenadas por data ──
  type TimelineItem =
    | { kind: 'message'; data: Message }
    | { kind: 'note';    data: Note    };

  // Apenas eventos de fluxo no chat (etapa e edição de dados)
  const flowNotes = notes.filter(n => n.type === 'STAGE_CHANGE' || n.type === 'DATA_EDIT');

  const allItems: TimelineItem[] = [
    ...messages.map(m => ({ kind: 'message' as const, data: m })),
    ...flowNotes.map(n => ({ kind: 'note' as const, data: n })),
  ].sort((a, b) => new Date(a.data.createdAt).getTime() - new Date(b.data.createdAt).getTime());

  const grouped: { date: string; items: TimelineItem[] }[] = [];
  for (const item of allItems) {
    const date = new Date(item.data.createdAt).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
    const last = grouped[grouped.length - 1];
    if (last && last.date === date) {
      last.items.push(item);
    } else {
      grouped.push({ date, items: [item] });
    }
  }

  // Ícone e cor por tipo de nota
  const NOTE_STYLE: Record<string, { icon: string; label: string; bg: string; text: string }> = {
    STAGE_CHANGE: { icon: '↕️', label: 'Etapa alterada',   bg: 'bg-blue-50',   text: 'text-blue-700'   },
    DATA_EDIT:    { icon: '✏️', label: 'Dados editados',   bg: 'bg-slate-100', text: 'text-slate-500'  },
    COMMENT:      { icon: '💬', label: 'Comentário',       bg: 'bg-amber-50',  text: 'text-amber-800'  },
    CALL:         { icon: '📞', label: 'Ligação',          bg: 'bg-green-50',  text: 'text-green-700'  },
    EMAIL:        { icon: '📧', label: 'E-mail',           bg: 'bg-purple-50', text: 'text-purple-700' },
  };

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

      {/* Seletor: por qual WhatsApp enviar (QR Code ou API oficial) */}
      <div className="relative z-10 flex items-center gap-2 px-4 py-2 bg-white/80 backdrop-blur border-b border-black/5">
        <span className="text-xs text-slate-500 font-medium">Enviar por:</span>
        <button
          onClick={() => setVia('qr')}
          disabled={!qrConnected}
          title={qrConnected ? 'WhatsApp conectado via QR Code' : 'QR Code desconectado — conecte em Configurações'}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed',
            effectiveVia === 'qr' && qrConnected
              ? 'bg-[#075e54] text-white shadow-sm'
              : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
          )}
        >
          📱 WhatsApp QR
          <span className={cn('w-1.5 h-1.5 rounded-full', qrConnected ? 'bg-green-400' : 'bg-red-400')} />
        </button>
        <button
          onClick={() => setVia('api')}
          title={apiActive ? 'API oficial da Meta ativa' : 'API oficial não configurada/inativa'}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-all',
            effectiveVia === 'api' || !qrConnected
              ? (effectiveVia === 'api' ? 'bg-[#075e54] text-white shadow-sm' : 'bg-slate-100 text-slate-500 hover:bg-slate-200')
              : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
          )}
        >
          🌐 API Oficial
          <span className={cn('w-1.5 h-1.5 rounded-full', apiActive ? 'bg-green-400' : 'bg-red-400')} />
        </button>
      </div>

      {/* Timeline unificado: mensagens + eventos de fluxo */}
      <div className="relative z-10 flex-1 overflow-y-auto px-4 py-4 space-y-1 scrollbar-thin">
        {grouped.map(({ date, items }) => (
          <div key={date}>
            {/* Separador de data */}
            <div className="flex justify-center my-3">
              <span className="bg-white/90 text-slate-500 text-xs px-3 py-1 rounded-full shadow-sm">
                {date}
              </span>
            </div>

            {items.map((item, i) => {
              const time = new Date(item.data.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

              // ── Nota de fluxo ──────────────────────────────────────────
              if (item.kind === 'note') {
                const note = item.data;
                const style = NOTE_STYLE[note.type] || NOTE_STYLE.COMMENT;

                // STAGE_CHANGE e DATA_EDIT: label centralizada discreta
                if (note.type === 'STAGE_CHANGE' || note.type === 'DATA_EDIT') {
                  return (
                    <div key={note.id} className="flex justify-center my-2">
                      <div className={cn('flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium shadow-sm', style.bg, style.text)}>
                        <span>{style.icon}</span>
                        <span>{note.content}</span>
                        <span className="opacity-60 ml-1">{time}</span>
                      </div>
                    </div>
                  );
                }

                // COMMENT, CALL, EMAIL: bolha à esquerda com autor
                return (
                  <div key={note.id} className="flex justify-start mb-1">
                    <div className={cn('max-w-xs lg:max-w-md px-3 py-2 rounded-2xl rounded-bl-sm shadow-sm', style.bg)}>
                      {note.user && (
                        <p className={cn('text-xs font-semibold mb-0.5', style.text)}>
                          {style.icon} {note.user.name}
                        </p>
                      )}
                      <p className={cn('text-sm leading-relaxed whitespace-pre-wrap', style.text)}>{note.content}</p>
                      <span className="text-xs opacity-50 mt-0.5 block text-right">{time}</span>
                    </div>
                  </div>
                );
              }

              // ── Mensagem WhatsApp ──────────────────────────────────────
              const msg = item.data;
              const isOut = msg.direction === 'OUTBOUND';
              const prevItem = items[i - 1];
              const prevIsMsg = prevItem?.kind === 'message';
              const showTail = !prevIsMsg || (prevItem.data as Message).direction !== msg.direction;
              const liveStatus = statusMap[msg.id] || (msg as any).status;

              return (
                <div key={msg.id} className={cn('flex mb-0.5', isOut ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'relative max-w-xs lg:max-w-md px-3 py-2 shadow-sm',
                      isOut
                        ? 'rounded-tl-2xl rounded-tr-2xl rounded-bl-2xl text-slate-800'
                        : 'rounded-tl-2xl rounded-tr-2xl rounded-br-2xl text-slate-800',
                      showTail && isOut  ? 'rounded-br-sm' : '',
                      showTail && !isOut ? 'rounded-bl-sm' : '',
                    )}
                    style={{ backgroundColor: isOut ? '#d9fdd3' : '#ffffff' }}
                  >
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-col gap-1.5 mb-1">
                        {msg.attachments.map((att) => (
                          <AttachmentView key={att.id} att={att} />
                        ))}
                      </div>
                    )}
                    {(() => {
                      // Com anexo, o "📎 nome" já é mostrado pelo anexo; exibe só a legenda.
                      const hasAtt = !!(msg.attachments && msg.attachments.length > 0);
                      const text = hasAtt
                        ? (msg.content.includes(' — ') ? msg.content.split(' — ').slice(1).join(' — ') : '')
                        : msg.content;
                      if (!text) return null;
                      return <p className="text-sm leading-relaxed whitespace-pre-wrap pr-12">{text}</p>;
                    })()}
                    <div className="absolute bottom-2 right-3 flex items-center gap-1">
                      <span className="text-xs text-slate-400">{time}</span>
                      {isOut && <StatusTick status={liveStatus} />}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Templates toolbar */}
      {showTemplates && (
        <div className="relative z-10 max-h-56 overflow-y-auto bg-white/95 border-t border-black/5 scrollbar-thin">
          {templates.length === 0 ? (
            <div className="px-4 py-3 text-xs text-slate-400">Nenhum template cadastrado. Crie em Templates.</div>
          ) : (
            <div className="p-2 space-y-1">
              {templates.map((t) => {
                const cm = CATEGORY_META[t.category];
                return (
                  <button
                    key={t.id}
                    onClick={() => handleUseTemplate(t)}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-af-light transition-colors flex items-start gap-2"
                  >
                    <FileText size={14} className="text-af-mid flex-shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-800 truncate">{t.name}</span>
                        <span className={cn('text-xs px-1.5 py-0.5 rounded-full flex-shrink-0', cm.color)}>{cm.label}</span>
                      </div>
                      <p className="text-xs text-slate-500 truncate">{t.body.replace(/\n/g, ' ')}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

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
        {/* Templates toggle button */}
        <button
          type="button"
          onClick={handleOpenTemplates}
          title="Templates prontos"
          className={cn(
            'flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all',
            showTemplates ? 'bg-af-mid text-white' : 'bg-white/80 text-slate-500 hover:bg-white hover:text-af-mid'
          )}
        >
          <FileText size={18} />
        </button>
        {/* AI toggle button */}
        <button
          type="button"
          onClick={() => { setShowAI(v => !v); setShowTemplates(false); }}
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
