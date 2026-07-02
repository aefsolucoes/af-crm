'use client';
import { useState, useEffect, useRef } from 'react';
import { Topbar } from '@/components/ui/topbar';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { CheckCircle2, XCircle, Copy, ExternalLink, Info, QrCode, Wifi, WifiOff, RefreshCw, Megaphone, ChevronDown, ArrowRight, Trash2, Volume2, VolumeX, Palette, Upload } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Pipeline, Stage, User } from '@/types';
import { useThemeStore, BackgroundTheme } from '@/store/theme.store';

type Tab = 'api' | 'qr' | 'meta' | 'sons' | 'ia' | 'aparencia';

interface WAConfig {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  active: boolean;
  webhookUrl: string;
}

type QRStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

interface FieldMapping {
  metaField: string;
  crmField: string;
}

interface MetaConfig {
  verifyToken: string;
  pageAccessToken: string;
  defaultStageId: string | null;
  defaultUserId: string | null;
  active: boolean;
  fieldMappings: FieldMapping[];
  webhookUrl: string;
  isNew: boolean;
}

interface MetaForm {
  id: string;
  name: string;
  status: string;
  pageId: string;
  pageName: string;
}

interface MetaFormField {
  key: string;
  label: string;
  type: string;
}

// ─── Definições de sons ───────────────────────────────────────────────────────
type SoundKey = 'whatsapp' | 'ding' | 'pop' | 'chime' | 'bell' | 'soft' | 'alert' | 'none';

const SOUNDS: { key: SoundKey; label: string; emoji: string; desc: string }[] = [
  { key: 'whatsapp', label: 'WhatsApp',   emoji: '💬', desc: 'Três dings descendentes' },
  { key: 'ding',     label: 'Ding',       emoji: '🔔', desc: 'Um toque limpo e suave' },
  { key: 'pop',      label: 'Pop',        emoji: '🫧', desc: 'Som curto estilo bolha' },
  { key: 'chime',    label: 'Chime',      emoji: '🎵', desc: 'Dois tons harmônicos' },
  { key: 'bell',     label: 'Sino',       emoji: '🔕', desc: 'Sino metálico curto' },
  { key: 'soft',     label: 'Suave',      emoji: '🌙', desc: 'Tom suave e discreto' },
  { key: 'alert',    label: 'Alerta',     emoji: '⚡', desc: 'Toque de atenção' },
  { key: 'none',     label: 'Sem som',    emoji: '🔇', desc: 'Desativar notificação sonora' },
];

function playSound(key: SoundKey) {
  if (key === 'none') return;
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    const tone = (freq: number, start: number, dur: number, vol: number, type: OscillatorType = 'sine') => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      gain.gain.setValueAtTime(vol, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };

    if (key === 'whatsapp') {
      tone(1200, 0.00, 0.15, 0.4);
      tone(1000, 0.18, 0.15, 0.3);
      tone(800,  0.36, 0.20, 0.2);
    } else if (key === 'ding') {
      tone(880, 0, 0.5, 0.4);
    } else if (key === 'pop') {
      tone(600, 0.00, 0.04, 0.5, 'square');
      tone(400, 0.04, 0.08, 0.3, 'sine');
    } else if (key === 'chime') {
      tone(523, 0.00, 0.3, 0.35);   // Dó
      tone(659, 0.15, 0.3, 0.30);   // Mi
      tone(784, 0.30, 0.4, 0.25);   // Sol
    } else if (key === 'bell') {
      tone(987,  0.00, 0.05, 0.5, 'square');
      tone(1174, 0.00, 0.40, 0.3, 'sine');
      tone(987,  0.05, 0.35, 0.2, 'sine');
    } else if (key === 'soft') {
      tone(440, 0.0, 0.6, 0.2);
      tone(550, 0.1, 0.5, 0.15);
    } else if (key === 'alert') {
      tone(1000, 0.00, 0.10, 0.5, 'square');
      tone(1200, 0.12, 0.10, 0.5, 'square');
      tone(1000, 0.24, 0.10, 0.4, 'square');
    }

    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch { /* silencioso */ }
}

export default function ConfiguracoesPage() {
  const [tab, setTab] = useState<Tab>('qr');
  const [selectedSound, setSelectedSound] = useState<SoundKey>(
    () => (typeof window !== 'undefined' ? (localStorage.getItem('af_notification_sound') as SoundKey) || 'whatsapp' : 'whatsapp')
  );

  // Meta Lead Ads state
  const [metaConfig, setMetaConfig] = useState<MetaConfig>({
    verifyToken: 'af_meta_verify',
    pageAccessToken: '',
    defaultStageId: null,
    defaultUserId: null,
    active: false,
    fieldMappings: [],
    webhookUrl: '',
    isNew: true,
  });
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [savingMeta, setSavingMeta] = useState(false);

  // Meta forms state (estilo Pluga)
  const [metaForms, setMetaForms] = useState<MetaForm[]>([]);
  const [loadingForms, setLoadingForms] = useState(false);
  const [selectedFormId, setSelectedFormId] = useState('');
  const [metaFormFields, setMetaFormFields] = useState<MetaFormField[]>([]);
  const [loadingFields, setLoadingFields] = useState(false);

  // API config state
  const [config, setConfig] = useState<WAConfig>({
    phoneNumberId: '',
    accessToken: '',
    verifyToken: 'af_crm_verify',
    active: false,
    webhookUrl: '',
  });
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [saving, setSaving] = useState(false);
  const [isNew, setIsNew] = useState(true);

  // QR state
  const [qrStatus, setQrStatus] = useState<QRStatus>('disconnected');
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const socketRef = useRef<any>(null);

  // Load API config
  useEffect(() => {
    api.get('/api/settings/whatsapp').then(({ data }) => {
      if (data) { setConfig(data); setIsNew(false); }
    }).catch(() => {}).finally(() => setLoadingConfig(false));
  }, []);

  // Load Meta Leads config
  useEffect(() => {
    api.get('/api/settings/meta-leads').then(({ data }) => {
      if (data) setMetaConfig(data);
    }).catch(() => {}).finally(() => setLoadingMeta(false));
  }, []);

  // Pipeline stages and users for Meta Leads selectors
  const { data: pipelines } = useQuery<Pipeline[]>({
    queryKey: ['pipelines-settings'],
    queryFn: async () => { const { data } = await api.get('/api/pipelines'); return data; },
  });
  const allStages: (Stage & { pipelineName: string })[] = (pipelines || []).flatMap(p =>
    p.stages.map(s => ({ ...s, pipelineName: p.name }))
  );
  const { data: allUsers } = useQuery<User[]>({
    queryKey: ['users-settings'],
    queryFn: async () => {
      const { data } = await api.get('/api/leads');
      const map = new Map<string, User>();
      for (const l of data) map.set(l.user.id, l.user);
      return Array.from(map.values());
    },
  });

  const { data: crmFields = [] } = useQuery<{ id: string; key: string; name: string; tab: string }[]>({
    queryKey: ['fields-settings'],
    queryFn: async () => { const { data } = await api.get('/api/fields'); return data; },
  });

  // Load QR status + Socket.io
  useEffect(() => {
    api.get('/api/whatsapp-qr/status').then(({ data }) => {
      setQrStatus(data.status);
      if (data.qr) setQrImage(data.qr);
    }).catch(() => {});

    const socket = getSocket();
    socketRef.current = socket;

    // Ensure socket is connected
    if (!socket.connected) socket.connect();

    const accountId = typeof window !== 'undefined'
      ? JSON.parse(localStorage.getItem('af_user') || '{}')?.accountId
      : null;

    if (accountId) {
      socket.on(`whatsapp_qr_${accountId}`, ({ qr }: { qr: string }) => {
        setQrImage(qr);
        setQrStatus('qr_ready');
        setConnecting(false);
      });
      socket.on(`whatsapp_status_${accountId}`, ({ status }: { status: QRStatus }) => {
        setQrStatus(status);
        if (status === 'connected') { setQrImage(null); setConnecting(false); }
        if (status === 'disconnected') setConnecting(false);
      });
    }

    return () => {
      if (accountId) {
        socket.off(`whatsapp_qr_${accountId}`);
        socket.off(`whatsapp_status_${accountId}`);
      }
    };
  }, []);

  // Busca formulários reais da página Meta (estilo Pluga)
  async function fetchMetaForms() {
    if (!metaConfig.pageAccessToken && metaConfig.isNew) {
      toast('Salve o Page Access Token primeiro', 'error');
      return;
    }
    setLoadingForms(true);
    setMetaForms([]);
    setSelectedFormId('');
    setMetaFormFields([]);
    try {
      const { data } = await api.get('/api/settings/meta-leads/forms');
      if (!data.forms?.length) {
        toast('Nenhum formulário encontrado. Verifique o Page Access Token e as permissões.', 'error');
      } else {
        setMetaForms(data.forms);
        toast(`${data.forms.length} formulário(s) encontrado(s)!`);
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error || 'Erro ao buscar formulários';
      toast(msg, 'error');
    } finally {
      setLoadingForms(false);
    }
  }

  async function handleFormSelect(formId: string) {
    setSelectedFormId(formId);
    setMetaFormFields([]);
    if (!formId) return;
    setLoadingFields(true);
    try {
      const { data } = await api.get(`/api/settings/meta-leads/forms/${formId}/fields`);
      setMetaFormFields(data.fields || []);
    } catch {
      toast('Erro ao buscar campos do formulário', 'error');
    } finally {
      setLoadingFields(false);
    }
  }

  function addMapping() {
    setMetaConfig(c => ({
      ...c,
      fieldMappings: [...c.fieldMappings, { metaField: '', crmField: '' }],
    }));
  }

  function updateMapping(idx: number, key: 'metaField' | 'crmField', value: string) {
    setMetaConfig(c => ({
      ...c,
      fieldMappings: c.fieldMappings.map((m, i) => i === idx ? { ...m, [key]: value } : m),
    }));
  }

  function removeMapping(idx: number) {
    setMetaConfig(c => ({
      ...c,
      fieldMappings: c.fieldMappings.filter((_, i) => i !== idx),
    }));
  }

  async function handleConnect() {
    setConnecting(true);
    setQrImage(null);
    setQrStatus('connecting');
    try {
      await api.post('/api/whatsapp-qr/connect');

      // Polling fallback: check status every 2s for 30s in case socket misses event
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const { data } = await api.get('/api/whatsapp-qr/status');
          if (data.qr) {
            setQrImage(data.qr);
            setQrStatus('qr_ready');
            setConnecting(false);
            clearInterval(poll);
          } else if (data.status === 'connected') {
            setQrStatus('connected');
            setConnecting(false);
            clearInterval(poll);
          } else if (data.status === 'disconnected' && attempts > 3) {
            setQrStatus('disconnected');
            setConnecting(false);
            clearInterval(poll);
          }
        } catch { /* ignore */ }
        if (attempts >= 15) { setConnecting(false); clearInterval(poll); }
      }, 2000);
    } catch {
      toast('Erro ao iniciar conexão', 'error');
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    try {
      await api.post('/api/whatsapp-qr/disconnect');
      setQrStatus('disconnected');
      setQrImage(null);
      toast('WhatsApp desconectado');
    } catch {
      toast('Erro ao desconectar', 'error');
    }
  }

  async function handleSaveAPI(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/api/settings/whatsapp', {
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        verifyToken: config.verifyToken,
        active: config.active,
      });
      toast('Configurações salvas!');
      setIsNew(false);
      // Recarrega para mostrar a URL do Webhook
      const { data } = await api.get('/api/settings/whatsapp');
      if (data) setConfig(data);
    } catch {
      toast('Erro ao salvar configurações', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveMeta(e: React.FormEvent) {
    e.preventDefault();
    setSavingMeta(true);
    try {
      await api.post('/api/settings/meta-leads', {
        verifyToken: metaConfig.verifyToken,
        pageAccessToken: metaConfig.pageAccessToken,
        defaultStageId: metaConfig.defaultStageId || null,
        defaultUserId: metaConfig.defaultUserId || null,
        active: metaConfig.active,
        fieldMappings: metaConfig.fieldMappings.filter(m => m.metaField && m.crmField),
      });
      toast('Configuração Meta Leads salva!');
      setMetaConfig(c => ({ ...c, isNew: false }));
    } catch {
      toast('Erro ao salvar configuração Meta Leads', 'error');
    } finally {
      setSavingMeta(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast('Copiado!');
  }

  const statusLabel: Record<QRStatus, string> = {
    disconnected: 'Desconectado',
    connecting: 'Conectando...',
    qr_ready: 'Aguardando leitura do QR',
    connected: 'Conectado ✓',
  };

  const statusColor: Record<QRStatus, string> = {
    disconnected: 'text-slate-400',
    connecting: 'text-amber-500',
    qr_ready: 'text-blue-500',
    connected: 'text-green-600',
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Topbar title="Configurações" subtitle="Integrações e canais" />
      <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
        <div className="max-w-2xl mx-auto space-y-4">

          {/* Tab switcher */}
          <div className="flex bg-slate-100 rounded-xl p-1 gap-1">
            <button onClick={() => setTab('qr')} className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === 'qr' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              <QrCode size={16} /> QR Code
            </button>
            <button onClick={() => setTab('api')} className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === 'api' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
              API Oficial
            </button>
            <button onClick={() => setTab('meta')} className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === 'meta' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              <Megaphone size={16} /> Meta Lead Ads
            </button>
            <button onClick={() => setTab('sons')} className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === 'sons' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              <Volume2 size={16} /> Sons
            </button>
            <button onClick={() => setTab('ia')} className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === 'ia' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 8v4l3 3"/><circle cx="19" cy="5" r="3"/></svg>
              IA Chatbot
            </button>
            <button onClick={() => setTab('aparencia')} className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${tab === 'aparencia' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
              <Palette size={16} /> Aparência
            </button>
          </div>

          {/* QR Code Tab */}
          {tab === 'qr' && (
            <div className="bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden">
              <div className="flex items-center gap-3 px-6 py-4 border-b border-af-border" style={{ backgroundColor: '#075e54' }}>
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                  <QrCode size={22} className="text-white" />
                </div>
                <div>
                  <h2 className="text-white font-bold text-base">WhatsApp Business — QR Code</h2>
                  <p className="text-white/70 text-xs">Conecta como o WhatsApp Web, sem aprovação da Meta</p>
                </div>
                <div className="ml-auto">
                  {qrStatus === 'connected' ? (
                    <span className="flex items-center gap-1 bg-green-400/20 text-green-200 text-xs px-3 py-1 rounded-full">
                      <Wifi size={11} /> Conectado
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 bg-white/10 text-white/60 text-xs px-3 py-1 rounded-full">
                      <WifiOff size={11} /> {statusLabel[qrStatus]}
                    </span>
                  )}
                </div>
              </div>

              <div className="px-6 py-6">
                {/* Info */}
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6">
                  <div className="flex items-start gap-2">
                    <Info size={15} className="text-amber-600 mt-0.5 flex-shrink-0" />
                    <div className="text-xs text-amber-700">
                      <p className="font-semibold mb-1">Como funciona:</p>
                      <p>Conecta o número do WhatsApp via QR Code, igual ao WhatsApp Web. Funciona com qualquer número de WhatsApp Business, sem precisar de aprovação da Meta. A sessão pode ser perdida se o servidor reiniciar.</p>
                    </div>
                  </div>
                </div>

                {/* Status */}
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <p className="text-sm font-semibold text-slate-700">Status da conexão</p>
                    <p className={`text-sm font-medium mt-0.5 ${statusColor[qrStatus]}`}>
                      {statusLabel[qrStatus]}
                    </p>
                  </div>
                  {qrStatus === 'connected' ? (
                    <button
                      onClick={handleDisconnect}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl border border-red-200 text-red-600 text-sm hover:bg-red-50"
                    >
                      <WifiOff size={14} />
                      Desconectar
                    </button>
                  ) : (
                    <button
                      onClick={handleConnect}
                      disabled={connecting || qrStatus === 'qr_ready'}
                      className="flex items-center gap-2 px-4 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50"
                      style={{ backgroundColor: '#075e54' }}
                    >
                      {connecting ? (
                        <><RefreshCw size={14} className="animate-spin" /> Gerando QR...</>
                      ) : qrStatus === 'qr_ready' ? (
                        <><QrCode size={14} /> Escaneie o QR</>
                      ) : (
                        <><QrCode size={14} /> Conectar via QR</>
                      )}
                    </button>
                  )}
                </div>

                {/* QR Code */}
                {qrImage && (
                  <div className="flex flex-col items-center py-4">
                    <p className="text-sm font-semibold text-slate-700 mb-3">
                      Abra o WhatsApp → Dispositivos conectados → Conectar dispositivo
                    </p>
                    <div className="p-4 bg-white border-4 border-[#075e54] rounded-2xl shadow-lg">
                      <img src={qrImage} alt="QR Code WhatsApp" className="w-56 h-56" />
                    </div>
                    <p className="text-xs text-slate-400 mt-3">O QR Code expira em 60 segundos</p>
                  </div>
                )}

                {qrStatus === 'connected' && (
                  <div className="flex items-center justify-center py-8">
                    <div className="text-center">
                      <CheckCircle2 size={48} className="text-green-500 mx-auto mb-3" />
                      <p className="text-base font-semibold text-slate-800">WhatsApp conectado!</p>
                      <p className="text-sm text-slate-500 mt-1">Mensagens recebidas e enviadas diretamente pelo CRM</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* API Oficial Tab */}
          {tab === 'api' && (
            <div className="bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden">
              <div className="flex items-center gap-3 px-6 py-4 border-b border-af-border" style={{ backgroundColor: '#075e54' }}>
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center text-2xl">📱</div>
                <div>
                  <h2 className="text-white font-bold text-base">WhatsApp Business API</h2>
                  <p className="text-white/70 text-xs">Meta Cloud API (oficial)</p>
                </div>
                <div className="ml-auto">
                  {config.active ? (
                    <span className="flex items-center gap-1 bg-green-400/20 text-green-200 text-xs px-3 py-1 rounded-full">
                      <CheckCircle2 size={12} /> Ativo
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 bg-white/10 text-white/60 text-xs px-3 py-1 rounded-full">
                      <XCircle size={12} /> Inativo
                    </span>
                  )}
                </div>
              </div>

              {loadingConfig ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin w-8 h-8 border-4 border-af-accent border-t-transparent rounded-full" />
                </div>
              ) : (
                <form onSubmit={handleSaveAPI} className="px-6 py-5 space-y-5">
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                    <div className="flex items-start gap-2">
                      <Info size={15} className="text-blue-600 mt-0.5 flex-shrink-0" />
                      <div className="text-xs text-blue-700 space-y-1">
                        <p className="font-semibold">Requer aprovação da Meta e número verificado</p>
                        <p>Use se você já tem uma conta aprovada no WhatsApp Business API. Ideal para envio de templates e alto volume de mensagens.</p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1">
                      ID do Número de Telefone <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={config.phoneNumberId}
                      onChange={(e) => setConfig((c) => ({ ...c, phoneNumberId: e.target.value }))}
                      placeholder="Ex: 659761813879938"
                      required
                      className="w-full px-4 py-2.5 text-sm border border-af-border rounded-xl bg-slate-50 focus:outline-none focus:ring-2 focus:ring-af-accent"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1">
                      Token de Acesso <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="password"
                      value={config.accessToken}
                      onChange={(e) => setConfig((c) => ({ ...c, accessToken: e.target.value }))}
                      placeholder={isNew ? 'Cole seu token aqui' : 'Token salvo (deixe em branco para manter)'}
                      required={isNew}
                      className="w-full px-4 py-2.5 text-sm border border-af-border rounded-xl bg-slate-50 focus:outline-none focus:ring-2 focus:ring-af-accent"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1">Token de Verificação do Webhook</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={config.verifyToken}
                        onChange={(e) => setConfig((c) => ({ ...c, verifyToken: e.target.value }))}
                        className="flex-1 px-4 py-2.5 text-sm border border-af-border rounded-xl bg-slate-50 focus:outline-none focus:ring-2 focus:ring-af-accent"
                      />
                      <button type="button" onClick={() => copyToClipboard(config.verifyToken)}
                        className="px-3 py-2 border border-af-border rounded-xl hover:bg-af-light text-slate-500">
                        <Copy size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Webhook URL — always visible so user can copy before saving */}
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1">URL do Webhook</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={config.webhookUrl || 'https://af-crm-production.up.railway.app/api/webhooks/whatsapp'}
                        readOnly
                        className="flex-1 px-4 py-2.5 text-xs border border-af-border rounded-xl bg-slate-100 text-slate-600 font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => copyToClipboard(config.webhookUrl || 'https://af-crm-production.up.railway.app/api/webhooks/whatsapp')}
                        className="px-3 py-2 border border-af-border rounded-xl hover:bg-af-light text-slate-500"
                      >
                        <Copy size={14} />
                      </button>
                    </div>
                    <p className="text-xs text-slate-400 mt-1">Cole esta URL no painel da Meta → Webhook → campo <strong>messages</strong></p>
                  </div>

                  <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border border-af-border">
                    <div>
                      <p className="text-sm font-semibold text-slate-700">Ativar integração</p>
                      <p className="text-xs text-slate-400 mt-0.5">Enviar mensagens via API oficial da Meta</p>
                    </div>
                    <button type="button" onClick={() => setConfig((c) => ({ ...c, active: !c.active }))}
                      className={`relative w-12 h-6 rounded-full transition-colors ${config.active ? 'bg-[#075e54]' : 'bg-slate-300'}`}>
                      <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${config.active ? 'translate-x-7' : 'translate-x-1'}`} />
                    </button>
                  </div>

                  <div className="flex gap-3 pt-2">
                    <button type="submit" disabled={saving}
                      className="flex-1 py-3 rounded-xl text-white font-semibold text-sm disabled:opacity-50"
                      style={{ backgroundColor: '#075e54' }}>
                      {saving ? 'Salvando...' : 'Salvar configurações'}
                    </button>
                    <button type="button"
                      onClick={async () => {
                        try {
                          const { data } = await api.get('/api/settings/whatsapp/test');
                          if (data.ok) {
                            toast(`✅ Conexão OK — ${data.name} (${data.phoneNumber})`, 'success');
                          } else {
                            toast(`❌ ${data.error}`, 'error');
                          }
                        } catch {
                          toast('Erro ao testar conexão', 'error');
                        }
                      }}
                      className="px-4 py-3 rounded-xl border border-af-border text-slate-600 text-sm hover:bg-af-light whitespace-nowrap">
                      Testar conexão
                    </button>
                    <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer"
                      className="flex items-center gap-1 px-4 py-3 rounded-xl border border-af-border text-slate-600 text-sm hover:bg-af-light">
                      <ExternalLink size={14} /> Meta
                    </a>
                  </div>
                </form>
              )}
            </div>
          )}
          {/* ── Meta Lead Ads Tab ── */}
          {tab === 'meta' && (
            <div className="bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden">
              {/* Header */}
              <div className="flex items-center gap-3 px-6 py-4 border-b border-af-border bg-gradient-to-r from-blue-600 to-indigo-600">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                  <Megaphone size={22} className="text-white" />
                </div>
                <div>
                  <h2 className="text-white font-bold text-base">Meta Lead Ads</h2>
                  <p className="text-white/70 text-xs">Captura automática de leads de formulários do Facebook e Instagram</p>
                </div>
                <div className="ml-auto">
                  {metaConfig.active ? (
                    <span className="flex items-center gap-1 bg-green-400/20 text-green-200 text-xs px-3 py-1 rounded-full">
                      <CheckCircle2 size={12} /> Ativo
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 bg-white/10 text-white/60 text-xs px-3 py-1 rounded-full">
                      <XCircle size={12} /> Inativo
                    </span>
                  )}
                </div>
              </div>

              {loadingMeta ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin w-8 h-8 border-4 border-af-accent border-t-transparent rounded-full" />
                </div>
              ) : (
                <form onSubmit={handleSaveMeta} className="px-6 py-5 space-y-5">

                  {/* How it works */}
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                    <div className="flex items-start gap-2">
                      <Info size={15} className="text-blue-600 mt-0.5 flex-shrink-0" />
                      <div className="text-xs text-blue-700 space-y-1.5">
                        <p className="font-semibold text-sm">Como funciona:</p>
                        <ol className="list-decimal list-inside space-y-1">
                          <li>Copie a <strong>URL do Webhook</strong> abaixo</li>
                          <li>No painel da Meta: <strong>Desenvolvedor → Webhooks → leadgen</strong></li>
                          <li>Cole a URL e o <strong>Token de Verificação</strong></li>
                          <li>Configure o <strong>Token de Acesso da Página</strong> para buscar os dados</li>
                          <li>Quando alguém preencher o formulário, o lead é criado automaticamente no CRM ✅</li>
                        </ol>
                      </div>
                    </div>
                  </div>

                  {/* Webhook URL */}
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1">
                      URL do Webhook <span className="text-xs text-slate-400 font-normal">(cole no painel da Meta)</span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={metaConfig.webhookUrl}
                        readOnly
                        className="flex-1 px-4 py-2.5 text-xs border border-af-border rounded-xl bg-slate-100 text-slate-600 font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => copyToClipboard(metaConfig.webhookUrl)}
                        className="px-3 py-2 border border-af-border rounded-xl hover:bg-af-light text-slate-500"
                      >
                        <Copy size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Verify Token */}
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1">
                      Token de Verificação <span className="text-red-500">*</span>
                      <span className="text-xs text-slate-400 font-normal ml-1">(use o mesmo no painel da Meta)</span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={metaConfig.verifyToken}
                        onChange={e => setMetaConfig(c => ({ ...c, verifyToken: e.target.value }))}
                        required
                        minLength={6}
                        placeholder="Ex: af_meta_verify_2024"
                        className="flex-1 px-4 py-2.5 text-sm border border-af-border rounded-xl bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-400"
                      />
                      <button
                        type="button"
                        onClick={() => copyToClipboard(metaConfig.verifyToken)}
                        className="px-3 py-2 border border-af-border rounded-xl hover:bg-af-light text-slate-500"
                      >
                        <Copy size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Page Access Token */}
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1">
                      Token de Acesso da Página <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="password"
                      value={metaConfig.pageAccessToken}
                      onChange={e => setMetaConfig(c => ({ ...c, pageAccessToken: e.target.value }))}
                      required={metaConfig.isNew}
                      placeholder={metaConfig.isNew ? 'Cole o Page Access Token aqui' : 'Token salvo (deixe em branco para manter)'}
                      className="w-full px-4 py-2.5 text-sm border border-af-border rounded-xl bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-400"
                    />
                    <p className="text-xs text-slate-400 mt-1">
                      Encontre em: Meta for Developers → Sua App → Ferramentas → Graph API Explorer → Access Token da Página
                    </p>
                  </div>

                  {/* ── Mapeamento de campos estilo Pluga ── */}
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    {/* Header da seção */}
                    <div className="flex items-center justify-between px-4 py-3 bg-slate-50 border-b border-slate-200">
                      <div>
                        <p className="text-sm font-semibold text-slate-700">Mapeamento de campos</p>
                        <p className="text-xs text-slate-400 mt-0.5">Conecte os campos do formulário Meta com os campos do CRM</p>
                      </div>
                    </div>

                    <div className="p-4 space-y-4">
                      {/* Passo 1: Selecionar formulário */}
                      <div>
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
                          1. Selecione o formulário Meta
                        </p>
                        <div className="flex gap-2">
                          <div className="flex-1 relative">
                            <select
                              value={selectedFormId}
                              onChange={e => handleFormSelect(e.target.value)}
                              disabled={metaForms.length === 0}
                              className="w-full text-sm px-3 py-2.5 border border-af-border rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-blue-400 appearance-none disabled:bg-slate-50 disabled:text-slate-400"
                            >
                              <option value="">
                                {metaForms.length === 0
                                  ? 'Clique em "Buscar formulários" primeiro'
                                  : `Selecione o formulário (${metaForms.length} disponíveis)`}
                              </option>
                              {metaForms.map(f => (
                                <option key={f.id} value={f.id}>
                                  {f.pageName} → {f.name} {f.status !== 'ACTIVE' ? `(${f.status})` : ''}
                                </option>
                              ))}
                            </select>
                            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                          </div>
                          <button
                            type="button"
                            onClick={fetchMetaForms}
                            disabled={loadingForms}
                            className="flex items-center gap-1.5 px-3 py-2.5 text-sm border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-xl font-medium transition-colors disabled:opacity-50 whitespace-nowrap"
                          >
                            <RefreshCw size={13} className={loadingForms ? 'animate-spin' : ''} />
                            {loadingForms ? 'Buscando...' : 'Buscar formulários'}
                          </button>
                        </div>

                        {/* Campos carregados */}
                        {loadingFields && (
                          <p className="text-xs text-blue-500 mt-2 flex items-center gap-1">
                            <RefreshCw size={11} className="animate-spin" /> Carregando campos do formulário...
                          </p>
                        )}
                        {metaFormFields.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {metaFormFields.map(f => (
                              <span key={f.key} className="text-xs bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded-md font-mono">
                                {f.key}
                                {f.label && f.label !== f.type && (
                                  <span className="text-blue-400 ml-1 font-sans">({f.label})</span>
                                )}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Passo 2: Mapeamentos */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                            2. Mapeie os campos
                          </p>
                          <button
                            type="button"
                            onClick={addMapping}
                            className="text-xs px-2.5 py-1 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-medium transition-colors"
                          >
                            + Adicionar linha
                          </button>
                        </div>

                        {metaConfig.fieldMappings.length === 0 ? (
                          <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-xl text-slate-400 text-xs space-y-1">
                            <p className="text-2xl">🔗</p>
                            <p className="font-medium">Nenhum mapeamento configurado</p>
                            <p>Selecione um formulário acima e clique em "+ Adicionar linha"</p>
                          </div>
                        ) : (
                          <div className="space-y-2">
                            {/* Cabeçalho */}
                            <div className="grid grid-cols-[1fr_24px_1fr_28px] gap-2 px-2">
                              <span className="text-xs font-semibold text-slate-500 flex items-center gap-1">
                                <span className="w-2 h-2 bg-blue-500 rounded-full inline-block" />
                                Formulário Meta
                              </span>
                              <span />
                              <span className="text-xs font-semibold text-slate-500 flex items-center gap-1">
                                <span className="w-2 h-2 bg-indigo-500 rounded-full inline-block" />
                                Campo do CRM
                              </span>
                              <span />
                            </div>

                            {metaConfig.fieldMappings.map((mapping, idx) => (
                              <div key={idx} className="grid grid-cols-[1fr_24px_1fr_28px] gap-2 items-center bg-white border border-slate-200 rounded-xl px-3 py-2.5 hover:border-blue-200 transition-colors">
                                {/* Campo Meta */}
                                {metaFormFields.length > 0 ? (
                                  <select
                                    value={mapping.metaField}
                                    onChange={e => updateMapping(idx, 'metaField', e.target.value)}
                                    className="w-full text-xs px-2.5 py-1.5 border border-af-border rounded-lg bg-slate-50 focus:outline-none focus:ring-1 focus:ring-blue-400 font-mono"
                                  >
                                    <option value="">Selecione o campo Meta</option>
                                    {metaFormFields.map(f => (
                                      <option key={f.key} value={f.key}>
                                        {f.key}{f.label && f.label !== f.type ? ` — ${f.label}` : ''}
                                      </option>
                                    ))}
                                  </select>
                                ) : (
                                  <input
                                    value={mapping.metaField}
                                    onChange={e => updateMapping(idx, 'metaField', e.target.value)}
                                    placeholder="Ex: full_name"
                                    className="w-full text-xs px-2.5 py-1.5 border border-af-border rounded-lg bg-slate-50 focus:outline-none focus:ring-1 focus:ring-blue-400 font-mono"
                                  />
                                )}

                                {/* Seta */}
                                <ArrowRight size={14} className="text-slate-400 mx-auto" />

                                {/* Campo CRM */}
                                <select
                                  value={mapping.crmField}
                                  onChange={e => updateMapping(idx, 'crmField', e.target.value)}
                                  className="w-full text-xs px-2.5 py-1.5 border border-af-border rounded-lg bg-slate-50 focus:outline-none focus:ring-1 focus:ring-blue-400"
                                >
                                  <option value="">Selecione o campo CRM</option>
                                  {(['Principal', 'Financiamento', 'Consórcio',
                                    ...Array.from(new Set(crmFields.map(f => f.tab).filter(t => !['Principal','Financiamento','Consórcio'].includes(t))))
                                  ]).map(tabName => (
                                    <optgroup key={tabName} label={tabName}>
                                      {crmFields.filter(f => f.tab === tabName).map(f => (
                                        <option key={f.key} value={f.key}>{f.name}</option>
                                      ))}
                                    </optgroup>
                                  ))}
                                </select>

                                {/* Remover */}
                                <button
                                  type="button"
                                  onClick={() => removeMapping(idx)}
                                  className="text-slate-300 hover:text-red-500 transition-colors p-1 rounded-lg hover:bg-red-50"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Default Stage */}
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1">
                      Estágio padrão para novos leads
                    </label>
                    <select
                      value={metaConfig.defaultStageId || ''}
                      onChange={e => setMetaConfig(c => ({ ...c, defaultStageId: e.target.value || null }))}
                      className="w-full px-4 py-2.5 text-sm border border-af-border rounded-xl bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-400"
                    >
                      <option value="">Primeiro estágio do pipeline (padrão)</option>
                      {allStages.map(s => (
                        <option key={s.id} value={s.id}>{s.pipelineName} → {s.name}</option>
                      ))}
                    </select>
                  </div>

                  {/* Default User */}
                  <div>
                    <label className="block text-sm font-semibold text-slate-700 mb-1">
                      Responsável padrão pelos leads
                    </label>
                    <select
                      value={metaConfig.defaultUserId || ''}
                      onChange={e => setMetaConfig(c => ({ ...c, defaultUserId: e.target.value || null }))}
                      className="w-full px-4 py-2.5 text-sm border border-af-border rounded-xl bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-400"
                    >
                      <option value="">Primeiro usuário da conta (padrão)</option>
                      {(allUsers || []).map(u => (
                        <option key={u.id} value={u.id}>{u.name}</option>
                      ))}
                    </select>
                  </div>

                  {/* Active toggle */}
                  <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border border-af-border">
                    <div>
                      <p className="text-sm font-semibold text-slate-700">Ativar captura de leads</p>
                      <p className="text-xs text-slate-400 mt-0.5">Leads dos formulários serão criados automaticamente no CRM</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setMetaConfig(c => ({ ...c, active: !c.active }))}
                      className={`relative w-12 h-6 rounded-full transition-colors ${metaConfig.active ? 'bg-blue-600' : 'bg-slate-300'}`}
                    >
                      <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${metaConfig.active ? 'translate-x-7' : 'translate-x-1'}`} />
                    </button>
                  </div>

                  {/* Save + Docs link */}
                  <div className="flex gap-3 pt-2">
                    <button
                      type="submit"
                      disabled={savingMeta}
                      className="flex-1 py-3 rounded-xl text-white font-semibold text-sm disabled:opacity-50 bg-blue-600 hover:bg-blue-700 transition-colors"
                    >
                      {savingMeta ? 'Salvando...' : 'Salvar configuração'}
                    </button>
                    <a
                      href="https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving"
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 px-4 py-3 rounded-xl border border-af-border text-slate-600 text-sm hover:bg-af-light"
                    >
                      <ExternalLink size={14} /> Docs Meta
                    </a>
                  </div>
                </form>
              )}
            </div>
          )}

          {/* ── Sons Tab ── */}
          {tab === 'sons' && (
            <div className="bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden">
              <div className="flex items-center gap-3 px-6 py-4 border-b border-af-border bg-gradient-to-r from-violet-600 to-indigo-600">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
                  <Volume2 size={22} className="text-white" />
                </div>
                <div>
                  <h2 className="text-white font-bold text-base">Notificações Sonoras</h2>
                  <p className="text-white/70 text-xs">Escolha o som para novas mensagens do WhatsApp</p>
                </div>
              </div>

              <div className="px-6 py-5 space-y-3">
                <p className="text-xs text-slate-500">
                  Clique em <strong>▶ Ouvir</strong> para testar cada som, depois clique em <strong>Usar este som</strong> para salvar.
                </p>

                <div className="grid grid-cols-1 gap-2">
                  {SOUNDS.map(s => (
                    <div
                      key={s.key}
                      className={`flex items-center gap-3 p-3.5 rounded-xl border transition-all ${
                        selectedSound === s.key
                          ? 'border-violet-400 bg-violet-50'
                          : 'border-af-border hover:border-violet-200 hover:bg-slate-50'
                      }`}
                    >
                      <span className="text-2xl w-8 text-center flex-shrink-0">{s.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-slate-800">{s.label}</p>
                        <p className="text-xs text-slate-400">{s.desc}</p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {s.key !== 'none' && (
                          <button
                            onClick={() => playSound(s.key)}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs border border-af-border rounded-lg hover:bg-slate-100 text-slate-600 transition-colors"
                          >
                            ▶ Ouvir
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setSelectedSound(s.key);
                            localStorage.setItem('af_notification_sound', s.key);
                            toast(`Som "${s.label}" salvo!`);
                          }}
                          className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                            selectedSound === s.key
                              ? 'bg-violet-600 text-white'
                              : 'border border-violet-200 text-violet-600 hover:bg-violet-50'
                          }`}
                        >
                          {selectedSound === s.key ? (
                            <><CheckCircle2 size={11} /> Selecionado</>
                          ) : (
                            'Usar este'
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mt-2">
                  <p className="text-xs text-amber-700">
                    <strong>💡 Dica:</strong> Se o som não tocar, clique em qualquer lugar da página primeiro. Navegadores bloqueiam áudio até haver interação do usuário.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* IA Chatbot Tab */}
          {tab === 'ia' && <IAChatbotTab />}

          {/* Aparência Tab */}
          {tab === 'aparencia' && <AparenciaTab />}

        </div>
      </div>
    </div>
  );
}

const THEME_OPTIONS: { key: BackgroundTheme; label: string; desc: string; preview: string; textColor: string }[] = [
  { key: 'white', label: 'Branco', desc: 'Fundo claro padrão', preview: '#f4f6f9', textColor: '#1e293b' },
  { key: 'black', label: 'Preto', desc: 'Fundo escuro para pouca luz', preview: '#0b0f16', textColor: '#e5e7eb' },
  { key: 'blue', label: 'Azul', desc: 'Fundo nas cores da A&F', preview: '#0d2545', textColor: '#e8f0f9' },
];

const IMAGE_PRESETS: { label: string; url: string; thumb: string }[] = [
  { label: 'Montanhas', url: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1600&q=80', thumb: 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=300&q=60' },
  { label: 'Floresta', url: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1600&q=80', thumb: 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=300&q=60' },
  { label: 'Serra', url: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1600&q=80', thumb: 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=300&q=60' },
  { label: 'Lago', url: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=1600&q=80', thumb: 'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=300&q=60' },
  { label: 'Campo', url: 'https://images.unsplash.com/photo-1500673922987-e212871fec22?w=1600&q=80', thumb: 'https://images.unsplash.com/photo-1500673922987-e212871fec22?w=300&q=60' },
  { label: 'Pico', url: 'https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=1600&q=80', thumb: 'https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=300&q=60' },
];

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // 3MB

function AparenciaTab() {
  const { theme, setTheme, bgImage, setBgImage, surfaceOpacity, setSurfaceOpacity } = useThemeStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Selecione um arquivo de imagem', 'error');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toast('Imagem muito grande. Escolha um arquivo de até 3MB.', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setBgImage(reader.result as string);
      toast('Imagem de fundo aplicada!');
    };
    reader.readAsDataURL(file);
  }

  return (
    <div className="bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-af-border bg-gradient-to-r from-slate-700 to-slate-900">
        <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center">
          <Palette size={22} className="text-white" />
        </div>
        <div>
          <h2 className="text-white font-bold text-base">Aparência</h2>
          <p className="text-white/70 text-xs">Escolha a cor ou imagem de fundo do sistema</p>
        </div>
      </div>

      <div className="px-6 py-5 space-y-5">
        <div>
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Cor sólida</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {THEME_OPTIONS.map((opt) => (
              <button
                key={opt.key}
                onClick={() => {
                  setTheme(opt.key);
                  setBgImage(null);
                  toast(`Fundo "${opt.label}" aplicado!`);
                }}
                className={`text-left rounded-xl border p-3.5 transition-all ${
                  theme === opt.key && !bgImage
                    ? 'border-violet-400 ring-2 ring-violet-100'
                    : 'border-af-border hover:border-violet-200'
                }`}
              >
                <div
                  className="w-full h-16 rounded-lg border border-black/10 flex items-center justify-center mb-2"
                  style={{ backgroundColor: opt.preview, color: opt.textColor }}
                >
                  <span className="text-xs font-medium">Aa</span>
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{opt.label}</p>
                    <p className="text-xs text-slate-400">{opt.desc}</p>
                  </div>
                  {theme === opt.key && !bgImage && <CheckCircle2 size={16} className="text-violet-600 flex-shrink-0" />}
                </div>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Imagem de fundo</p>
            {bgImage && (
              <button
                onClick={() => { setBgImage(null); toast('Imagem de fundo removida'); }}
                className="text-xs text-red-500 hover:text-red-600 font-medium"
              >
                Remover imagem
              </button>
            )}
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {IMAGE_PRESETS.map((img) => (
              <button
                key={img.url}
                onClick={() => { setBgImage(img.url); toast(`Fundo "${img.label}" aplicado!`); }}
                className={`relative h-16 rounded-lg overflow-hidden border-2 transition-all ${
                  bgImage === img.url ? 'border-violet-400 ring-2 ring-violet-100' : 'border-transparent hover:border-violet-200'
                }`}
                title={img.label}
              >
                <img src={img.thumb} alt={img.label} className="w-full h-full object-cover" />
                {bgImage === img.url && (
                  <span className="absolute inset-0 bg-black/20 flex items-center justify-center">
                    <CheckCircle2 size={16} className="text-white" />
                  </span>
                )}
              </button>
            ))}
            <button
              onClick={() => fileInputRef.current?.click()}
              className="h-16 rounded-lg border-2 border-dashed border-af-border hover:border-violet-300 hover:bg-violet-50 flex flex-col items-center justify-center gap-0.5 text-slate-400 hover:text-violet-500 transition-colors"
              title="Enviar imagem"
            >
              <Upload size={16} />
              <span className="text-[10px] font-medium">Enviar</span>
            </button>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" onChange={handleUpload} className="hidden" />
          <p className="text-xs text-slate-400 mt-2">Imagens até 3MB. A imagem substitui a cor sólida como fundo do sistema.</p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Transparência dos painéis</p>
            <span className="text-xs font-semibold text-slate-600">{surfaceOpacity}%</span>
          </div>
          <input
            type="range"
            min={30}
            max={100}
            step={5}
            value={surfaceOpacity}
            onChange={(e) => setSurfaceOpacity(Number(e.target.value))}
            onMouseUp={() => toast('Transparência atualizada!')}
            onTouchEnd={() => toast('Transparência atualizada!')}
            className="w-full accent-violet-500"
          />
          <p className="text-xs text-slate-400 mt-1">Controla o quanto o topo e as colunas do Funil deixam o fundo transparecer, como no Trello.</p>
        </div>
      </div>
    </div>
  );
}

function IAChatbotTab() {
  const [enabled, setEnabled] = useState(false);
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [prompt, setPrompt] = useState(`Você é um assistente de vendas da A&F Soluções Financeiras.

Seu papel é:
- Receber e qualificar leads de forma amigável e profissional
- Responder dúvidas sobre nossos produtos e serviços financeiros
- Coletar informações relevantes: nome, necessidade, valor disponível para investimento
- Agendar reuniões com consultores quando o lead demonstrar interesse
- Transferir para um humano quando necessário

Diretrizes:
- Seja sempre cordial e use o nome do lead quando souber
- Não forneça informações financeiras específicas sem consultar um especialista
- Se o lead perguntar sobre taxa, dívida ou situação financeira complexa, transferir para humano
- Responda em português do Brasil`);
  const [handoffKeywords, setHandoffKeywords] = useState('falar com humano, atendente, pessoa, urgente, problema');
  const [autoReply, setAutoReply] = useState(true);
  const [replyDelay, setReplyDelay] = useState('3');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    await new Promise(r => setTimeout(r, 600));
    setSaving(false);
    localStorage.setItem('af_ia_config', JSON.stringify({ enabled, model, prompt, handoffKeywords, autoReply, replyDelay }));
    // toast imported from parent scope
    alert('Configurações de IA salvas!');
  }

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-purple-50 to-blue-50 border border-purple-200 rounded-xl p-4 flex items-start gap-3">
        <div className="p-2 bg-purple-100 rounded-lg flex-shrink-0">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#7c3aed" strokeWidth="2"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 8v4l3 3"/><circle cx="19" cy="5" r="3"/></svg>
        </div>
        <div>
          <p className="text-sm font-semibold text-purple-900">Resposta automática com IA</p>
          <p className="text-xs text-purple-700 mt-0.5">Configure a IA para responder automaticamente as mensagens dos clientes com base em um prompt de instruções personalizado.</p>
        </div>
      </div>

      {/* Enable toggle */}
      <div className="flex items-center justify-between p-4 bg-white rounded-xl border border-af-border">
        <div>
          <p className="text-sm font-semibold text-slate-900">Ativar IA no chatbot</p>
          <p className="text-xs text-slate-500 mt-0.5">Quando ativada, a IA responderá automaticamente às mensagens recebidas</p>
        </div>
        <button
          onClick={() => setEnabled(!enabled)}
          className={`relative w-12 h-6 rounded-full transition-colors ${enabled ? 'bg-purple-500' : 'bg-slate-200'}`}
        >
          <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-7' : 'translate-x-1'}`} />
        </button>
      </div>

      {/* Model */}
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-slate-700">Modelo de IA</label>
        <select
          value={model}
          onChange={e => setModel(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
        >
          <option value="claude-sonnet-4-6">Claude Sonnet 4.6 (Recomendado — rápido e eficiente)</option>
          <option value="claude-opus-4-7">Claude Opus 4.7 (Mais inteligente — maior custo)</option>
          <option value="claude-haiku-4-5">Claude Haiku 4.5 (Mais rápido — menor custo)</option>
        </select>
      </div>

      {/* Prompt */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-slate-700">Prompt de instruções</label>
          <span className="text-xs text-slate-400">{prompt.length} caracteres</span>
        </div>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-af-border rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-af-accent font-mono leading-relaxed"
          rows={12}
          placeholder="Descreva como a IA deve se comportar, o tom de voz, o que pode e não pode responder..."
        />
        <p className="text-xs text-slate-400">Este prompt define a personalidade e comportamento da IA ao responder seus clientes.</p>
      </div>

      {/* Reply behavior */}
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700">Atraso na resposta</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={replyDelay}
              onChange={e => setReplyDelay(e.target.value)}
              min={0}
              max={60}
              className="flex-1 px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
            />
            <span className="text-sm text-slate-500">segundos</span>
          </div>
          <p className="text-xs text-slate-400">Simula tempo de digitação natural</p>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700">Resposta automática</label>
          <div className="flex items-center gap-3 mt-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={autoReply} onChange={() => setAutoReply(true)} className="accent-purple-500" />
              <span className="text-sm text-slate-700">Sempre responder</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="radio" checked={!autoReply} onChange={() => setAutoReply(false)} className="accent-purple-500" />
              <span className="text-sm text-slate-700">Só fora do horário</span>
            </label>
          </div>
        </div>
      </div>

      {/* Handoff keywords */}
      <div className="flex flex-col gap-1">
        <label className="text-sm font-medium text-slate-700">Palavras-chave para transferir ao humano</label>
        <input
          value={handoffKeywords}
          onChange={e => setHandoffKeywords(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
          placeholder="falar com humano, atendente, urgente"
        />
        <p className="text-xs text-slate-400">Separe por vírgulas. Quando o cliente usar essas palavras, a conversa será transferida para um agente humano.</p>
      </div>

      {/* Save */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-60 transition-colors"
        >
          {saving ? 'Salvando...' : 'Salvar configurações de IA'}
        </button>
      </div>
    </div>
  );
}
