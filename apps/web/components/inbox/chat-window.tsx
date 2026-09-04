'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Message, Channel, Note } from '@/types';
import { cn, formatDateTime } from '@/lib/utils';
import { Send, Paperclip, Check, CheckCheck, Sparkles, Loader2, FileText, Clock, BadgeCheck, Forward, Reply, Search, X, AlertCircle, User, MessageCircle, UserPlus, Star, Pin, Link2, ChevronLeft, Info, ChevronDown, Lightbulb } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { getSocket } from '@/lib/socket';
import { Avatar } from '@/components/ui/avatar';
import { AttachmentView } from '@/components/inbox/message-attachment';
import { MessageTemplate, CATEGORY_META, fillTemplate } from '@/lib/templates';
import { MessageMenu } from '@/components/inbox/message-menu';
import { EmojiPickerButton } from '@/components/inbox/emoji-picker';

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
  /** true = a IA responde esse cliente SOZINHA no WhatsApp, sem revisão humana. */
  aiAutoReplyActive?: boolean;
  onNewMessage: (msg: Message) => void;
  /** Fecha a conversa (ESC), como no WhatsApp. No mobile também é o botão de voltar pra lista. */
  onClose?: () => void;
  /** Abre o painel de dados do lead/grupo como overlay — só existe no mobile
   *  (no desktop o painel já fica sempre visível ao lado, sem precisar abrir). */
  onOpenInfo?: () => void;
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

/** Trecho curto pra mostrar como citação (barra de resposta / bolha citada) —
 *  mesma lógica que já separa "legenda" de anexo, com fallback pra anexo/contato. */
function messagePreviewText(msg: Message): string {
  if (msg.sharedContactName || msg.sharedContactPhone) return `👤 ${msg.sharedContactName || msg.sharedContactPhone}`;
  if (msg.attachments && msg.attachments.length > 0) {
    const caption = msg.content.includes(' — ') ? msg.content.split(' — ').slice(1).join(' — ') : '';
    return caption || `📎 ${msg.attachments[0].fileName}`;
  }
  return msg.content;
}

/** Nome de quem mandou, pra mostrar na citação (igual ao rótulo "via ... · quem enviou"). */
function messageSenderName(msg: Message, leadName: string): string {
  if (msg.direction === 'OUTBOUND') return (msg as any).sentBy?.name || 'Você';
  return (msg as any).senderName || leadName;
}

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

/** Canal "natural" da conversa: por onde o CLIENTE fala com a gente — olhando
 *  a ÚLTIMA mensagem RECEBIDA (não as que já enviamos, que podem estar
 *  "erradas" se algum envio anterior caiu no canal errado). Evita que a caixa
 *  de mensagem sugira o QR por padrão para um lead que só fala pela API
 *  Oficial (ex: veio de um anúncio Clique-para-WhatsApp). */
function lastInboundChannel(messages: Message[]): { via: WhatsAppVia; numberId?: string } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.direction !== 'INBOUND') continue;
    if (m.externalId?.startsWith('wamid')) return { via: 'api' };
    if (m.whatsappNumberId) return { via: 'qr', numberId: m.whatsappNumberId };
  }
  return null;
}

export function ChatWindow({ leadId, leadName, messages, notes = [], aiAutoReplyActive, onNewMessage, onClose, onOpenInfo }: ChatWindowProps) {
  const router = useRouter();
  const [content, setContent] = useState('');
  const [channel, setChannel] = useState<Channel>('WHATSAPP');
  const [via, setVia] = useState<WhatsAppVia | null>(null);
  // Número de WhatsApp (QR) escolhido para enviar; null = automático (o número
  // que a conversa já usa ou o primeiro conectado). Escolher outro NÃO duplica a
  // conversa — é o mesmo lead, só muda por qual número a mensagem sai.
  const [fromNumberId, setFromNumberId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Contato compartilhado no WhatsApp (cartão/vCard) — "Conversar" abre a
  // conversa desse número (cria o lead se ainda não existir); "Criar lead"
  // faz o mesmo mas sem sair da conversa atual.
  const [resolvingContact, setResolvingContact] = useState<string | null>(null); // id da mensagem em resolução
  async function handleContactCardAction(msg: Message, action: 'talk' | 'create') {
    if (!msg.sharedContactPhone || resolvingContact) return;
    setResolvingContact(msg.id);
    try {
      const { data } = await api.post('/api/messages/contact-card/resolve', {
        name: msg.sharedContactName,
        phone: msg.sharedContactPhone,
      });
      if (action === 'talk') {
        router.push(`/inbox?leadId=${data.leadId}`);
      } else {
        toast(data.created ? 'Lead criado!' : 'Esse contato já é um lead — nada foi duplicado.', 'success');
      }
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao processar o contato', 'error');
    } finally {
      setResolvingContact(null);
    }
  }

  // IA respondendo esse cliente sozinha (sem revisão humana) — liga/desliga
  // por conversa. Espelha o prop, mas otimista pro botão reagir na hora.
  const [aiActive, setAiActive] = useState(!!aiAutoReplyActive);
  const [togglingAi, setTogglingAi] = useState(false);
  useEffect(() => { setAiActive(!!aiAutoReplyActive); }, [leadId, aiAutoReplyActive]);

  // Link direto pra essa conversa (?leadId=... já é lido pela própria tela
  // da Inbox — apps/web/app/(dashboard)/inbox/page.tsx — e abre direto
  // nela). Quem receber o link precisa estar logado no CRM.
  function handleCopyLink() {
    const url = `${window.location.origin}/inbox?leadId=${leadId}`;
    navigator.clipboard.writeText(url)
      .then(() => toast('Link copiado! Quem abrir (logado no CRM) cai direto nessa conversa.'))
      .catch(() => toast('Não consegui copiar o link', 'error'));
  }

  async function handleToggleAi() {
    const next = !aiActive;
    setTogglingAi(true);
    setAiActive(next); // otimista
    try {
      await api.patch(`/api/leads/${leadId}/ai-auto-reply`, { active: next });
      toast(next ? 'IA ativada — vai responder esse cliente sozinha a partir de agora.' : 'IA desativada nesta conversa.');
    } catch {
      setAiActive(!next); // desfaz
      toast('Erro ao mudar o assistente de IA', 'error');
    } finally {
      setTogglingAi(false);
    }
  }

  // Sugestão de resposta sob demanda (balão) — diferente do "Ativar IA" acima
  // (que responde o cliente sozinha): aqui é só sugestão, nunca envia nada
  // sozinha. "Usar" só coloca o texto no campo de digitar.
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  // silent=true (disparo automático) não mostra toast de erro — uma falha
  // em segundo plano não deve incomodar quem nem pediu; o botão manual
  // continua ali pra tentar de novo quando quiser.
  async function handleSuggestReply(silent = false) {
    setSuggesting(true);
    setSuggestion(null);
    try {
      const { data } = await api.post('/api/ai/suggest-reply', { leadId });
      setSuggestion(data.suggestion);
    } catch (err: any) {
      if (!silent) toast(err?.response?.data?.error || 'Erro ao gerar sugestão', 'error');
    } finally {
      setSuggesting(false);
    }
  }
  function useSuggestion() {
    if (!suggestion) return;
    setContent(suggestion);
    setSuggestion(null);
    inputRef.current?.focus();
  }

  // Sugestão AUTOMÁTICA — dispara sozinha a cada mensagem NOVA do cliente
  // (nunca depois de uma mensagem minha), enquanto essa conversa está aberta.
  // Não dispara na 1ª carga de uma conversa (senão sugeriria pra toda
  // conversa que você abre, mesmo já resolvida há dias) — só quando a lista
  // CRESCE com o chat já aberto. Agrupa rajada de mensagens rápidas do
  // cliente numa sugestão só (debounce), em vez de uma chamada por mensagem.
  const autoSuggestLeadIdRef = useRef<string | null>(null);
  const autoSuggestCountRef = useRef(0);
  const autoSuggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const isNewConversation = autoSuggestLeadIdRef.current !== leadId;
    const grew = messages.length > autoSuggestCountRef.current;
    autoSuggestCountRef.current = messages.length;
    const lastMsg = messages[messages.length - 1];

    // Mesma corrida do efeito de rolagem: o 1º render de uma conversa nova
    // chega com messages=[] (a query ainda não resolveu) — só marca como
    // "vista" depois de ter mensagem de verdade.
    if (messages.length > 0) autoSuggestLeadIdRef.current = leadId;

    if (isNewConversation || !grew || lastMsg?.direction !== 'INBOUND') return;

    if (autoSuggestTimerRef.current) clearTimeout(autoSuggestTimerRef.current);
    autoSuggestTimerRef.current = setTimeout(() => { handleSuggestReply(true); }, 800);
    return () => { if (autoSuggestTimerRef.current) clearTimeout(autoSuggestTimerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, leadId]);

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
  // Canal por onde o cliente já fala com a gente nessa conversa (se houver).
  const inboundChannel = lastInboundChannel(messages);
  // Canal efetivo: escolha manual, senão o canal natural da conversa, senão
  // QR se conectado, senão API.
  const effectiveVia: WhatsAppVia = via ?? inboundChannel?.via ?? (qrConnected ? 'qr' : 'api');

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
  // Número ativo para enviar: escolha do usuário, senão o número por onde o
  // cliente já falou (se ainda conectado), senão o da conversa, senão o 1º conectado.
  const activeNumberId =
    fromNumberId ??
    (inboundChannel?.via === 'qr' && inboundChannel.numberId && connectedQr.some(n => n.id === inboundChannel.numberId) ? inboundChannel.numberId : null) ??
    (lastRouted && connectedQr.some(n => n.id === lastRouted) ? lastRouted : connectedQr[0]?.id) ??
    null;

  // Ao trocar de conversa, volta o seletor para "automático".
  useEffect(() => { setFromNumberId(null); }, [leadId]);
  // Some com a sugestão ao trocar de conversa — sem isso, uma sugestão gerada
  // pra um cliente ficava visível (e clicável em "Usar") ao abrir outro.
  useEffect(() => { setSuggestion(null); }, [leadId]);
  const [aiLoading, setAiLoading] = useState<AIMode | null>(null);
  const [showAI, setShowAI] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [templatesLoadedOnce, setTemplatesLoadedOnce] = useState(false);
  const [metaTemplates, setMetaTemplates] = useState<MetaTemplate[] | null>(null);
  const [pendingMetaTemplate, setPendingMetaTemplate] = useState<MetaTemplate | null>(null);
  const [metaTemplateVars, setMetaTemplateVars] = useState<Record<number, string>>({});
  const [sendingTemplate, setSendingTemplate] = useState(false);
  // Busca dentro do painel de templates — filtra tanto as respostas rápidas
  // quanto os templates Meta pelo nome ou corpo do texto.
  const [templateSearch, setTemplateSearch] = useState('');

  // ── Recuperação do erro "contato só tem @lid, sem telefone de verdade" ──
  // Em vez de um toast sem saída (o colaborador tinha que ir caçar sozinho
  // onde cadastrar o telefone), oferece o campo na hora e reenvia sozinho
  // assim que salvar. 'text' = retentar handleSend, 'template' = retentar
  // handleSendMetaTemplate (o pendingMetaTemplate continua intacto no erro).
  const [phoneFixKind, setPhoneFixKind] = useState<'text' | 'template' | null>(null);
  const [phoneFixValue, setPhoneFixValue] = useState('');
  const [savingPhoneFix, setSavingPhoneFix] = useState(false);

  async function handleSavePhoneFix() {
    if (!phoneFixValue.trim() || savingPhoneFix) return;
    setSavingPhoneFix(true);
    try {
      const { data } = await api.patch(`/api/leads/${leadId}/phone`, { phone: phoneFixValue });
      const kind = phoneFixKind;
      setPhoneFixKind(null);
      setPhoneFixValue('');
      // hasWhatsApp: true/false = checado de verdade (precisa de um QR
      // conectado); null = indeterminado, não é erro — só não dá pra saber agora.
      if (data?.hasWhatsApp === false) {
        toast('Telefone salvo — mas esse número não parece ter WhatsApp. Confira antes de reenviar.', 'error');
      } else if (data?.hasWhatsApp === true) {
        toast('Telefone salvo (tem WhatsApp) — reenviando...');
      } else {
        toast('Telefone salvo — reenviando...');
      }
      if (kind === 'text') handleSend();
      else if (kind === 'template') handleSendMetaTemplate();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao salvar o telefone', 'error');
    } finally {
      setSavingPhoneFix(false);
    }
  }

  // ── Encaminhar mensagem para outra conversa ──────────────────────────────
  const [forwardingMessage, setForwardingMessage] = useState<Message | null>(null);
  const [forwardLeads, setForwardLeads] = useState<{ id: string; name: string; contact?: { name?: string; phone?: string; whatsappPhone?: string } }[] | null>(null);
  const [forwardSearch, setForwardSearch] = useState('');
  const [forwardBusy, setForwardBusy] = useState(false);
  // Igual ao WhatsApp: marca quantas conversas quiser (checkbox) e só manda
  // quando confirmar — em vez de encaminhar na hora ao clicar numa só.
  const [forwardSelected, setForwardSelected] = useState<Set<string>>(new Set());

  function openForward(msg: Message) {
    setForwardingMessage(msg);
    setForwardSearch('');
    setForwardSelected(new Set());
    if (forwardLeads === null) {
      api.get('/api/leads').then(({ data }) => setForwardLeads(data)).catch(() => setForwardLeads([]));
    }
  }

  function toggleForwardSelect(leadId: string) {
    setForwardSelected((prev) => {
      const next = new Set(prev);
      if (next.has(leadId)) next.delete(leadId);
      else next.add(leadId);
      return next;
    });
  }

  async function handleConfirmForward() {
    if (!forwardingMessage || forwardSelected.size === 0) return;
    setForwardBusy(true);
    try {
      const targets = Array.from(forwardSelected);
      const results = await Promise.allSettled(
        targets.map((toLeadId) => api.post(`/api/messages/${forwardingMessage.id}/forward`, { toLeadId }))
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      const failed = results.length - ok;
      if (ok > 0) toast(ok === 1 ? 'Mensagem encaminhada!' : `Mensagem encaminhada para ${ok} conversas!`);
      if (failed > 0) toast(`Não consegui encaminhar pra ${failed} conversa${failed > 1 ? 's' : ''}.`, 'error');
      if (failed === 0) setForwardingMessage(null);
    } finally {
      setForwardBusy(false);
    }
  }

  // ── Responder com citação a uma mensagem específica (como no WhatsApp) ───
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  function openReply(msg: Message) {
    setReplyingTo(msg);
    inputRef.current?.focus();
  }
  /** Clica na citação dentro de uma bolha → pula pra mensagem original, se
   *  ela ainda estiver carregada nesta conversa (destaque rápido). */
  function scrollToQuoted(externalId?: string | null) {
    if (!externalId) return;
    const original = messages.find((m) => m.externalId === externalId);
    if (!original) return;
    const el = document.getElementById(`msg-${original.id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-[#00a884]');
    setTimeout(() => el.classList.remove('ring-2', 'ring-[#00a884]'), 1200);
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

  const templateQuery = templateSearch.trim().toLowerCase();
  const filteredTemplates = !templateQuery
    ? templates
    : templates.filter((t) => t.name.toLowerCase().includes(templateQuery) || t.body.toLowerCase().includes(templateQuery));
  const filteredMetaTemplates = !templateQuery
    ? metaTemplates
    : (metaTemplates || []).filter((t) => {
        const body = t.components.find((c) => c.type === 'BODY')?.text || '';
        return t.name.toLowerCase().includes(templateQuery) || body.toLowerCase().includes(templateQuery);
      });

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
  const [statusErrorMap, setStatusErrorMap] = useState<Record<string, string | null>>({});
  // Menu de mensagem estilo WhatsApp — mesmo padrão de mapa por id que o
  // status já usa, atualizado tanto pela própria ação (resposta da API)
  // quanto por eventos de socket (outra aba, ou o cliente reagindo/apagando
  // do lado dele).
  const [deletedMap, setDeletedMap] = useState<Record<string, boolean>>({});
  const [reactionsMap, setReactionsMap] = useState<Record<string, { emoji: string; fromMe: boolean; at: string }[]>>({});
  const [pinnedMap, setPinnedMap] = useState<Record<string, boolean>>({});
  const [starredMap, setStarredMap] = useState<Record<string, boolean>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingFile, setUploadingFile] = useState(false);

  // Ao ABRIR uma conversa, pula direto pro final sem animação — com
  // 'smooth' sempre, uma conversa longa começava lá no topo e ia "descendo"
  // visivelmente até a última mensagem, o que parecia lento e chamava
  // atenção à toa. Só uma mensagem NOVA chegando (mesma conversa já aberta)
  // deve rolar suave; trocar de conversa é um salto instantâneo.
  //
  // Só força a rolagem se o usuário já estava perto do final (ou é conversa
  // nova/mensagem que EU acabei de mandar) — igual o WhatsApp de verdade,
  // que não te puxa pra baixo se você rolou pra cima pra ler o histórico.
  // Reforça a correção de cima (memoizar `messages` no Inbox): mesmo que
  // outro re-render passe uma referência nova por engano, não vai mais
  // arrancar a rolagem de quem está lendo mensagens antigas.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const lastLeadIdRef = useRef<string | null>(null);
  const lastMessageCountRef = useRef(0);
  // Botão "ir pro final" — reforço pro auto-scroll de cima: aparece sempre
  // que o usuário não está perto do fim (rolou pra ler histórico, ou o
  // auto-scroll não pegou por algum motivo, ex.: imagem grande ainda
  // carregando e empurrando a altura da página depois do salto inicial).
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  function handleScroll() {
    const container = scrollContainerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    setShowJumpToBottom(scrollHeight - (scrollTop + clientHeight) > 150);
  }
  function jumpToBottom() {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }
  useEffect(() => {
    const isNewConversation = lastLeadIdRef.current !== leadId;

    const container = scrollContainerRef.current;
    const grew = messages.length > lastMessageCountRef.current;
    lastMessageCountRef.current = messages.length;
    const lastMsg = messages[messages.length - 1];
    const justSentByMe = grew && lastMsg?.direction === 'OUTBOUND';

    let nearBottom = true;
    if (container && !isNewConversation) {
      const { scrollTop, scrollHeight, clientHeight } = container;
      nearBottom = scrollHeight - (scrollTop + clientHeight) < 150;
    }

    if (isNewConversation || justSentByMe || nearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: isNewConversation ? 'auto' : 'smooth' });
      setShowJumpToBottom(false);
    }

    // Só marca a conversa como "já vista" depois de ter mensagem de
    // verdade pra rolar — o 1º render de uma conversa nova chega com
    // messages=[] (a query ainda não resolveu); sem essa condição, o ref já
    // ficava marcado nesse 1º render vazio, e quando as mensagens reais
    // chegavam um instante depois (2º render, mesmo leadId) o código não
    // tratava mais como "nova" — passava a checar a posição de rolagem real,
    // que é o topo (conteúdo acabou de renderizar) — e não descia. Era o
    // motivo de abrir uma conversa sempre lá em cima em vez da última msg.
    if (messages.length > 0) lastLeadIdRef.current = leadId;
  }, [messages, leadId]);

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

    // Atualiza tick em tempo real quando a Meta confirma entrega/leitura/falha
    socket.on('message_status', ({ id, status, statusError }: { id: string; status: string; statusError?: string | null }) => {
      setStatusMap(prev => ({ ...prev, [id]: status }));
      if (statusError !== undefined) setStatusErrorMap(prev => ({ ...prev, [id]: statusError }));
    });

    // A própria IA se desliga quando o cliente pede atendente (handoff) — ou
    // alguém liga/desliga em outra aba. Mantém o botão sincronizado sem poll.
    socket.on('lead_ai_toggled', ({ leadId: id, active }: { leadId: string; active: boolean }) => {
      if (id === leadId) setAiActive(active);
    });

    // Menu de mensagem estilo WhatsApp — apagar/reagir/fixar/favoritar,
    // vindo da própria ação (outra aba) ou do cliente (reação/apagar dele).
    socket.on('message_deleted', ({ id }: { id: string }) => {
      setDeletedMap(prev => ({ ...prev, [id]: true }));
    });
    socket.on('message_reaction', ({ id, reactions }: { id: string; reactions: { emoji: string; fromMe: boolean; at: string }[] }) => {
      setReactionsMap(prev => ({ ...prev, [id]: reactions }));
    });
    socket.on('message_pinned', ({ id, pinned }: { id: string; pinned: boolean }) => {
      setPinnedMap(prev => ({ ...prev, [id]: pinned }));
    });
    socket.on('message_starred', ({ id, starred }: { id: string; starred: boolean }) => {
      setStarredMap(prev => ({ ...prev, [id]: starred }));
    });

    return () => {
      socket.emit('leave_lead', leadId);
      socket.off('new_message');
      socket.off('message_status');
      socket.off('lead_ai_toggled');
      socket.off('message_deleted');
      socket.off('message_reaction');
      socket.off('message_pinned');
      socket.off('message_starred');
    };
  }, [leadId, onNewMessage]);

  // Fora da janela de 24h, a API Oficial rejeita texto livre — só um template
  // aprovado reabre a conversa. Trava ANTES de tentar (a Meta ia recusar de
  // qualquer jeito) e já manda direto pro seletor de template, em vez de só
  // deixar a mensagem falhar silenciosamente lá na frente.
  const windowClosedForApi = channel === 'WHATSAPP' && effectiveVia === 'api' && windowOpen === false;

  async function handleSend(e?: React.FormEvent) {
    e?.preventDefault();
    const text = content.trim();
    if (!text || sending) return;   // trava contra envio duplo
    if (windowClosedForApi) {
      toast('Janela de 24h fechada — use um template aprovado para reabrir a conversa.', 'error');
      setShowTemplates(true);
      return;
    }
    const quotedMsg = replyingTo;     // guarda pra restaurar se o envio falhar
    setSending(true);
    setContent('');                 // feedback imediato: o campo esvazia na hora
    setReplyingTo(null);
    try {
      const { data } = await api.post('/api/messages', {
        content: text,
        direction: 'OUTBOUND',
        channel,
        leadId,
        ...(channel === 'WHATSAPP'
          ? { via: effectiveVia, ...(effectiveVia === 'qr' && activeNumberId ? { fromNumberId: activeNumberId } : {}) }
          : {}),
        ...(quotedMsg
          ? {
              replyToExternalId: quotedMsg.externalId || undefined,
              replyToFromMe: quotedMsg.direction === 'OUTBOUND',
              replyToContent: messagePreviewText(quotedMsg),
              replyToSender: messageSenderName(quotedMsg, leadName),
            }
          : {}),
      });
      onNewMessage(data);
    } catch (err: any) {
      setContent(text);             // falhou: devolve o texto para tentar de novo
      setReplyingTo(quotedMsg);      // e a citação também
      const msg = err?.response?.data?.error || err?.message || 'Erro ao enviar mensagem';
      if (err?.response?.data?.code === 'NO_REAL_PHONE') setPhoneFixKind('text');
      toast(msg, 'error');
    } finally {
      setSending(false);
    }
  }

  /** Envia 1 arquivo — usado pelo seletor (📎), por arrastar-e-soltar e por
   *  colar (Ctrl+V) na caixa de mensagem. */
  async function uploadFile(file: File) {
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
        ...(channel === 'WHATSAPP'
          ? { via: effectiveVia, ...(effectiveVia === 'qr' && activeNumberId ? { fromNumberId: activeNumberId } : {}) }
          : {}),
      });
      onNewMessage(data);
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao enviar o arquivo', 'error');
    } finally {
      setUploadingFile(false);
    }
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // permite reenviar o mesmo arquivo
    if (!file) return;
    await uploadFile(file);
  }

  // Arrastar-e-soltar: sem preventDefault no dragOver o navegador nunca chama
  // onDrop (segue a regra padrão dele, que é ABRIR o arquivo numa aba nova —
  // era exatamente o bug reportado). Conta quantos "drag enter" estão ativos
  // porque o evento dispara pra CADA elemento filho sobrevoado — sem o
  // contador, sair de um filho pra outro (dragLeave + dragEnter) pisca a
  // sobreposição.
  const [dragDepth, setDragDepth] = useState(0);
  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) setDragDepth((d) => d + 1);
  }
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault(); // sem isso o onDrop nunca dispara
  }
  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    setDragDepth((d) => Math.max(0, d - 1));
  }
  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragDepth(0);
    const files = Array.from(e.dataTransfer.files || []);
    for (const file of files) await uploadFile(file); // um de cada vez — mesma ordem em que soltou
  }

  // Insere o emoji na posição do cursor (não só no final) e mantém o foco
  // na caixa de texto, pra continuar digitando/escolhendo mais emoji.
  function handleEmojiSelect(emoji: string) {
    const el = inputRef.current;
    if (!el) { setContent((c) => c + emoji); return; }
    const start = el.selectionStart ?? content.length;
    const end = el.selectionEnd ?? content.length;
    setContent(content.slice(0, start) + emoji + content.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  }

  function handleOpenTemplates() {
    setShowTemplates(v => !v);
    setShowAI(false);
    setPendingMetaTemplate(null);
    setTemplateSearch('');
    // Busca do banco (compartilhado pela equipe) — não do localStorage, que
    // ficava desatualizado (não refletia exclusão/criação feita por ninguém,
    // e às vezes até "ressuscitava" um template já excluído).
    if (!templatesLoadedOnce) {
      setTemplatesLoadedOnce(true);
      api.get('/api/message-templates')
        .then(({ data }) => setTemplates(data || []))
        .catch(() => setTemplates([]));
    }
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
      if (err?.response?.data?.code === 'NO_REAL_PHONE') setPhoneFixKind('template');
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

  function StatusTick({ status, error }: { status?: string; error?: string | null }) {
    if (status === 'FAILED') {
      return (
        <span title={error ? `Falhou: ${error}` : 'Falhou ao enviar — a mensagem não chegou ao destinatário'}>
          <AlertCircle size={14} className="text-red-400" />
        </span>
      );
    }
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
    <div
      className="relative flex flex-col flex-1 h-full"
      style={{ background: '#0b141a' }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* WhatsApp-style background pattern */}
      <div
        className="absolute inset-0 pointer-events-none opacity-[0.06]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23000000' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
        }}
      />

      {/* Sobreposição enquanto arrasta um arquivo por cima — some ao soltar
          (ou ao sair da área) via handleDragLeave/handleDrop. */}
      {dragDepth > 0 && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#00a884]/20 border-4 border-dashed border-[#00a884] backdrop-blur-[1px] pointer-events-none">
          <div className="bg-[#202c33] text-[#e9edef] px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3">
            <Paperclip size={24} className="text-[#00a884]" />
            <span className="text-sm font-medium">Solte para enviar</span>
          </div>
        </div>
      )}

      {/* Header — WhatsApp dark */}
      <div className="relative z-10 flex items-center gap-3 px-4 py-3 text-[#e9edef] shadow-md" style={{ backgroundColor: '#202c33' }}>
        {/* Voltar pra lista de conversas — só existe no mobile (desktop mostra
            a lista sempre ao lado, não precisa de botão pra voltar). */}
        <button
          onClick={() => onClose?.()}
          title="Voltar pra lista de conversas"
          className="md:hidden flex-shrink-0 -ml-1 text-[#8696a0] hover:text-[#e9edef] transition-colors"
        >
          <ChevronLeft size={22} />
        </button>
        <Avatar name={leadName} size="md" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">{leadName}</p>
          <p className="text-xs opacity-80">
            {CHANNEL_ICONS[channel]} {CHANNEL_LABELS[channel]}
          </p>
        </div>
        {/* Dados do lead/grupo — no mobile o painel não fica ao lado (não
            cabe), abre como overlay ao tocar aqui. */}
        {onOpenInfo && (
          <button
            onClick={onOpenInfo}
            title="Ver dados do cliente"
            className="md:hidden flex-shrink-0 text-[#8696a0] hover:text-[#e9edef] p-1.5 rounded-lg hover:bg-white/10 transition-colors"
          >
            <Info size={18} />
          </button>
        )}
        <button
          onClick={handleCopyLink}
          title="Copiar link direto pra essa conversa — quem abrir (logado no CRM) cai direto aqui"
          className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors flex-shrink-0 bg-white/10 text-[#8696a0] hover:text-[#e9edef] hover:bg-white/15"
        >
          <Link2 size={13} />
          Copiar link
        </button>
        <button
          onClick={() => handleSuggestReply()}
          disabled={suggesting}
          title="Sugerir uma resposta pra você usar — nunca envia sozinha"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 flex-shrink-0 bg-white/10 text-[#8696a0] hover:text-[#e9edef] hover:bg-white/15"
        >
          {suggesting ? <Loader2 size={13} className="animate-spin" /> : <Lightbulb size={13} />}
          <span className="hidden md:inline">Sugerir resposta</span>
        </button>
        <button
          onClick={handleToggleAi}
          disabled={togglingAi}
          title={aiActive ? 'IA está respondendo esse cliente sozinha — clique para desligar' : 'Ativar a IA para responder esse cliente sozinha'}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50 flex-shrink-0',
            aiActive ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30' : 'bg-white/10 text-[#8696a0] hover:text-[#e9edef] hover:bg-white/15'
          )}
        >
          <Sparkles size={13} />
          <span className="hidden md:inline">{aiActive ? 'IA ativa' : 'Ativar IA'}</span>
        </button>
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

      {/* Fixadas — faixa fixa no topo, fora do scroll das mensagens (igual o WhatsApp) */}
      {(() => {
        const pinnedMessages = messages
          .filter((m) => pinnedMap[m.id] ?? m.pinned)
          .sort((a, b) => new Date(a.pinnedAt || 0).getTime() - new Date(b.pinnedAt || 0).getTime());
        if (pinnedMessages.length === 0) return null;
        return (
          <div className="relative z-10 bg-[#182229] border-t border-b border-[#222e35] max-h-24 overflow-y-auto scrollbar-thin">
            {pinnedMessages.map((m) => (
              <button
                key={m.id}
                onClick={() => scrollToQuoted(m.externalId)}
                className="w-full flex items-center gap-2 px-4 py-1.5 text-left hover:bg-[#202c33] transition-colors"
              >
                <Pin size={11} className="text-[#00a884] flex-shrink-0" />
                <span className="text-xs text-[#e9edef]/80 truncate">{m.content || '📎 Anexo'}</span>
              </button>
            ))}
          </div>
        );
      })()}

      {/* Timeline unificado: mensagens + eventos de fluxo */}
      <div ref={scrollContainerRef} onScroll={handleScroll} className="relative z-10 flex-1 overflow-y-auto px-4 py-4 space-y-1 scrollbar-thin">
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
              const liveDeleted = deletedMap[msg.id] ?? msg.deleted;
              const liveReactions = reactionsMap[msg.id] ?? msg.reactions ?? [];
              const livePinned = pinnedMap[msg.id] ?? msg.pinned;
              const liveStarred = starredMap[msg.id] ?? msg.starred;
              const menuProps = {
                message: { ...msg, pinned: livePinned, starred: liveStarred },
                isOut,
                onReply: () => openReply(msg),
                onForward: () => openForward(msg),
                onDeleted: (id: string) => setDeletedMap(prev => ({ ...prev, [id]: true })),
                onReaction: (id: string, reactions: { emoji: string; fromMe: boolean; at: string }[]) => setReactionsMap(prev => ({ ...prev, [id]: reactions })),
                onPinned: (id: string, pinned: boolean) => setPinnedMap(prev => ({ ...prev, [id]: pinned })),
                onStarred: (id: string, starred: boolean) => setStarredMap(prev => ({ ...prev, [id]: starred })),
              };

              return (
                <div key={msg.id} className={cn('group flex items-center gap-1 mb-0.5', isOut ? 'justify-end' : 'justify-start')}>
                  {isOut && !liveDeleted && (
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <MessageMenu {...menuProps} />
                    </div>
                  )}
                  <div
                    id={`msg-${msg.id}`}
                    className={cn(
                      'relative max-w-xs lg:max-w-md px-3 py-2 shadow-sm transition-shadow',
                      isOut
                        ? 'rounded-tl-2xl rounded-tr-2xl rounded-bl-2xl text-[#e9edef]'
                        : 'rounded-tl-2xl rounded-tr-2xl rounded-br-2xl text-[#e9edef]',
                      showTail && isOut  ? 'rounded-br-sm' : '',
                      showTail && !isOut ? 'rounded-bl-sm' : '',
                    )}
                    style={{ backgroundColor: isOut ? '#005c4b' : '#202c33' }}
                  >
                    {liveDeleted ? (
                      <p className="text-sm italic text-[#e9edef]/50 pr-12">🚫 Mensagem apagada</p>
                    ) : (
                      <>
                        {msg.forwardedFromLeadName && (
                          <p className="text-[10px] italic text-[#e9edef]/55 mb-0.5 flex items-center gap-1">
                            <Forward size={10} /> Encaminhada de {msg.forwardedFromLeadName}
                          </p>
                        )}
                        {/* Citação: resposta a uma mensagem específica desta conversa */}
                        {msg.replyToContent && (
                          <button
                            type="button"
                            onClick={() => scrollToQuoted(msg.replyToExternalId)}
                            className="block w-full text-left mb-1 pl-2 py-1 border-l-2 border-[#00a884]/70 bg-black/15 rounded-r-md hover:bg-black/25 transition-colors"
                          >
                            <p className="text-[11px] font-medium text-[#00a884]">{msg.replyToSender || 'Mensagem'}</p>
                            <p className="text-xs text-[#e9edef]/70 truncate">{msg.replyToContent}</p>
                          </button>
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
                        {msg.attachments && msg.attachments.length > 0 && (() => {
                          // Vídeo usa o player NATIVO do navegador, que já tem seus
                          // próprios controles (volume, menu "⋮") colados na borda
                          // inferior direita — bem onde fica o carimbo de hora/check da
                          // mensagem. Sem esse respiro extra, um ficava em cima do
                          // outro e o usuário confundia o ícone de volume com outra
                          // coisa. Áudio agora usa um player próprio, mínimo (sem
                          // controle nativo nenhum), não precisa mais desse respiro.
                          const needsBreathingRoom = msg.attachments!.some(
                            (a) => a.mimeType.startsWith('video/')
                          );
                          return (
                            <div className={cn('flex flex-col gap-1.5 mb-1', needsBreathingRoom && 'mb-5')}>
                              {msg.attachments!.map((att) => (
                                <AttachmentView key={att.id} att={att} />
                              ))}
                            </div>
                          );
                        })()}
                        {/* Contato compartilhado no WhatsApp — card com ações rápidas */}
                        {(msg.sharedContactName || msg.sharedContactPhone) && (
                          <div className="min-w-[220px] mb-1">
                            <div className="flex items-center gap-2.5 bg-black/15 rounded-xl p-2.5">
                              <div className="w-9 h-9 rounded-full bg-[#2a3942] flex items-center justify-center flex-shrink-0">
                                <User size={16} className="text-[#8696a0]" />
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm font-medium text-[#e9edef] truncate">{msg.sharedContactName || 'Contato sem nome'}</p>
                                {msg.sharedContactPhone && <p className="text-xs text-[#8696a0]">{msg.sharedContactPhone}</p>}
                              </div>
                            </div>
                            {msg.sharedContactPhone && (
                              <div className="flex gap-1.5 mt-1.5">
                                <button
                                  type="button"
                                  onClick={() => handleContactCardAction(msg, 'talk')}
                                  disabled={resolvingContact === msg.id}
                                  className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium bg-[#00a884] text-[#111b21] px-2.5 py-1.5 rounded-lg hover:bg-[#02c99b] transition-colors disabled:opacity-50"
                                >
                                  {resolvingContact === msg.id ? <Loader2 size={12} className="animate-spin" /> : <MessageCircle size={12} />} Conversar
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleContactCardAction(msg, 'create')}
                                  disabled={resolvingContact === msg.id}
                                  className="flex-1 flex items-center justify-center gap-1.5 text-xs font-medium bg-[#2a3942] text-[#e9edef] px-2.5 py-1.5 rounded-lg hover:bg-[#33434c] transition-colors disabled:opacity-50"
                                >
                                  <UserPlus size={12} /> Criar lead
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                        {(() => {
                          // Com anexo/contato, o "📎/📇 nome" já é mostrado pelo card; exibe só a legenda.
                          const hasAtt = !!(msg.attachments && msg.attachments.length > 0);
                          const hasContactCard = !!(msg.sharedContactName || msg.sharedContactPhone);
                          if (hasContactCard) return null;
                          const text = hasAtt
                            ? (msg.content.includes(' — ') ? msg.content.split(' — ').slice(1).join(' — ') : '')
                            : msg.content;
                          if (!text) return null;
                          return <p className="text-sm leading-relaxed whitespace-pre-wrap pr-12">{text}</p>;
                        })()}
                      </>
                    )}
                    {liveReactions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {liveReactions.map((r, idx) => (
                          <span key={idx} className="text-xs bg-black/25 rounded-full px-1.5 py-0.5">{r.emoji}</span>
                        ))}
                      </div>
                    )}
                    <div className="absolute bottom-2 right-3 flex items-center gap-1">
                      {liveStarred && <Star size={10} className="text-[#ffc107] fill-current" />}
                      <span className="text-[10px] text-[#e9edef]/50">{time}</span>
                      {isOut && <StatusTick status={liveStatus} error={statusErrorMap[msg.id] ?? (msg as any).statusError} />}
                    </div>
                  </div>
                  {!isOut && !liveDeleted && (
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                      <MessageMenu {...menuProps} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Botão flutuante "ir pro final" — some quando já está perto do fim. */}
      {showJumpToBottom && (
        <button
          onClick={jumpToBottom}
          title="Ir para a última mensagem"
          className="absolute bottom-24 right-6 z-20 w-9 h-9 rounded-full bg-[#202c33] border border-[#2a3942] text-[#e9edef] shadow-lg flex items-center justify-center hover:bg-[#2a3942] transition-colors"
        >
          <ChevronDown size={18} />
        </button>
      )}

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
              {/* Busca — filtra respostas rápidas e templates Meta juntos,
                  pelo nome ou pelo texto do corpo. */}
              <div className="sticky top-0 z-10 p-2 bg-[#202c33] border-b border-[#222e35]">
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8696a0] pointer-events-none" />
                  <input
                    autoFocus
                    value={templateSearch}
                    onChange={(e) => setTemplateSearch(e.target.value)}
                    placeholder="Buscar template..."
                    className="w-full pl-7 pr-7 py-1.5 text-sm rounded-lg bg-[#2a3942] text-[#e9edef] placeholder-[#8696a0] border border-transparent focus:outline-none focus:border-[#00a884]/40"
                  />
                  {templateSearch && (
                    <button onClick={() => setTemplateSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8696a0] hover:text-[#e9edef]">
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>

              <div className="p-2 space-y-1">
                <p className="px-1 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#8696a0]">Respostas rápidas</p>
                {filteredTemplates.length === 0 ? (
                  <div className="px-2 py-2 text-xs text-[#8696a0]">
                    {templateQuery ? 'Nenhuma resposta rápida encontrada.' : 'Nenhuma cadastrada. Crie em Templates.'}
                  </div>
                ) : filteredTemplates.map((t) => {
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
                ) : (filteredMetaTemplates || []).length === 0 ? (
                  <div className="px-2 py-2 text-xs text-[#8696a0]">
                    {templateQuery ? 'Nenhum template Meta encontrado.' : 'Nenhum template aprovado ainda. Crie em Templates → WhatsApp (Meta).'}
                  </div>
                ) : (filteredMetaTemplates || []).map((t) => {
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
      {/* Balão de sugestão de resposta — só aparece por pedido (botão "Sugerir
          resposta" no cabeçalho). Nunca envia sozinho: "Usar" só põe o texto
          no campo de digitar, pra revisar antes de mandar. */}
      {suggestion && (
        <div className="relative z-10 flex items-start gap-2.5 px-3 py-2.5 bg-[#1f2c34] border-t border-amber-500/30">
          <Lightbulb size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-amber-400 font-semibold mb-0.5">Sugestão — revise antes de mandar</p>
            <p className="text-sm text-[#e9edef]">{suggestion}</p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={useSuggestion}
              className="px-2.5 py-1 rounded-lg text-xs font-medium bg-[#00a884] text-[#111b21] hover:bg-[#02c093] transition-colors"
            >
              Usar
            </button>
            <button
              onClick={() => setSuggestion(null)}
              title="Dispensar"
              className="p-1 rounded-lg text-[#8696a0] hover:text-[#e9edef] hover:bg-white/10 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

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

      {/* Aviso: envio falhou por falta de telefone real (contato só tem @lid) —
          cadastra na hora e reenvia sozinho, sem mandar caçar o campo certo. */}
      {phoneFixKind && (
        <div className="relative z-10 flex items-center gap-2 px-4 py-2 bg-amber-900/40 border-t border-amber-700/40">
          <AlertCircle size={14} className="flex-shrink-0 text-amber-300" />
          <span className="text-xs text-amber-300 flex-shrink-0">Sem telefone de verdade cadastrado — informe pra enviar:</span>
          <input
            type="tel"
            value={phoneFixValue}
            onChange={(e) => setPhoneFixValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleSavePhoneFix(); } }}
            placeholder="(61) 99999-9999"
            autoFocus
            className="min-w-0 flex-1 bg-[#2a3942] text-xs text-[#e9edef] placeholder-[#8696a0] rounded-lg px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-amber-500"
          />
          <button
            type="button"
            disabled={!phoneFixValue.trim() || savingPhoneFix}
            onClick={handleSavePhoneFix}
            className="flex-shrink-0 text-xs font-medium text-amber-200 bg-amber-700/40 hover:bg-amber-700/60 disabled:opacity-50 disabled:cursor-not-allowed px-2.5 py-1.5 rounded-lg transition-colors flex items-center gap-1"
          >
            {savingPhoneFix ? <Loader2 size={12} className="animate-spin" /> : null}
            Salvar e enviar
          </button>
          <button
            type="button"
            onClick={() => { setPhoneFixKind(null); setPhoneFixValue(''); }}
            title="Cancelar"
            className="flex-shrink-0 text-amber-300/70 hover:text-amber-200"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Aviso: janela de 24h fechada na API Oficial — só template reabre */}
      {windowClosedForApi && (
        <div className="relative z-10 flex items-center justify-between gap-3 px-4 py-2 bg-amber-900/40 border-t border-amber-700/40">
          <span className="text-xs text-amber-300">Janela de 24h fechada — a API Oficial só deixa reabrir com um template aprovado.</span>
          <button
            type="button"
            onClick={() => setShowTemplates(true)}
            className="flex-shrink-0 text-xs font-medium text-amber-200 bg-amber-700/40 hover:bg-amber-700/60 px-2.5 py-1 rounded-lg transition-colors"
          >
            Usar template
          </button>
        </div>
      )}

      {/* Faixa de "respondendo a..." — como no WhatsApp, some ao enviar/cancelar */}
      {replyingTo && (
        <div className="relative z-10 flex items-center justify-between gap-2 px-4 py-2 bg-[#202c33] border-t border-[#222e35]">
          <div className="flex items-center gap-2 min-w-0 pl-2 border-l-2 border-[#00a884]">
            <Reply size={14} className="flex-shrink-0 text-[#00a884]" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-[#00a884]">{messageSenderName(replyingTo, leadName)}</p>
              <p className="text-xs text-[#8696a0] truncate">{messagePreviewText(replyingTo)}</p>
            </div>
          </div>
          <button type="button" onClick={() => setReplyingTo(null)} title="Cancelar resposta" className="flex-shrink-0 text-[#8696a0] hover:text-[#e9edef]">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Input bar */}
      <form
        onSubmit={handleSend}
        className="relative z-10 flex items-end gap-2 px-3 py-3 bg-[#202c33]"
      >
        <EmojiPickerButton onSelect={handleEmojiSelect} />
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
          placeholder={windowClosedForApi ? 'Janela fechada — use um template acima' : 'Digite uma mensagem'}
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
              ) : forwardMatches.map((l) => {
                const selected = forwardSelected.has(l.id);
                return (
                  <button
                    key={l.id}
                    onClick={() => toggleForwardSelect(l.id)}
                    disabled={forwardBusy}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-[#2a3942] transition-colors flex items-center gap-2.5 disabled:opacity-50"
                  >
                    <Avatar name={l.contact?.name || l.name} size="sm" />
                    <span className="text-sm text-[#e9edef] truncate flex-1">{l.contact?.name || l.name}</span>
                    <span
                      className={cn(
                        'w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 transition-colors',
                        selected ? 'bg-[#00a884] border-[#00a884]' : 'border-[#8696a0]'
                      )}
                    >
                      {selected && <Check size={12} className="text-[#111b21]" />}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="px-4 py-2.5 border-t border-[#222e35] flex items-center justify-between">
              <button onClick={() => setForwardingMessage(null)} className="text-xs text-[#8696a0] hover:text-[#e9edef]">Cancelar</button>
              <button
                onClick={handleConfirmForward}
                disabled={forwardBusy || forwardSelected.size === 0}
                className="flex items-center gap-1.5 text-xs font-medium bg-[#00a884] text-[#111b21] px-3 py-1.5 rounded-lg hover:bg-[#02c99b] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {forwardBusy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                Encaminhar{forwardSelected.size > 0 ? ` (${forwardSelected.size})` : ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
