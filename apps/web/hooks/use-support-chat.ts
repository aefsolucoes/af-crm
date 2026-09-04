'use client';
import { useRef, useState } from 'react';
import api from '@/lib/api';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PendingAttachment {
  fileName: string;
  mimeType: string;
  dataBase64: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
}

export const SUPPORTED_ATTACH_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
export const MAX_ATTACH_BYTES = 8 * 1024 * 1024; // 8 MB por arquivo
export const MAX_ATTACHMENTS = 6; // ex.: formulário + CNH + comprovantes, tudo de uma vez
export const MAX_ATTACH_TOTAL_BYTES = 20 * 1024 * 1024; // 20 MB somando todos os anexos da mensagem

export const WELCOME_MESSAGE: ChatMessage = {
  role: 'assistant',
  content: 'Olá! Sou o assistente do AF CRM. Pode me perguntar sobre o funil de vendas, inbox, SalesBot ou qualquer parte do processo — e também posso agir no CRM por você. Como posso ajudar?',
};

/**
 * Lógica do assistente de IA interno (POST /api/ai/support-chat + conversas
 * salvas) — extraída de components/ui/support-chat.tsx (o botão flutuante,
 * que passou a usar este hook) pra também dar pra montar uma versão em tela
 * cheia (app/(dashboard)/meu-assistente) sem duplicar a parte que importa
 * (rede, validação de anexo, histórico) — só o layout muda entre os dois.
 */
export function useSupportChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([WELCOME_MESSAGE]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function loadConversations() {
    try {
      const { data } = await api.get('/api/ai/conversations');
      setConversations(data);
    } catch { /* silencioso */ }
  }

  function newConversation() {
    setMessages([WELCOME_MESSAGE]);
    setConversationId(null);
    setInput('');
    setAttachments([]);
    setAttachError('');
  }

  async function openConversation(id: string) {
    try {
      const { data } = await api.get(`/api/ai/conversations/${id}`);
      const msgs = Array.isArray(data.messages) ? data.messages : [WELCOME_MESSAGE];
      setMessages(msgs.length ? msgs : [WELCOME_MESSAGE]);
      setConversationId(id);
    } catch { /* silencioso */ }
  }

  async function deleteConversation(id: string, e?: React.MouseEvent) {
    e?.stopPropagation();
    try {
      await api.delete(`/api/ai/conversations/${id}`);
      setConversations((prev) => prev.filter((c) => c.id !== id));
      if (id === conversationId) newConversation();
    } catch { /* silencioso */ }
  }

  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(new Error('read error'));
      reader.readAsDataURL(file);
    });
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // permite escolher o mesmo arquivo de novo depois
    if (files.length === 0) return;
    setAttachError('');

    const accepted: File[] = [];
    let totalSoFar = attachments.reduce((s, a) => s + Math.ceil((a.dataBase64.length * 3) / 4), 0);
    for (const file of files) {
      if (attachments.length + accepted.length >= MAX_ATTACHMENTS) {
        setAttachError(`Máximo de ${MAX_ATTACHMENTS} arquivos por mensagem — os demais não foram adicionados.`);
        break;
      }
      if (!SUPPORTED_ATTACH_TYPES.includes(file.type)) {
        setAttachError(`"${file.name}": tipo não suportado (envie imagem JPG/PNG ou PDF).`);
        continue;
      }
      if (file.size > MAX_ATTACH_BYTES) {
        setAttachError(`"${file.name}": arquivo muito grande (máx. 8 MB por arquivo).`);
        continue;
      }
      if (totalSoFar + file.size > MAX_ATTACH_TOTAL_BYTES) {
        setAttachError('Limite de 20 MB no total entre os anexos da mensagem — pare aqui e envie o restante numa próxima mensagem.');
        break;
      }
      totalSoFar += file.size;
      accepted.push(file);
    }
    if (accepted.length === 0) return;

    try {
      const read = await Promise.all(accepted.map(async (file) => ({
        fileName: file.name,
        mimeType: file.type,
        dataBase64: await readFileAsBase64(file),
      })));
      setAttachments((prev) => [...prev, ...read]);
    } catch {
      setAttachError('Não consegui ler um dos arquivos. Tente de novo.');
    }
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  async function sendMessage() {
    const text = input.trim();
    if ((!text && attachments.length === 0) || loading) return;

    const displayContent = attachments.length
      ? `${attachments.map((a) => `📎 ${a.fileName}`).join('\n')}${text ? `\n${text}` : ''}`
      : text;
    const nextMessages = [...messages, { role: 'user' as const, content: displayContent }];
    const pendingAttachments = attachments;
    setMessages(nextMessages);
    setInput('');
    setAttachments([]);
    setAttachError('');
    setLoading(true);

    try {
      const { data } = await api.post('/api/ai/support-chat', {
        messages: nextMessages,
        conversationId,
        ...(pendingAttachments.length ? { attachments: pendingAttachments } : {}),
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

  return {
    messages, conversationId, input, setInput, loading,
    conversations, loadConversations,
    attachments, attachError, fileInputRef,
    newConversation, openConversation, deleteConversation,
    handleFileSelect, removeAttachment, sendMessage,
  };
}
