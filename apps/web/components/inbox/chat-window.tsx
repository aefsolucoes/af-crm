'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Message, Channel, Note } from '@/types';
import { cn, formatDateTime } from '@/lib/utils';
import { Send, Paperclip, Smile, Check, CheckCheck, Sparkles, Loader2, FileText, Clock, BadgeCheck, Forward, Search, X } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { getSocket } from '@/lib/socket';
import { Avatar } from '@/components/ui/avatar';
import { AttachmentView } from '@/components/inbox/message-attachment';
import { MessageTemplate, CATEGORY_META, getTemplates, fillTemplate } from '@/lib/templates';

// Cor estável por remetente em grupos (estilo WhatsApp: mesma pessoa, mesma cor).
const SENDER_COLORS = ['#e542a3', '#00a884', '#ff7e00', '#6a5cff', '#0ea5e9', '#e0453e', '#7c9c00', '#b26bff'];
function groupSenderColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SENDER_COLORS[h % SENDER_COLORS.length];
}

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
  /** Fecha a conversa (ESC), como no WhatsApp. */
  onClose?: () => void;
}

type AIMode = 'grammar' | 'professional' | 'friendly' | 'fun';

const AI_BUTTONS: { mode: AIMode; label: string; emoji: string }[] = [
  { mode: 'grammar',      label: 'Corrigir gramática', emoji: '✏️' },
  { mode: 'professional', label: 'Profissional',        emoji: '💼' },
  { mode: 'friendly',     label: 'Amigável',            emoji: '😊' },
  { mode: 'fun',          label: 'Divertido',           emoji: '🎉' },
];

type WhatsAppVia = 'qr' | 'api';

// ── Templates aprovados pela Meta (janela de 24h) ────────────────────────────
interface MetaTemplate {
  name: string;
  status: string;
  category: string;
  language: string;
  components: { type: string; text?: string }[];
}

/** Números de variáveis {{1}}, {{2}}... usados no corpo do template (ordenados, sem repetir). */
function extractMetaVariables(text: string): number[] {
  const matches = text.match(/\{\{(\d+)\}\}/g) || [];
  const nums = [...new Set(matches.map((m) => parseInt(m.replace(/\D/g, ''), 10)))];
  return nums.sort((a, b) => a - b);
}

function fillMetaTemplate(text: string, vars: Record<number, string>): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_, n) => vars[parseInt(n, 10)] || `{{${n}}}`);
}

const JANELA_24H_MS = 24 * 60 * 60 * 1000;

/** Última mensagem RECEBIDA pelo canal da API oficial (id começa com "wamid") —
 *  é ela que abre/reabre a janela de 24h de atendimento gratuito da Meta. */
function lastInboundApiMessage(messages: Message[]): Message | null {
  let latest: Message | null = null;
  for (const m of messages) {
    if (m.direction !== 'INBOUND') continue;
    if (!m.externalId?.startsWith('wamid')) continue;
    if (!latest || new Date(m.createdAt).getTime() > new Date(latest.createdAt).getTime()) latest = m;
  }
  return latest;
}

export function ChatWindow({ leadId, leadName, messages, notes = [], onNewMessage, onClose }: ChatWindowProps) {
  const [content, setContent] = useState('');
  const [channel, setChannel] = useState<Channel>('WHATSAPP');
  const [via, setVia] = useState<WhatsAppVia | null>(null);
  // Número de WhatsApp (QR) escolhido para enviar; null = automático (o número
  // que a conversa já usa ou o primeiro conectado). Escolher outro NÃO duplica a
  // conversa — é o mesmo lead, só muda por qual número a mensagem sai.
  const [fromNumberId, setFromNumberId] = useState<string | null>(null);
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

  // Janela de 24h da API oficial: conta a partir da última mensagem que o
  // CLIENTE mandou por lá. Passado isso, só dá para responder com template.
  const lastInbound = lastInboundApiMessage(messages);
  const windowDeadline = lastInbound ? new Date(lastInbound.createdAt).getTime() + JANELA_24H_MS : null;
  const windowRemainingMs = windowDeadline ? windowDeadline - Date.now() : null;
  const windowOpen = windowRemainingMs === null ? null : windowRemainingMs > 0;

  // Números QR conectados + rótulos (id → apelido) para o seletor e p/ marcar
  // cada mensagem enviada com o número que a mandou.
  const connectedQr = (qrNumbers || []).filter(n => n.status === 'connected');
  const numberLabels: Record<string, string> = Object.fromEntries((qrNumbers || []).map(n => [n.id, n.label]));
  // Número que a conversa já vinha usando (última mensagem com número definido).
  const lastRouted = [...messages].reverse().find(m => m.whatsappNumberId)?.whatsappNumberId ?? null;
  // Número ativo para enviar: escolha do usuário, senão o da conversa (se conectado), senão o 1º conectado.
  const activeNumberId =
    fromNumberId ??
    (lastRouted && connectedQr.some(n => n.id === lastRouted) ? lastRouted : connectedQr[0]?.id) ??
    null;

  // Ao trocar de conversa, volta o seletor para "automático".
  useEffect(() => { setFromNumberId(null); }, [leadId]);
  const [aiLoading, setAiLoading] = useState<AIMode | null>(null);
  const [showAI, setShowAI] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [metaTemplates, setMetaTemplates] = useState<MetaTemplate[] | null>(null);
  const [pendingMetaTemplate, setPendingMetaTemplate] = useState<MetaTemplate | null>(null);
  const [metaTemplateVars, setMetaTemplateVars] = useState<Record<number, string>>({});
  const [sendingTemplate, setSendingTemplate] = useState(false);

  // ── Encaminhar mensagem para outra conversa ──────────────────────────────
  const [forwardingMessage, setForwardingMessage] = useState<Message | null>(null);
  const [forwardLeads, setForwardLeads] = useState<{ id: string; name: string; contact?: { name?: string; phone?: string; whatsappPhone?: string } }[] | null>(null);
  const [forwardSearch, setForwardSearch] = useState('');
  const [forwardBusy, setForwardBusy] = useState(false);

  function openForward(msg: Message) {
    setForwardingMessage(msg);
    setForwardSearch('');
    if (forwardLeads === null) {
      api.get('/api/leads').then(({ data }) => setForwardLeads(data)).catch(() => setForwardLeads([]));
    }
  }

  async function handleConfirmForward(toLeadId: string) {
    if (!forwardingMessage) return;
    setForwardBusy(true);
    try {
      await api.post(`/api/messages/${forwardingMessage.id}/forward`, { toLeadId });
      toast('Mensagem encaminhada!');
      setForwardingMessage(null);
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao encaminhar a mensagem', 'error');
    } finally {
      setForwardBusy(false);
    }
  }

  const forwardMatches = (forwardLeads || [])
    .filter((l) => l.id !== leadId)
    .filter((l) => {
      const q = forwardSearch.trim().toLowerCase();
      if (!q) return true;
      const phone = (l.contact?.whatsappPhone || l.contact?.phone || '').replace(/\D/g, '');
      const qDigits = q.replace(/\D/g, '');
      return l.name.toLowerCase().includes(q) || (qDigits.length >= 3 && phone.includes(qDigits));
    })
    .slice(0, 30);

  // Só para o contador de 24h "tickar" (recalcula a cada minuto).
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // ESC fecha a conversa (como no WhatsApp). Se houver um popup aberto
  // (templates/IA), o ESC fecha o popup primeiro.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (showAI || showTemplates) {
        setShowAI(false);
        setShowTemplates(false);
        return;
      }
      onClose?.();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showAI, showTemplates, onClose]);
  // Mapa de status atualizado via socket: messageId → status
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingFile, setUploadingFile] = useState(false);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Cresce a caixa de mensagem conforme o texto (até um limite), como no WhatsApp.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }, [content]);

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
        ...(channel === 'WHATSAPP'
          ? { via: effectiveVia, ...(effectiveVia === 'qr' && activeNumberId ? { fromNumberId: activeNumberId } : {}) }
          : {}),
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

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite reenviar o mesmo arquivo
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { toast('Arquivo muito grande (máx. 25 MB)', 'error'); return; }
    setUploadingFile(true);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
      const { data } = await api.post('/api/messages/send-media', {
        leadId,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        dataBase64,
      });
      onNewMessage(data);
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao enviar o arquivo', 'error');
    } finally {
      setUploadingFile(false);
    }
  }

  function handleOpenTemplates() {
    setTemplates(getTemplates());
    setShowTemplates(v => !v);
    setShowAI(false);
    setPendingMetaTemplate(null);
    if (metaTemplates === null) {
      api.get('/api/settings/whatsapp/templates')
        .then(({ data }) => setMetaTemplates((data.templates || []).filter((t: MetaTemplate) => t.status === 'APPROVED')))
        .catch(() => setMetaTemplates([])); // sem WABA/config ainda — mostra a seção vazia, sem quebrar o painel
    }
  }

  function handleUseTemplate(template: MessageTemplate) {
    const firstName = leadName?.split(' ')[0] || leadName || '';
    const filled = fillTemplate(template.body, { nome: leadName, primeiro_nome: firstName });
    setContent(filled);
    setShowTemplates(false);
    inputRef.current?.focus();
  }

  // ── Templates aprovados pela Meta ──────────────────────────────────────────
  function handleSelectMetaTemplate(template: MetaTemplate) {
    const body = template.components.find((c) => c.type === 'BODY')?.text || '';
    const vars = extractMetaVariables(body);
    setPendingMetaTemplate(template);
    setMetaTemplateVars(Object.fromEntries(vars.map((n) => [n, ''])));
  }

  async function handleSendMetaTemplate() {
    if (!pendingMetaTemplate) return;
    const body = pendingMetaTemplate.components.find((c) => c.type === 'BODY')?.text || '';
    const varNums = extractMetaVariables(body);
    const bodyParams = varNums.map((n) => metaTemplateVars[n] || '');
    const previewText = fillMetaTemplate(body, metaTemplateVars);
    setSendingTemplate(true);
    try {
      const { data } = await api.post('/api/messages/send-template', {
        leadId,
        templateName: pendingMetaTemplate.name,
        language: pendingMetaTemplate.language,
        bodyParams,
        previewText,
      });
      onNewMessage(data);
      setPendingMetaTemplate(null);
      setShowTemplates(false);
      toast('Template enviado!');
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao enviar o template', 'error');
    } finally {
      setSendingTemplate(false);
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
    STAGE_CHANGE: { icon: '↕️', label: 'Etapa alterada',   bg: 'bg-[#182229]', text: 'text-[#53bdeb]' },
    DATA_EDIT:    { icon: '✏️', label: 'Dados editados',   bg: 'bg-[#182229]', text: 'text-[#8696a0]' },
    COMMENT:      { icon: '💬', label: 'Comentário',       bg: 'bg-[#182229]', text: 'text-[#f0b232]' },
    CALL:         { icon: '📞', label: 'Ligação',          bg: 'bg-[#182229]', text: 'text-[#00a884]' },
    EMAIL:        { icon: '📧', label: 'E-mail',           bg: 'bg-[#182229]', text: 'text-[#bf7fff]' },
  };

  return (
    <div className="flex flex-col flex-1 h-full" style={{ background: '#0b141a' }}>
      {/* WhatsApp-style background pattern */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.06]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }}
      />

      {/* Header — WhatsApp dark */}
      <div className="relative z-10 flex items-center gap-3 px-4 py-3 text-[#e9edef] shadow-md" style={{ backgroundColor: '#202c33' }}>
        <Avatar name={leadName} size="md" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{leadName}</p>
          <p className="text-xs opacity-80">
            {CHANNEL_ICONS[channel]} {CHANNEL_LABELS[channel]}
          </p>
        </div>
      </div>

      {/* Seletor: por qual WhatsApp enviar — lista única e discreta (cada número
          pelo apelido, mais a API oficial), sem separar em dois níveis */}
      <div className="relative z-10 flex items-center gap-1 px-4 py-2 bg-[#202c33] border-b border-[#222e35] flex-wrap">
        <span className="text-xs text-[#8696a0] font-medium mr-1">Enviar por:</span>

        {(qrNumbers || []).map((n) => {
          const isConn = n.status === 'connected';
          const selected = effectiveVia === 'qr' && activeNumberId === n.id;
          return (
            <button
              key={n.id}
              onClick={() => { if (isConn) { setVia('qr'); setFromNumberId(n.id); } }}
              disabled={!isConn}
              title={isConn ? `Enviar por ${n.label}` : `${n.label} desconectado — reconecte em Configurações → QR Code`}
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
                selected ? 'bg-[#2a3942] text-[#e9edef] font-medium' : 'text-[#8696a0] hover:text-[#e9edef]'
              )}
            >
              <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', isConn ? 'bg-green-400' : 'bg-red-400')} />
              {n.label}
            </button>
          );
        })}

        <button
          onClick={() => setVia('api')}
          title={apiActive ? 'API oficial da Meta ativa' : 'API oficial não configurada/inativa'}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors',
            effectiveVia === 'api' ? 'bg-[#2a3942] text-[#e9edef] font-medium' : 'text-[#8696a0] hover:text-[#e9edef]'
          )}
        >
          <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', apiActive ? 'bg-green-400' : 'bg-red-400')} />
          API Oficial
        </button>

        {/* Janela de 24h da API oficial — aviso discreto, não é um botão */}
        {windowOpen !== null && (
          <>
            <span className="h-4 w-px bg-[#2a3942]" />
            <span
              title={windowOpen ? 'Tempo restante para responder com texto livre pela API oficial' : 'Fora da janela de 24h — só é possível responder com um template aprovado'}
              className={cn(
                'flex items-center gap-1 text-xs',
                windowOpen ? 'text-[#8696a0]' : 'text-amber-400 font-medium'
              )}
            >
              <Clock size={12} className="flex-shrink-0" />
              {windowOpen
                ? (() => {
                    const h = Math.floor((windowRemainingMs as number) / 3_600_000);
                    const m = Math.floor(((windowRemainingMs as number) % 3_600_000) / 60_000);
                    return `${h}h ${m}min`;
                  })()
                : 'Janela fechada'}
            </span>
          </>
        )}
      </div>

      {/* Timeline unificado: mensagens + eventos de fluxo */}
      <div className="relative z-10 flex-1 overflow-y-auto px-4 py-4 space-y-1 scrollbar-thin">
        {grouped.map(({ date, items }) => (
          <div key={date}>
            {/* Separador de data */}
            <div className="flex justify-center my-3">
              <span className="bg-[#182229] text-[#8696a0] text-xs px-3 py-1 rounded-full shadow-sm">
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
                <div key={msg.id} className={cn('group flex items-center gap-1 mb-0.5', isOut ? 'justify-end' : 'justify-start')}>
                  {isOut && (
                    <button
                      onClick={() => openForward(msg)}
                      title="Encaminhar"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-[#8696a0] hover:text-[#e9edef] flex-shrink-0"
                    >
                      <Forward size={14} />
                    </button>
                  )}
                  <div
                    className={cn(
                      'relative max-w-xs lg:max-w-md px-3 py-2 shadow-sm',
                      isOut
                        ? 'rounded-tl-2xl rounded-tr-2xl rounded-bl-2xl text-[#e9edef]'
                        : 'rounded-tl-2xl rounded-tr-2xl rounded-br-2xl text-[#e9edef]',
                      showTail && isOut  ? 'rounded-br-sm' : '',
                      showTail && !isOut ? 'rounded-bl-sm' : '',
                    )}
                    style={{ backgroundColor: isOut ? '#005c4b' : '#202c33' }}
                  >
                    {msg.forwardedFromLeadName && (
                      <p className="text-[10px] italic text-[#e9edef]/55 mb-0.5 flex items-center gap-1">
                        <Forward size={10} /> Encaminhada de {msg.forwardedFromLeadName}
                      </p>
                    )}
                    {isOut && (() => {
                      // "via {apelido do número} · {quem enviou}". Mensagens da API
                      // Oficial (id começa com "wamid") não têm whatsappNumberId — não
                      // dá pra cair no "último número QR usado" (isso rotulava errado,
                      // como se tivesse saído pelo QR). O apelido só cai no "último
                      // número" quando a MESMA mensagem realmente não tem essa info.
                      const isApiMsg = typeof msg.externalId === 'string' && msg.externalId.startsWith('wamid');
                      const numLabel = msg.whatsappNumberId
                        ? numberLabels[msg.whatsappNumberId]
                        : isApiMsg
                        ? 'API Oficial'
                        : numberLabels[lastRouted || ''];
                      const sender = (msg as any).sentBy?.name as string | undefined;
                      if (!numLabel && !sender) return null;
                      return (
                        <p className="text-[10px] font-medium text-[#e9edef]/55 mb-0.5">
                          {[numLabel && `via ${numLabel}`, sender].filter(Boolean).join(' · ')}
                        </p>
                      );
                    })()}
                    {/* Em grupo: nome de quem enviou, acima da mensagem (estilo WhatsApp). */}
                    {!isOut && (msg as any).senderName && (
                      <p className="text-[11px] font-semibold mb-0.5" style={{ color: groupSenderColor((msg as any).senderName) }}>
                        {(msg as any).senderName}
                      </p>
                    )}
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
                      <span className="text-[10px] text-[#e9edef]/50">{time}</span>
                      {isOut && <StatusTick status={liveStatus} />}
                    </div>
                  </div>
                  {!isOut && (
                    <button
                      onClick={() => openForward(msg)}
                      title="Encaminhar"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-[#8696a0] hover:text-[#e9edef] flex-shrink-0"
                    >
                      <Forward size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Templates toolbar */}
      {showTemplates && (
        <div className="relative z-10 max-h-80 overflow-y-auto bg-[#202c33] border-t border-[#222e35] scrollbar-thin">
          {pendingMetaTemplate ? (
            // ── Preenche as variáveis do template Meta escolhido, antes de enviar ──
            <div className="p-3 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-[#e9edef]">{pendingMetaTemplate.name}</span>
                <button onClick={() => setPendingMetaTemplate(null)} className="text-xs text-[#8696a0] hover:text-[#e9edef]">Cancelar</button>
              </div>
              {Object.keys(metaTemplateVars).map((n) => (
                <div key={n} className="flex flex-col gap-1">
                  <label className="text-xs text-[#8696a0]">Variável {`{{${n}}}`}</label>
                  <input
                    value={metaTemplateVars[Number(n)] || ''}
                    onChange={(e) => setMetaTemplateVars((v) => ({ ...v, [Number(n)]: e.target.value }))}
                    className="w-full px-2.5 py-1.5 text-sm rounded-lg bg-[#2a3942] text-[#e9edef] border border-transparent focus:outline-none focus:border-[#00a884]/40"
                  />
                </div>
              ))}
              <div className="p-2.5 rounded-lg bg-[#111b21] text-xs text-[#8696a0] whitespace-pre-wrap">
                {fillMetaTemplate(pendingMetaTemplate.components.find((c) => c.type === 'BODY')?.text || '', metaTemplateVars)}
              </div>
              <button
                onClick={handleSendMetaTemplate}
                disabled={sendingTemplate}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-[#00a884] text-[#111b21] text-sm font-medium disabled:opacity-50"
              >
                {sendingTemplate ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                {sendingTemplate ? 'Enviando...' : 'Enviar template'}
              </button>
            </div>
          ) : (
            <>
              <div className="p-2 space-y-1">
                <p className="px-1 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#8696a0]">Respostas rápidas</p>
                {templates.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-[#8696a0]">Nenhuma cadastrada. Crie em Templates.</div>
                ) : templates.map((t) => {
                  const cm = CATEGORY_META[t.category];
                  return (
                    <button
                      key={t.id}
                      onClick={() => handleUseTemplate(t)}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-[#2a3942] transition-colors flex items-start gap-2"
                    >
                      <FileText size={14} className="text-[#00a884] flex-shrink-0 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-[#e9edef] truncate">{t.name}</span>
                          <span className={cn('text-xs px-1.5 py-0.5 rounded-full flex-shrink-0', cm.color)}>{cm.label}</span>
                        </div>
                        <p className="text-xs text-[#8696a0] truncate">{t.body.replace(/\n/g, ' ')}</p>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="border-t border-[#222e35] p-2 space-y-1">
                <p className="px-1 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#8696a0]">Templates Meta (aprovados)</p>
                {metaTemplates === null ? (
                  <div className="px-2 py-2 text-xs text-[#8696a0]">Carregando...</div>
                ) : metaTemplates.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-[#8696a0]">Nenhum template aprovado ainda. Crie em Templates → WhatsApp (Meta).</div>
                ) : metaTemplates.map((t) => {
                  const body = t.components.find((c) => c.type === 'BODY')?.text || '';
                  return (
                    <button
                      key={t.name}
                      onClick={() => handleSelectMetaTemplate(t)}
                      className="w-full text-left px-3 py-2 rounded-lg hover:bg-[#2a3942] transition-colors flex items-start gap-2"
                    >
                      <BadgeCheck size={14} className="text-emerald-400 flex-shrink-0 mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <span className="text-sm font-medium text-[#e9edef] truncate block">{t.name}</span>
                        <p className="text-xs text-[#8696a0] truncate">{body.replace(/\n/g, ' ')}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* AI assistant toolbar */}
      {showAI && (
        <div className="relative z-10 flex items-center gap-2 px-3 py-2 bg-[#202c33] border-t border-[#222e35] flex-wrap">
          <Sparkles size={13} className="text-[#00a884] flex-shrink-0" />
          <span className="text-xs text-[#8696a0] font-medium mr-1">IA:</span>
          {AI_BUTTONS.map(({ mode, label, emoji }) => (
            <button
              key={mode}
              type="button"
              onClick={() => handleAI(mode)}
              disabled={!!aiLoading}
              className={cn(
                'flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-all border',
                aiLoading === mode
                  ? 'bg-[#00a884] text-[#111b21] border-[#00a884]'
                  : 'bg-[#2a3942] text-[#8696a0] border-[#33434c] hover:bg-[#33434c] hover:text-[#e9edef]',
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
        className="relative z-10 flex items-end gap-2 px-3 py-3 bg-[#202c33]"
      >
        <button
          type="button"
          className="flex-shrink-0 p-2 text-[#8696a0] hover:text-[#e9edef]"
        >
          <Smile size={22} />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={handleFileChange}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadingFile}
          title="Anexar documento ou imagem"
          className="flex-shrink-0 p-2 text-[#8696a0] hover:text-[#e9edef] disabled:opacity-50"
        >
          {uploadingFile ? <Loader2 size={22} className="animate-spin" /> : <Paperclip size={22} />}
        </button>
        <textarea
          ref={inputRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Digite uma mensagem"
          rows={1}
          spellCheck
          lang="pt-BR"
          className="flex-1 resize-none px-4 py-2.5 text-sm bg-[#2a3942] rounded-3xl border-none outline-none text-[#e9edef] placeholder-[#8696a0] scrollbar-thin max-h-32"
          style={{ lineHeight: '1.4' }}
        />
        {/* Templates toggle button */}
        <button
          type="button"
          onClick={handleOpenTemplates}
          title="Templates prontos"
          className={cn(
            'flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center transition-all',
            showTemplates ? 'bg-[#00a884] text-[#111b21]' : 'bg-[#2a3942] text-[#8696a0] hover:bg-[#33434c] hover:text-[#e9edef]'
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
            showAI ? 'bg-[#00a884] text-[#111b21]' : 'bg-[#2a3942] text-[#8696a0] hover:bg-[#33434c] hover:text-[#e9edef]'
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
          style={{ backgroundColor: '#00a884' }}
        >
          <Send size={18} />
        </button>
      </form>

      {/* Encaminhar mensagem — escolher a conversa de destino */}
      {forwardingMessage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setForwardingMessage(null)}>
          <div
            className="w-full max-w-sm max-h-[70vh] flex flex-col rounded-2xl overflow-hidden shadow-xl"
            style={{ backgroundColor: '#202c33' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-3 border-b border-[#222e35]">
              <p className="text-sm font-semibold text-[#e9edef] flex items-center gap-1.5">
                <Forward size={14} /> Encaminhar para...
              </p>
              <p className="text-xs text-[#8696a0] truncate mt-0.5">
                {forwardingMessage.attachments?.length ? `📎 ${forwardingMessage.attachments[0].fileName}` : forwardingMessage.content}
              </p>
            </div>
            <div className="px-3 pt-3">
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8696a0] pointer-events-none" />
                <input
                  autoFocus
                  value={forwardSearch}
                  onChange={(e) => setForwardSearch(e.target.value)}
                  placeholder="Buscar por nome ou telefone"
                  className="w-full pl-8 pr-8 py-2 text-sm rounded-lg bg-[#2a3942] text-[#e9edef] placeholder-[#8696a0] border border-transparent focus:outline-none focus:border-[#00a884]/40"
                />
                {forwardSearch && (
                  <button onClick={() => setForwardSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8696a0] hover:text-[#e9edef]">
                    <X size={14} />
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin p-2">
              {forwardLeads === null ? (
                <p className="px-2 py-3 text-xs text-[#8696a0]">Carregando conversas...</p>
              ) : forwardMatches.length === 0 ? (
                <p className="px-2 py-3 text-xs text-[#8696a0]">Nenhuma conversa encontrada</p>
              ) : forwardMatches.map((l) => (
                <button
                  key={l.id}
                  onClick={() => handleConfirmForward(l.id)}
                  disabled={forwardBusy}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-[#2a3942] transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  <Avatar name={l.contact?.name || l.name} size="sm" />
                  <span className="text-sm text-[#e9edef] truncate">{l.contact?.name || l.name}</span>
                </button>
              ))}
            </div>
            <div className="px-4 py-2.5 border-t border-[#222e35] flex justify-end">
              <button onClick={() => setForwardingMessage(null)} className="text-xs text-[#8696a0] hover:text-[#e9edef]">Cancelar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
