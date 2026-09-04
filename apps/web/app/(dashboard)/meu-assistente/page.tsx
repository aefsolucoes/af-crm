'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useAuthStore } from '@/store/auth.store';
import { useSupportChat, MAX_ATTACHMENTS } from '@/hooks/use-support-chat';
import {
  Sparkles, Send, Loader2, Plus, Trash2, Paperclip, FileText, X, ArrowLeft, PanelLeftClose, PanelLeftOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';

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

/**
 * Aba solo do assistente (nova aba do navegador, sem a barra do CRM em
 * volta — pedido explícito do usuário: "não dentro do CRM", igual o Claude
 * abre a dele). Mesmo motor de sempre por trás (useSupportChat — o mesmo
 * hook do botão flutuante, POST /api/ai/support-chat com as mesmas
 * ferramentas), só que numa tela cheia com histórico fixo do lado, no
 * lugar do balãozinho no canto.
 */
export default function MeuAssistentePage() {
  const { user } = useAuthStore();
  const [showSidebar, setShowSidebar] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    messages, conversationId, input, setInput, loading,
    conversations, loadConversations,
    attachments, attachError, fileInputRef,
    newConversation, openConversation, deleteConversation,
    handleFileSelect, removeAttachment, sendMessage,
  } = useSupportChat();

  useEffect(() => { loadConversations(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  return (
    <div className="flex h-screen bg-af-light">
      {/* Histórico — fixo do lado, com espaço de sobra de tela cheia (o
          balão flutuante só tinha um painel que sobrepunha o chat). */}
      {showSidebar && (
        <div className="w-72 flex-shrink-0 bg-af-navy flex flex-col">
          <div className="p-4 border-b border-white/10">
            <Link href="/dashboard" className="flex items-center gap-2 text-white/70 hover:text-white text-xs mb-4 transition-colors">
              <ArrowLeft size={13} /> Voltar pro CRM
            </Link>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 bg-white/15 rounded-xl flex items-center justify-center flex-shrink-0">
                <Sparkles size={18} className="text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-white font-semibold text-sm truncate">Assistente AF CRM</p>
                <p className="text-white/50 text-xs truncate">{user?.name}</p>
              </div>
            </div>
          </div>
          <button
            onClick={newConversation}
            className="mx-4 mt-3 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-white/10 text-white text-sm font-medium hover:bg-white/15 transition-colors"
          >
            <Plus size={15} /> Nova conversa
          </button>
          <div className="flex-1 overflow-y-auto scrollbar-thin mt-3 px-2 pb-3 space-y-0.5">
            {conversations.length === 0 ? (
              <p className="text-xs text-white/40 px-2 py-3">Nenhuma conversa salva ainda.</p>
            ) : (
              conversations.map((c) => (
                <div
                  key={c.id}
                  onClick={() => openConversation(c.id)}
                  className={cn(
                    'group flex items-center gap-2 px-2.5 py-2 rounded-lg cursor-pointer transition-colors',
                    c.id === conversationId ? 'bg-white/15' : 'hover:bg-white/10'
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-white/90 truncate">{c.title}</p>
                    <p className="text-[11px] text-white/40">{relativeTime(c.updatedAt)}</p>
                  </div>
                  <button
                    onClick={(e) => deleteConversation(c.id, e)}
                    title="Excluir"
                    className="opacity-0 group-hover:opacity-100 text-white/40 hover:text-red-300 transition-all flex-shrink-0"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Chat */}
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-af-border bg-white flex-shrink-0">
          <button
            onClick={() => setShowSidebar((v) => !v)}
            title={showSidebar ? 'Esconder histórico' : 'Mostrar histórico'}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-af-light transition-colors flex-shrink-0"
          >
            {showSidebar ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
          {!showSidebar && (
            <Link href="/dashboard" className="flex items-center gap-1 text-slate-400 hover:text-slate-700 text-xs transition-colors">
              <ArrowLeft size={13} /> CRM
            </Link>
          )}
          <p className="text-sm font-semibold text-slate-700 ml-1">Assistente AF CRM</p>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto scrollbar-thin px-6 py-6">
          <div className="max-w-2xl mx-auto space-y-4">
            {messages.map((m, i) => (
              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[75%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap',
                    m.role === 'user' ? 'bg-af-navy text-white rounded-br-sm' : 'bg-white border border-af-border text-slate-800 rounded-bl-sm'
                  )}
                >
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex justify-start">
                <div className="bg-white border border-af-border text-slate-500 rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm flex items-center gap-2">
                  <Loader2 size={14} className="animate-spin" /> Digitando...
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="border-t border-af-border bg-white px-6 py-4 flex-shrink-0">
          <div className="max-w-2xl mx-auto">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
              onChange={handleFileSelect}
              className="hidden"
            />
            {attachments.length > 0 && (
              <div className="flex flex-col gap-1 mb-2">
                {attachments.map((a, i) => (
                  <div key={`${a.fileName}-${i}`} className="flex items-center gap-1.5 px-2.5 py-1.5 bg-af-light rounded-lg text-xs text-slate-700">
                    <FileText size={13} className="flex-shrink-0 text-af-navy" />
                    <span className="truncate flex-1">{a.fileName}</span>
                    <button onClick={() => removeAttachment(i)} className="text-slate-400 hover:text-red-500 flex-shrink-0" title="Remover anexo">
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {attachError && <p className="text-xs text-red-500 mb-1.5">{attachError}</p>}
            <div className="flex items-end gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={loading || attachments.length >= MAX_ATTACHMENTS}
                title={attachments.length >= MAX_ATTACHMENTS ? `Máximo de ${MAX_ATTACHMENTS} arquivos por mensagem` : 'Anexar arquivo(s) — imagem ou PDF'}
                className="w-10 h-10 flex-shrink-0 flex items-center justify-center text-slate-500 hover:text-af-navy hover:bg-af-light rounded-xl transition-colors disabled:opacity-40"
              >
                <Paperclip size={17} />
              </button>
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                rows={1}
                placeholder={attachments.length ? 'O que você quer saber sobre o(s) arquivo(s)? (opcional)' : 'Digite sua dúvida... (Shift+Enter pula linha)'}
                className="flex-1 resize-none max-h-[160px] leading-snug border border-af-border rounded-xl px-3.5 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-af-accent/40"
              />
              <button
                onClick={sendMessage}
                disabled={loading || (!input.trim() && attachments.length === 0)}
                className="w-10 h-10 flex-shrink-0 flex items-center justify-center bg-af-navy text-white rounded-xl disabled:opacity-40"
              >
                <Send size={17} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
