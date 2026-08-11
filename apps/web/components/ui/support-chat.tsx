'use client';
import { useEffect, useRef, useState } from 'react';
import { MessageCircle, X, Send, Loader2, Plus, History, Trash2, Paperclip, FileText } from 'lucide-react';
import api from '@/lib/api';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface PendingAttachment {
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

const SUPPORTED_ATTACH_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
const MAX_ATTACH_BYTES = 8 * 1024 * 1024; // 8 MB

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

const WELCOME_MESSAGE: ChatMessage = {
  role: 'assistant',
  content: 'Olá! Sou o assistente do AF CRM. Pode me perguntar sobre o funil de vendas, inbox, SalesBot ou qualquer parte do processo — e também posso agir no CRM por você. Como posso ajudar?',
};

function relativeTime(iso: string): string {
  const d = new Date(iso).getTime();
  const diff = Date.now() - d;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  const days = Math.floor(h / 24);
  return days === 1 ? 'ontem' : `há ${days} dias`;
}

export function SupportChatButton() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [attachment, setAttachment] = useState<PendingAttachment | null>(null);
  const [attachError, setAttachError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, open]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  async function loadConversations() {
    try {
      const { data } = await api.get('/api/ai/conversations');
      setConversations(data);
    } catch { /* silencioso */ }
  }

  // Ao abrir o painel, carrega a lista de conversas do colaborador.
  useEffect(() => {
    if (open) loadConversations();
  }, [open]);

  function newConversation() {
    setMessages([WELCOME_MESSAGE]);
    setConversationId(null);
    setShowHistory(false);
    setInput('');
    setAttachment(null);
    setAttachError('');
  }

  async function openConversation(id: string) {
    setShowHistory(false);
    try {
      const { data } = await api.get(`/api/ai/conversations/${id}`);
      const msgs = Array.isArray(data.messages) ? data.messages : [WELCOME_MESSAGE];
      setMessages(msgs.length ? msgs : [WELCOME_MESSAGE]);
      setConversationId(id);
    } catch { /* silencioso */ }
  }

  async function deleteConversation(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await api.delete(`/api/ai/conversations/${id}`);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === conversationId) newConversation();
    } catch { /* silencioso */ }
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite escolher o mesmo arquivo de novo depois
    if (!file) return;
    setAttachError('');
    if (!SUPPORTED_ATTACH_TYPES.includes(file.type)) {
      setAttachError('Tipo não suportado. Envie imagem (JPG/PNG) ou PDF.');
      return;
    }
    if (file.size > MAX_ATTACH_BYTES) {
      setAttachError('Arquivo muito grande (máx. 8 MB).');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const dataBase64 = result.split(',')[1] || '';
      setAttachment({ fileName: file.name, mimeType: file.type, dataBase64 });
    };
    reader.onerror = () => setAttachError('Não consegui ler o arquivo. Tente de novo.');
    reader.readAsDataURL(file);
  }

  async function sendMessage() {
    const text = input.trim();
    if ((!text && !attachment) || loading) return;

    const displayContent = attachment ? `📎 ${attachment.fileName}${text ? `\n${text}` : ''}` : text;
    const nextMessages = [...messages, { role: 'user' as const, content: displayContent }];
    const pendingAttachment = attachment;
    setMessages(nextMessages);
    setInput('');
    setAttachment(null);
    setAttachError('');
    setLoading(true);

    try {
      const { data } = await api.post('/api/ai/support-chat', {
        messages: nextMessages,
        conversationId,
        ...(pendingAttachment ? { attachment: pendingAttachment } : {}),
      });
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
      if (data.conversationId) {
        setConversationId(data.conversationId);
        loadConversations(); // atualiza o histórico (novo título/ordem)
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error || 'Não consegui responder agora. Tente novamente em instantes ou fale com seu gestor.';
      setMessages((prev) => [...prev, { role: 'assistant', content: msg }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-6 z-[100] w-[360px] max-w-[calc(100vw-3rem)] h-[480px] bg-white rounded-2xl border border-af-border shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 border-b border-af-border bg-af-navy flex-shrink-0">
            <div className="w-9 h-9 bg-white/15 rounded-xl flex items-center justify-center flex-shrink-0">
              <MessageCircle size={18} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold text-sm">Assistente AF CRM</p>
              <p className="text-white/60 text-xs">Dúvidas e ações no sistema</p>
            </div>
            <button onClick={() => setShowHistory((v) => !v)} title="Histórico de conversas" className={`p-1.5 rounded-lg transition-colors ${showHistory ? 'bg-white/20 text-white' : 'text-white/70 hover:text-white hover:bg-white/10'}`}>
              <History size={17} />
            </button>
            <button onClick={newConversation} title="Nova conversa" className="p-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors">
              <Plus size={18} />
            </button>
            <button onClick={() => setOpen(false)} title="Fechar" className="p-1.5 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors">
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 relative overflow-hidden">
            {/* Painel de histórico (sobrepõe) */}
            {showHistory && (
              <div className="absolute inset-0 z-10 bg-white flex flex-col">
                <div className="px-4 py-2.5 border-b border-af-border flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-700">Suas conversas</span>
                  <button onClick={newConversation} className="text-xs font-medium text-af-accent hover:underline flex items-center gap-1">
                    <Plus size={13} /> Nova
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto scrollbar-thin">
                  {conversations.length === 0 ? (
                    <div className="p-4 text-sm text-slate-400">Nenhuma conversa salva ainda.</div>
                  ) : (
                    conversations.map((c) => (
                      <div
                        key={c.id}
                        onClick={() => openConversation(c.id)}
                        className={`group flex items-center gap-2 px-4 py-2.5 border-b border-af-border/50 cursor-pointer hover:bg-af-light transition-colors ${c.id === conversationId ? 'bg-af-light' : ''}`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm text-slate-800 truncate">{c.title}</p>
                          <p className="text-xs text-slate-400">{relativeTime(c.updatedAt)}</p>
                        </div>
                        <button onClick={(e) => deleteConversation(c.id, e)} title="Excluir" className="opacity-0 group-hover:opacity-100 text-slate-300 hover:text-red-500 transition-all flex-shrink-0">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            <div ref={scrollRef} className="h-full overflow-y-auto p-4 space-y-3 scrollbar-thin">
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div
                    className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap ${
                      m.role === 'user'
                        ? 'bg-af-navy text-white rounded-br-sm'
                        : 'bg-slate-100 text-slate-800 rounded-bl-sm'
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-slate-100 text-slate-500 rounded-2xl rounded-bl-sm px-3.5 py-2 text-sm flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin" /> Digitando...
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="p-3 border-t border-af-border flex-shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
              onChange={handleFileSelect}
              className="hidden"
            />
            {attachment && (
              <div className="flex items-center gap-1.5 mb-2 px-2.5 py-1.5 bg-af-light rounded-lg text-xs text-slate-700">
                <FileText size={13} className="flex-shrink-0 text-af-navy" />
                <span className="truncate flex-1">{attachment.fileName}</span>
                <button onClick={() => setAttachment(null)} className="text-slate-400 hover:text-red-500 flex-shrink-0" title="Remover anexo">
                  <X size={13} />
                </button>
              </div>
            )}
            {attachError && <p className="text-xs text-red-500 mb-1.5">{attachError}</p>}
            <div className="flex items-end gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={loading}
                title="Anexar arquivo (imagem ou PDF)"
                className="w-9 h-9 flex-shrink-0 flex items-center justify-center text-slate-500 hover:text-af-navy hover:bg-af-light rounded-xl transition-colors disabled:opacity-40"
              >
                <Paperclip size={16} />
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                rows={1}
                placeholder={attachment ? 'O que você quer saber sobre o arquivo? (opcional)' : 'Digite sua dúvida...  (Shift+Enter pula linha)'}
                className="flex-1 resize-none max-h-[120px] leading-snug border border-af-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-af-accent/40"
              />
              <button
                onClick={sendMessage}
                disabled={loading || (!input.trim() && !attachment)}
                className="w-9 h-9 flex-shrink-0 flex items-center justify-center bg-af-navy text-white rounded-xl disabled:opacity-40"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className="fixed bottom-6 right-6 z-[100] w-14 h-14 rounded-full bg-af-navy text-white shadow-xl flex items-center justify-center hover:scale-105 transition-transform"
        title="Assistente do CRM"
      >
        {open ? <X size={22} /> : <MessageCircle size={22} />}
      </button>
    </>
  );
}
