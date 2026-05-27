'use client';
import { useState, useEffect, useRef } from 'react';
import { Topbar } from '@/components/ui/topbar';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { CheckCircle2, XCircle, Copy, ExternalLink, Info, QrCode, Wifi, WifiOff, RefreshCw, Megaphone } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Pipeline, Stage, User } from '@/types';

type Tab = 'api' | 'qr' | 'meta';

interface WAConfig {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  active: boolean;
  webhookUrl: string;
}

type QRStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

interface MetaConfig {
  verifyToken: string;
  pageAccessToken: string;
  defaultStageId: string | null;
  defaultUserId: string | null;
  active: boolean;
  webhookUrl: string;
  isNew: boolean;
}

export default function ConfiguracoesPage() {
  const [tab, setTab] = useState<Tab>('qr');

  // Meta Lead Ads state
  const [metaConfig, setMetaConfig] = useState<MetaConfig>({
    verifyToken: 'af_meta_verify',
    pageAccessToken: '',
    defaultStageId: null,
    defaultUserId: null,
    active: false,
    webhookUrl: '',
    isNew: true,
  });
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [savingMeta, setSavingMeta] = useState(false);

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
            <button
              onClick={() => setTab('qr')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
                tab === 'qr' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <QrCode size={16} />
              QR Code
            </button>
            <button
              onClick={() => setTab('api')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
                tab === 'api' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
              API Oficial
            </button>
            <button
              onClick={() => setTab('meta')}
              className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all ${
                tab === 'meta' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Megaphone size={16} />
              Meta Lead Ads
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

                  {config.webhookUrl && (
                    <div>
                      <label className="block text-sm font-semibold text-slate-700 mb-1">URL do Webhook</label>
                      <div className="flex gap-2">
                        <input type="text" value={config.webhookUrl} readOnly
                          className="flex-1 px-4 py-2.5 text-xs border border-af-border rounded-xl bg-slate-100 text-slate-600 font-mono" />
                        <button type="button" onClick={() => copyToClipboard(config.webhookUrl)}
                          className="px-3 py-2 border border-af-border rounded-xl hover:bg-af-light text-slate-500">
                          <Copy size={14} />
                        </button>
                      </div>
                      <p className="text-xs text-slate-400 mt-1">Cole esta URL no painel da Meta → Webhook → campo <strong>messages</strong></p>
                    </div>
                  )}

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

        </div>
      </div>
    </div>
  );
}
