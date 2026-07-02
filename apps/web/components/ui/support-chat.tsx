'use client';
import { useEffect, useRef, useState } from 'react';
import { MessageCircle, X, Send, Loader2 } from 'lucide-react';
import api from '@/lib/api';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

const WELCOME_MESSAGE: ChatMessage = {
  role: 'assistant',
  content: 'Olá! Sou o assistente do AF CRM. Pode me perguntar sobre o funil de vendas, inbox, SalesBot ou qualquer parte do processo. Como posso ajudar?',
};

export function SupportChatButton() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, open]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    const nextMessages = [...messages, { role: 'user' as const, content: text }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);

    try {
      const { data } = await api.post('/api/ai/support-chat', { messages: nextMessages });
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'Não consegui responder agora. Tente novamente em instantes ou fale com seu gestor.' }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      {open && (
        <div className="fixed bottom-24 right-6 z-[100] w-[360px] max-w-[calc(100vw-3rem)] h-[480px] bg-white rounded-2xl border border-af-border shadow-2xl flex flex-col overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-af-border bg-af-navy flex-shrink-0">
            <div className="w-9 h-9 bg-white/15 rounded-xl flex items-center justify-center">
              <MessageCircle size={18} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold text-sm">Assistente AF CRM</p>
              <p className="text-white/60 text-xs">Dúvidas sobre o sistema e o processo</p>
            </div>
            <button onClick={() => setOpen(false)} className="text-white/70 hover:text-white">
              <X size={18} />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 scrollbar-thin">
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

          <div className="p-3 border-t border-af-border flex-shrink-0">
            <div className="flex items-center gap-2">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                placeholder="Digite sua dúvida..."
                className="flex-1 border border-af-border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-af-accent/40"
              />
              <button
                onClick={sendMessage}
                disabled={loading || !input.trim()}
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
        title="Tirar dúvidas sobre o CRM"
      >
        {open ? <X size={22} /> : <MessageCircle size={22} />}
      </button>
    </>
  );
}
