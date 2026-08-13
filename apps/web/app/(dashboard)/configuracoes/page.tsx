'use client';
import { useState, useEffect, useRef } from 'react';
import { Topbar } from '@/components/ui/topbar';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { CheckCircle2, XCircle, Copy, ExternalLink, Info, QrCode, Wifi, WifiOff, RefreshCw, ChevronDown, ArrowRight, Trash2, Volume2, VolumeX, Palette, Bot, Plus, Pencil, X as XIcon, HardDrive, Folder, FolderOpen, ChevronRight, Building2 } from 'lucide-react';
import { AppearancePanel } from '@/components/settings/appearance-panel';

type Tab = 'api' | 'qr' | 'sons' | 'ia' | 'aparencia' | 'agente' | 'drive' | 'setores';

interface WAConfig {
  phoneNumberId: string;
  accessToken: string;
  verifyToken: string;
  active: boolean;
  webhookUrl: string;
}

type QRStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <Topbar title="Configurações" subtitle="Integrações e canais" />
      <div className="flex-1 overflow-y-auto p-6 scrollbar-thin">
        <div className="max-w-2xl mx-auto space-y-4">

          {/* Tab switcher — chips de largura natural (evita espremer/quebrar texto) */}
          <div className="flex flex-wrap bg-slate-100 rounded-2xl p-2 gap-1.5">
            <button onClick={() => setTab('qr')} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${tab === 'qr' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700 hover:bg-white/60'}`}>
              <QrCode size={16} /> QR Code
            </button>
            <button onClick={() => setTab('api')} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${tab === 'api' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700 hover:bg-white/60'}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>
              API Oficial
            </button>
            <button onClick={() => setTab('sons')} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${tab === 'sons' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700 hover:bg-white/60'}`}>
              <Volume2 size={16} /> Sons
            </button>
            <button onClick={() => setTab('ia')} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${tab === 'ia' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700 hover:bg-white/60'}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 8v4l3 3"/><circle cx="19" cy="5" r="3"/></svg>
              IA Chatbot
            </button>
            <button onClick={() => setTab('aparencia')} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${tab === 'aparencia' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700 hover:bg-white/60'}`}>
              <Palette size={16} /> Aparência
            </button>
            <button onClick={() => setTab('agente')} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${tab === 'agente' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700 hover:bg-white/60'}`}>
              <Bot size={16} /> Agente IA
            </button>
            <button onClick={() => setTab('drive')} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${tab === 'drive' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700 hover:bg-white/60'}`}>
              <HardDrive size={16} /> Google Drive
            </button>
            <button onClick={() => setTab('setores')} className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium whitespace-nowrap transition-all ${tab === 'setores' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700 hover:bg-white/60'}`}>
              <Building2 size={16} /> Departamentos
            </button>
          </div>

          {/* QR Code Tab — múltiplos números */}
          {tab === 'qr' && <QRNumbersTab />}

          {/* Departamentos Tab */}
          {tab === 'setores' && <DepartmentsTab />}

          {/* API Oficial Tab */}
          {tab === 'api' && <ApiOficialTab />}
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
          {tab === 'aparencia' && <AppearancePanel />}

          {/* Agente IA Tab */}
          {tab === 'agente' && <AgenteTab />}

          {/* Google Drive Tab */}
          {tab === 'drive' && <GoogleDriveTab />}

        </div>
      </div>
    </div>
  );
}


// ─── Aba QR Code: múltiplos números de WhatsApp ─────────────────────────────

interface WANumber {
  id: string;
  label: string;
  phone: string | null;
  status: QRStatus;
  departmentId: string | null;
}

interface DepartmentOption { id: string; name: string; }

function QRNumbersTab() {
  const [numbers, setNumbers] = useState<WANumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [newLabel, setNewLabel] = useState('');
  const [adding, setAdding] = useState(false);
  const [qrByNumber, setQrByNumber] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [departments, setDepartments] = useState<DepartmentOption[]>([]);
  const pollRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  async function loadNumbers() {
    try {
      const { data } = await api.get('/api/whatsapp-qr/numbers');
      setNumbers(data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  async function handleChangeDepartment(id: string, departmentId: string) {
    setNumbers(prev => prev.map(n => n.id === id ? { ...n, departmentId: departmentId || null } : n));
    try {
      await api.patch(`/api/whatsapp-qr/numbers/${id}`, { departmentId: departmentId || null });
    } catch { toast('Erro ao mudar o setor', 'error'); loadNumbers(); }
  }

  useEffect(() => {
    loadNumbers();
    api.get('/api/departments').then(({ data }) => setDepartments(data)).catch(() => {});
    const socket = getSocket();
    if (!socket.connected) socket.connect();
    // atualiza status geral a cada 20s
    const t = setInterval(loadNumbers, 20000);
    return () => { clearInterval(t); Object.values(pollRef.current).forEach(clearInterval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pollNumber(id: string) {
    if (pollRef.current[id]) clearInterval(pollRef.current[id]);
    let attempts = 0;
    pollRef.current[id] = setInterval(async () => {
      attempts++;
      try {
        const { data } = await api.get(`/api/whatsapp-qr/numbers/${id}/status`);
        if (data.qr) {
          setQrByNumber(prev => ({ ...prev, [id]: data.qr }));
          setNumbers(prev => prev.map(n => n.id === id ? { ...n, status: 'qr_ready' } : n));
        } else if (data.status === 'connected') {
          setQrByNumber(prev => { const c = { ...prev }; delete c[id]; return c; });
          setNumbers(prev => prev.map(n => n.id === id ? { ...n, status: 'connected', phone: data.phone } : n));
          clearInterval(pollRef.current[id]);
        } else {
          setNumbers(prev => prev.map(n => n.id === id ? { ...n, status: data.status } : n));
        }
      } catch { /* ignore */ }
      if (attempts >= 40) clearInterval(pollRef.current[id]); // ~80s
    }, 2000);
  }

  async function handleAdd() {
    const label = newLabel.trim();
    if (!label) return;
    setAdding(true);
    try {
      const { data } = await api.post('/api/whatsapp-qr/numbers', { label });
      setNumbers(prev => [...prev, data]);
      setNewLabel('');
    } catch { toast('Erro ao adicionar número', 'error'); }
    finally { setAdding(false); }
  }

  async function handleConnect(id: string) {
    setNumbers(prev => prev.map(n => n.id === id ? { ...n, status: 'connecting' } : n));
    try {
      await api.post(`/api/whatsapp-qr/numbers/${id}/connect`);
      pollNumber(id);
    } catch { toast('Erro ao iniciar conexão', 'error'); }
  }

  async function handleDisconnect(id: string) {
    try {
      await api.post(`/api/whatsapp-qr/numbers/${id}/disconnect`);
      setNumbers(prev => prev.map(n => n.id === id ? { ...n, status: 'disconnected', phone: null } : n));
      setQrByNumber(prev => { const c = { ...prev }; delete c[id]; return c; });
      toast('WhatsApp desconectado');
    } catch { toast('Erro ao desconectar', 'error'); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Remover este número? As conversas continuam salvas, mas ele deixa de enviar/receber.')) return;
    try {
      await api.delete(`/api/whatsapp-qr/numbers/${id}`);
      setNumbers(prev => prev.filter(n => n.id !== id));
    } catch { toast('Erro ao remover', 'error'); }
  }

  async function handleRename(id: string) {
    const label = editLabel.trim();
    if (!label) { setEditing(null); return; }
    try {
      await api.patch(`/api/whatsapp-qr/numbers/${id}`, { label });
      setNumbers(prev => prev.map(n => n.id === id ? { ...n, label } : n));
    } catch { toast('Erro ao renomear', 'error'); }
    finally { setEditing(null); }
  }

  const statusMeta: Record<QRStatus, { label: string; color: string; dot: string }> = {
    disconnected: { label: 'Desconectado', color: 'text-slate-400', dot: 'bg-slate-300' },
    connecting:   { label: 'Conectando...', color: 'text-amber-500', dot: 'bg-amber-400' },
    qr_ready:     { label: 'Escaneie o QR', color: 'text-blue-500', dot: 'bg-blue-400' },
    connected:    { label: 'Conectado', color: 'text-green-600', dot: 'bg-green-500' },
  };

  return (
    <div className="space-y-4">
      {/* Info */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <div className="flex items-start gap-2">
          <Info size={15} className="text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-amber-700">
            <p className="font-semibold mb-1">Vários números via QR Code</p>
            <p>Conecte quantos números de WhatsApp Business quiser, cada um com um apelido (ex: Vendas, Suporte). Cada conversa fica ligada ao número que a recebeu — ao responder, sai automaticamente por esse mesmo número.</p>
          </div>
        </div>
      </div>

      {/* Adicionar número */}
      <div className="flex items-center gap-2">
        <input
          value={newLabel}
          onChange={e => setNewLabel(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
          placeholder="Apelido do número (ex: Vendas)"
          className="flex-1 px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newLabel.trim()}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
          style={{ backgroundColor: '#075e54' }}
        >
          <Plus size={15} /> Adicionar
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400 py-6 text-center">Carregando...</p>
      ) : numbers.length === 0 ? (
        <p className="text-sm text-slate-400 py-6 text-center">Nenhum número ainda. Adicione um apelido acima e clique em Adicionar.</p>
      ) : (
        <div className="space-y-3">
          {numbers.map(n => {
            const meta = statusMeta[n.status] || statusMeta.disconnected;
            const qr = qrByNumber[n.id];
            return (
              <div key={n.id} className="bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden">
                <div className="flex items-center gap-3 px-5 py-3 border-b border-af-border">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: '#075e54' }}>
                    <QrCode size={18} className="text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    {editing === n.id ? (
                      <div className="flex items-center gap-1">
                        <input
                          autoFocus
                          value={editLabel}
                          onChange={e => setEditLabel(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleRename(n.id); if (e.key === 'Escape') setEditing(null); }}
                          className="text-sm border border-af-border rounded px-2 py-0.5 w-40 focus:outline-none"
                        />
                        <button onClick={() => handleRename(n.id)} className="text-green-600 text-xs">✓</button>
                        <button onClick={() => setEditing(null)} className="text-slate-400 text-xs"><XIcon size={13} /></button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-semibold text-slate-800 truncate">{n.label}</p>
                        <button onClick={() => { setEditing(n.id); setEditLabel(n.label); }} className="text-slate-300 hover:text-af-mid">
                          <Pencil size={11} />
                        </button>
                      </div>
                    )}
                    <p className="text-xs text-slate-400">{n.phone ? `+${n.phone}` : 'Número não conectado'}</p>
                  </div>
                  <span className={`flex items-center gap-1.5 text-xs font-medium ${meta.color}`}>
                    <span className={`w-2 h-2 rounded-full ${meta.dot}`} /> {meta.label}
                  </span>
                </div>

                {departments.length > 0 && (
                  <div className="flex items-center gap-2 px-5 py-2.5 border-b border-af-border bg-slate-50/60">
                    <Building2 size={13} className="text-slate-400 flex-shrink-0" />
                    <label className="text-xs text-slate-500 flex-shrink-0">Setor:</label>
                    <select
                      value={n.departmentId || ''}
                      onChange={e => handleChangeDepartment(n.id, e.target.value)}
                      className="flex-1 text-xs border border-af-border rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-af-accent"
                    >
                      <option value="">Sem setor (visível pra todo mundo)</option>
                      {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                )}

                <div className="px-5 py-4">
                  {qr && (
                    <div className="flex flex-col items-center py-2 mb-3">
                      <p className="text-xs font-semibold text-slate-600 mb-2 text-center">
                        Abra o WhatsApp → Dispositivos conectados → Conectar dispositivo
                      </p>
                      <div className="p-3 bg-white border-4 border-[#075e54] rounded-2xl shadow">
                        <img src={qr} alt="QR Code" className="w-48 h-48" />
                      </div>
                      <p className="text-[11px] text-slate-400 mt-2">O QR expira em ~60s; se sumir, clique em Conectar de novo</p>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    {n.status === 'connected' ? (
                      <button onClick={() => handleDisconnect(n.id)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-red-200 text-red-600 text-xs hover:bg-red-50">
                        <WifiOff size={13} /> Desconectar
                      </button>
                    ) : (
                      <button onClick={() => handleConnect(n.id)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white text-xs font-medium" style={{ backgroundColor: '#075e54' }}>
                        {n.status === 'connecting' || n.status === 'qr_ready'
                          ? <><RefreshCw size={13} className="animate-spin" /> {n.status === 'qr_ready' ? 'Aguardando leitura' : 'Gerando QR...'}</>
                          : <><QrCode size={13} /> Conectar via QR</>}
                      </button>
                    )}
                    <button onClick={() => handleDelete(n.id)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-af-border text-slate-500 text-xs hover:bg-slate-50 ml-auto">
                      <Trash2 size={13} /> Remover
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Aba Departamentos ───────────────────────────────────────────────────────
// Setores/linhas de negócio (ex: Financiamento Habitacional, Consórcio) —
// cada colaborador não-admin enxerga só o funil, inbox, tarefas e dashboard
// do PRÓPRIO setor. Atribua o setor de cada colaborador em Usuários, e o
// setor de cada número de WhatsApp aqui na aba QR Code.

interface DepartmentRow { id: string; name: string; order: number; aiScope?: string | null; }

function DepartmentsTab() {
  const [departments, setDepartments] = useState<DepartmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  // Escopo de produtos que a IA do WhatsApp atende neste setor (edição inline)
  const [editingScope, setEditingScope] = useState<string | null>(null);
  const [editScopeText, setEditScopeText] = useState('');
  const [savingScope, setSavingScope] = useState(false);

  async function load() {
    try {
      const { data } = await api.get('/api/departments');
      setDepartments(data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setAdding(true);
    try {
      const { data } = await api.post('/api/departments', { name });
      setDepartments(prev => [...prev, data]);
      setNewName('');
    } catch { toast('Erro ao criar departamento', 'error'); }
    finally { setAdding(false); }
  }

  async function handleRename(id: string) {
    const name = editName.trim();
    if (!name) { setEditing(null); return; }
    try {
      await api.patch(`/api/departments/${id}`, { name });
      setDepartments(prev => prev.map(d => d.id === id ? { ...d, name } : d));
    } catch { toast('Erro ao renomear', 'error'); }
    finally { setEditing(null); }
  }

  async function handleDelete(id: string) {
    if (!confirm('Excluir este departamento?')) return;
    try {
      await api.delete(`/api/departments/${id}`);
      setDepartments(prev => prev.filter(d => d.id !== id));
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao excluir departamento', 'error');
    }
  }

  async function handleSaveScope(id: string) {
    setSavingScope(true);
    try {
      const { data } = await api.patch(`/api/departments/${id}`, { aiScope: editScopeText.trim() });
      setDepartments(prev => prev.map(d => d.id === id ? { ...d, aiScope: data.aiScope } : d));
      setEditingScope(null);
      toast('Escopo da IA atualizado.');
    } catch { toast('Erro ao salvar escopo da IA', 'error'); }
    finally { setSavingScope(false); }
  }

  return (
    <div className="space-y-4">
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
        <div className="flex items-start gap-2">
          <Info size={15} className="text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-amber-700">
            <p className="font-semibold mb-1">Setores / linhas de negócio</p>
            <p>Cada colaborador enxerga só o funil, a Inbox, as tarefas e o dashboard do PRÓPRIO setor. Você (admin) sempre vê tudo. Atribua o setor de cada colaborador em Usuários, e o setor de cada número de WhatsApp na aba QR Code.</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
          placeholder="Nome do novo setor (ex: Cartão de Crédito)"
          className="flex-1 px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newName.trim()}
          className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
          style={{ backgroundColor: '#075e54' }}
        >
          <Plus size={15} /> Adicionar
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-slate-400 py-6 text-center">Carregando...</p>
      ) : (
        <div className="bg-white rounded-2xl border border-af-border shadow-sm divide-y divide-af-border overflow-hidden">
          {departments.map(d => (
            <div key={d.id} className="px-5 py-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-af-light flex items-center justify-center flex-shrink-0">
                  <Building2 size={15} className="text-af-mid" />
                </div>
                {editing === d.id ? (
                  <div className="flex-1 flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRename(d.id); if (e.key === 'Escape') setEditing(null); }}
                      className="flex-1 text-sm border border-af-border rounded px-2 py-1 focus:outline-none"
                    />
                    <button onClick={() => handleRename(d.id)} className="text-green-600 text-xs px-1">✓</button>
                    <button onClick={() => setEditing(null)} className="text-slate-400 text-xs px-1"><XIcon size={13} /></button>
                  </div>
                ) : (
                  <>
                    <p className="flex-1 text-sm font-medium text-slate-800">{d.name}</p>
                    <button onClick={() => { setEditing(d.id); setEditName(d.name); }} className="text-slate-300 hover:text-af-mid">
                      <Pencil size={13} />
                    </button>
                    <button onClick={() => handleDelete(d.id)} className="text-slate-300 hover:text-red-500">
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>

              {/* Escopo de produtos que a IA do WhatsApp atende neste setor */}
              <div className="pl-11 mt-1.5">
                {editingScope === d.id ? (
                  <div className="flex items-start gap-1.5">
                    <textarea
                      autoFocus
                      value={editScopeText}
                      onChange={e => setEditScopeText(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Escape') setEditingScope(null); }}
                      placeholder="ex.: financiamento habitacional, home equity, financiamento para construção"
                      rows={2}
                      className="flex-1 text-xs border border-af-border rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-af-accent resize-none"
                    />
                    <button onClick={() => handleSaveScope(d.id)} disabled={savingScope} className="text-green-600 text-xs px-1 mt-1">✓</button>
                    <button onClick={() => setEditingScope(null)} className="text-slate-400 text-xs px-1 mt-1"><XIcon size={13} /></button>
                  </div>
                ) : (
                  <button
                    onClick={() => { setEditingScope(d.id); setEditScopeText(d.aiScope || ''); }}
                    className="text-left text-xs text-slate-400 hover:text-af-mid flex items-start gap-1 group"
                  >
                    <Bot size={12} className="mt-0.5 flex-shrink-0" />
                    <span className="group-hover:underline">
                      {d.aiScope ? <><span className="text-slate-500">Produtos que a IA atende:</span> {d.aiScope}</> : 'Definir produtos que a IA atende neste setor…'}
                    </span>
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Aba API Oficial ─────────────────────────────────────────────────────────
// Um número da API Oficial por DEPARTAMENTO agora (ex: Financiamento
// Habitacional e Consórcio podem ter cada um o seu). O seletor no topo troca
// qual configuração está sendo vista/editada — cada chamada leva o
// departmentId escolhido.

interface WADepartmentOption { id: string; name: string; }

function ApiOficialTab() {
  const [departments, setDepartments] = useState<WADepartmentOption[]>([]);
  const [apiDepartmentId, setApiDepartmentId] = useState(''); // '' = config "genérica"/única

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
  // Ativação (registro) do número na Cloud API com o PIN de 2 etapas
  const [regPin, setRegPin] = useState('');
  const [regCode, setRegCode] = useState('');
  const [sendingCode, setSendingCode] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [wabaId, setWabaId] = useState('');
  const [subscribing, setSubscribing] = useState(false);

  useEffect(() => {
    api.get('/api/departments').then(({ data }) => setDepartments(data)).catch(() => {});
  }, []);

  function loadConfig(departmentId: string) {
    setLoadingConfig(true);
    const qs = departmentId ? `?departmentId=${departmentId}` : '';
    api.get(`/api/settings/whatsapp${qs}`).then(({ data }) => {
      if (data) { setConfig(data); setIsNew(false); }
      else { setConfig({ phoneNumberId: '', accessToken: '', verifyToken: 'af_crm_verify', active: false, webhookUrl: '' }); setIsNew(true); }
    }).catch(() => {}).finally(() => setLoadingConfig(false));
  }

  // Recarrega sempre que troca de setor.
  useEffect(() => { loadConfig(apiDepartmentId); }, [apiDepartmentId]);

  async function handleSaveAPI(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/api/settings/whatsapp', {
        phoneNumberId: config.phoneNumberId,
        accessToken: config.accessToken,
        verifyToken: config.verifyToken,
        active: config.active,
        departmentId: apiDepartmentId || undefined,
      });
      toast('Configurações salvas!');
      setIsNew(false);
      loadConfig(apiDepartmentId); // recarrega para mostrar a URL do Webhook
    } catch {
      toast('Erro ao salvar configurações', 'error');
    } finally {
      setSaving(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    toast('Copiado!');
  }

  return (
    <div className="space-y-3">
      {departments.length > 0 && (
        <div className="flex items-center gap-2 bg-white rounded-2xl border border-af-border shadow-sm px-4 py-3">
          <Building2 size={15} className="text-slate-400 flex-shrink-0" />
          <label className="text-sm text-slate-600 flex-shrink-0">Número da API Oficial de:</label>
          <select
            value={apiDepartmentId}
            onChange={(e) => setApiDepartmentId(e.target.value)}
            className="flex-1 text-sm border border-af-border rounded-lg px-2 py-1.5 bg-white text-slate-700 focus:outline-none focus:ring-2 focus:ring-af-accent"
          >
            <option value="">Genérica (sem setor específico)</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      )}

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
                    const qs = apiDepartmentId ? `?departmentId=${apiDepartmentId}` : '';
                    const { data } = await api.get(`/api/settings/whatsapp/test${qs}`);
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

            {/* Ativar (registrar) o número na Cloud API */}
            <div className="p-4 bg-amber-50 rounded-xl border border-amber-200 space-y-3">
              <div>
                <p className="text-sm font-semibold text-amber-800">Ativar número (registrar na Cloud API)</p>
                <p className="text-xs text-amber-700 mt-0.5">Se o número estiver <strong>Offline</strong> na Meta. Salve o Phone Number ID e o Access Token acima antes. Se a Meta pedir reverificação, envie o código por SMS.</p>
              </div>

              {/* Passo 1: enviar código (quando a Meta pede reverificação) */}
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-amber-800 w-5 flex-shrink-0">1.</span>
                <button
                  type="button"
                  disabled={sendingCode}
                  onClick={async () => {
                    setSendingCode(true);
                    try {
                      const { data } = await api.post('/api/settings/whatsapp/request-code', { method: 'SMS', departmentId: apiDepartmentId || undefined });
                      if (data.ok) toast('📩 Código enviado por SMS para o número.', 'success');
                      else toast(`❌ ${data.error}`, 'error');
                    } catch {
                      toast('Erro ao enviar o código', 'error');
                    } finally {
                      setSendingCode(false);
                    }
                  }}
                  className="px-3 py-2 rounded-lg border border-amber-400 text-amber-800 text-sm font-medium hover:bg-amber-100 disabled:opacity-50 whitespace-nowrap"
                >
                  {sendingCode ? 'Enviando...' : 'Enviar código (SMS)'}
                </button>
                <span className="text-xs text-amber-700">só se a Meta pedir reverificação (erro 133006)</span>
              </div>

              {/* Passo 2: código (opcional) + PIN novo + ativar */}
              <div className="flex items-start gap-2">
                <span className="text-xs font-semibold text-amber-800 w-5 flex-shrink-0 pt-2">2.</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={regCode}
                  onChange={(e) => setRegCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  placeholder="Código SMS (se pedido)"
                  className="w-40 px-3 py-2 text-sm border border-amber-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={regPin}
                  onChange={(e) => setRegPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="PIN novo (6 dígitos)"
                  className="flex-1 px-3 py-2 text-sm border border-amber-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-amber-400"
                />
                <button
                  type="button"
                  disabled={registering || regPin.length !== 6}
                  onClick={async () => {
                    setRegistering(true);
                    try {
                      // Com código → verifica e ativa; sem código → só registra.
                      const url = regCode ? '/api/settings/whatsapp/verify-code' : '/api/settings/whatsapp/register';
                      const body: Record<string, unknown> = regCode ? { code: regCode, pin: regPin } : { pin: regPin };
                      if (apiDepartmentId) body.departmentId = apiDepartmentId;
                      const { data } = await api.post(url, body);
                      if (data.ok) {
                        toast('✅ Número ativado! Agora teste a conexão.', 'success');
                        setRegPin(''); setRegCode('');
                      } else {
                        toast(`❌ ${data.error}`, 'error');
                      }
                    } catch {
                      toast('Erro ao ativar o número', 'error');
                    } finally {
                      setRegistering(false);
                    }
                  }}
                  className="px-4 py-2 rounded-lg bg-amber-500 text-white text-sm font-semibold hover:bg-amber-600 disabled:opacity-50 whitespace-nowrap"
                >
                  {registering ? 'Ativando...' : 'Ativar número'}
                </button>
              </div>
            </div>

            {/* Ativar recebimento — inscreve o app na WABA (subscribed_apps) */}
            <div className="p-4 bg-blue-50 rounded-xl border border-blue-200 space-y-2">
              <div>
                <p className="text-sm font-semibold text-blue-800">Ativar recebimento (webhook)</p>
                <p className="text-xs text-blue-700 mt-0.5">Se você envia mas as mensagens não chegam na Inbox, inscreva o app na conta do WhatsApp Business. Cole o <strong>ID da conta do WhatsApp Business (WABA)</strong> — na Meta aparece como "Identificação da conta do WhatsApp Business".</p>
              </div>
              <div className="flex gap-2">
                <input
                  type="text"
                  inputMode="numeric"
                  value={wabaId}
                  onChange={(e) => setWabaId(e.target.value.replace(/\D/g, ''))}
                  placeholder="ID da conta do WhatsApp Business (WABA)"
                  className="flex-1 px-3 py-2 text-sm border border-blue-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
                <button
                  type="button"
                  disabled={subscribing || wabaId.length < 6}
                  onClick={async () => {
                    setSubscribing(true);
                    try {
                      const { data } = await api.post('/api/settings/whatsapp/subscribe-waba', { wabaId, departmentId: apiDepartmentId || undefined });
                      if (data.ok) toast('✅ Recebimento ativado! Agora as mensagens chegam na Inbox.', 'success');
                      else toast(`❌ ${data.error}`, 'error');
                    } catch {
                      toast('Erro ao ativar o recebimento', 'error');
                    } finally {
                      setSubscribing(false);
                    }
                  }}
                  className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
                >
                  {subscribing ? 'Ativando...' : 'Ativar recebimento'}
                </button>
              </div>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── Aba Google Drive ───────────────────────────────────────────────────────

interface DriveFolder { id: string; name: string; }

function ArchiveOldAttachmentsButton() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ archived: number; errors: number; leads: number } | null>(null);

  async function handleArchive() {
    if (!confirm('Arquivar agora todos os anexos antigos no Drive? Pode levar alguns minutos, dependendo da quantidade.')) return;
    setRunning(true);
    setResult(null);
    try {
      const { data } = await api.post('/api/google/archive-old-attachments');
      setResult(data);
      toast(`Arquivamento concluído: ${data.archived} anexo(s) em ${data.leads} cliente(s).`);
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao arquivar anexos antigos', 'error');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <button
        onClick={handleArchive}
        disabled={running}
        className="text-xs px-3 py-1.5 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 disabled:opacity-50"
      >
        {running ? 'Arquivando…' : 'Arquivar anexos antigos agora'}
      </button>
      {result && (
        <p className="text-xs text-slate-400 mt-1.5">
          {result.archived} anexo(s) arquivado(s) em {result.leads} cliente(s)
          {result.errors > 0 ? ` — ${result.errors} falharam (tente de novo depois)` : ''}.
        </p>
      )}
    </div>
  );
}

function GoogleDriveTab() {
  const [status, setStatus] = useState<{ connected: boolean; email: string | null; rootFolderId: string | null; rootFolderName: string | null; configured: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  // navegação de pastas para escolher a raiz
  const [browsing, setBrowsing] = useState(false);
  const [folders, setFolders] = useState<DriveFolder[]>([]);
  const [path, setPath] = useState<{ id: string; name: string }[]>([]); // breadcrumb (id 'root' = Meu Drive)
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [folderLinkInput, setFolderLinkInput] = useState('');
  const [settingByLink, setSettingByLink] = useState(false);

  async function loadStatus() {
    try { const { data } = await api.get('/api/google/status'); setStatus(data); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  }
  useEffect(() => { loadStatus(); }, []);

  // recebe aviso do popup de OAuth
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.data?.type === 'google-oauth') { setTimeout(loadStatus, 500); }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  async function handleConnect() {
    try {
      const { data } = await api.get('/api/google/oauth/start');
      window.open(data.url, 'google-oauth', 'width=520,height=680');
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao iniciar conexão com o Google', 'error');
    }
  }

  async function handleDisconnect() {
    if (!confirm('Desconectar o Google Drive?')) return;
    await api.post('/api/google/disconnect');
    loadStatus();
  }

  async function openBrowser(parent?: { id: string; name: string }) {
    setBrowsing(true);
    setLoadingFolders(true);
    const newPath = parent
      ? (parent.id === 'root' ? [{ id: 'root', name: 'Meu Drive' }] : [...path, parent])
      : [{ id: 'root', name: 'Meu Drive' }];
    if (!parent) setPath([{ id: 'root', name: 'Meu Drive' }]);
    else setPath(newPath);
    try {
      const parentId = parent?.id === 'root' || !parent ? undefined : parent.id;
      const { data } = await api.get('/api/google/folders', { params: parentId ? { parent: parentId } : {} });
      setFolders(data);
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao listar pastas', 'error');
    } finally { setLoadingFolders(false); }
  }

  async function goToCrumb(index: number) {
    const target = path[index];
    setPath(path.slice(0, index + 1));
    setLoadingFolders(true);
    try {
      const parentId = target.id === 'root' ? undefined : target.id;
      const { data } = await api.get('/api/google/folders', { params: parentId ? { parent: parentId } : {} });
      setFolders(data);
    } catch { /* ignore */ } finally { setLoadingFolders(false); }
  }

  async function chooseCurrentFolder() {
    const current = path[path.length - 1];
    await api.post('/api/google/root-folder', { folderId: current.id, folderName: current.name });
    setBrowsing(false);
    loadStatus();
    toast('Pasta-raiz definida!');
  }

  async function handleSetFolderByLink() {
    if (!folderLinkInput.trim()) return;
    setSettingByLink(true);
    try {
      const { data } = await api.post('/api/google/root-folder', { folderLink: folderLinkInput.trim() });
      setFolderLinkInput('');
      loadStatus();
      toast(`Pasta-raiz definida: ${data.folderName}!`);
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Não consegui usar esse link — confira se é uma pasta do Drive', 'error');
    } finally {
      setSettingByLink(false);
    }
  }

  if (loading) return <p className="text-sm text-slate-400 py-6 text-center">Carregando...</p>;

  if (status && !status.configured) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700">
        A integração do Google ainda não está configurada no servidor (faltam as credenciais). Avise o suporte técnico.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-af-border shadow-sm overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-af-border">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 bg-gradient-to-br from-blue-500 to-green-500">
            <HardDrive size={20} className="text-white" />
          </div>
          <div className="flex-1">
            <h2 className="text-sm font-bold text-slate-800">Google Drive</h2>
            <p className="text-xs text-slate-400">Criar pastas de clientes, renomear e salvar documentos automaticamente</p>
          </div>
          {status?.connected ? (
            <span className="flex items-center gap-1.5 text-xs font-medium text-green-600">
              <span className="w-2 h-2 rounded-full bg-green-500" /> Conectado
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <span className="w-2 h-2 rounded-full bg-slate-300" /> Desconectado
            </span>
          )}
        </div>

        <div className="px-5 py-4 space-y-4">
          {!status?.connected ? (
            <button onClick={handleConnect} className="flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-medium" style={{ backgroundColor: '#2261a8' }}>
              <HardDrive size={15} /> Conectar Google Drive
            </button>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="text-xs text-slate-500">Conta conectada: <span className="font-medium text-slate-700">{status.email || '—'}</span></div>
                <button onClick={handleDisconnect} className="text-xs text-red-500 hover:text-red-600">Desconectar</button>
              </div>

              <div className="border-t border-af-border pt-4">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Pasta-raiz dos clientes</p>
                <p className="text-xs text-slate-400 mb-2">É a pasta onde o agente vai criar as pastas de cada cliente.</p>
                {status.rootFolderName ? (
                  <div className="flex items-center gap-2 text-sm text-slate-700 mb-2">
                    <FolderOpen size={15} className="text-af-mid" /> {status.rootFolderName}
                  </div>
                ) : (
                  <p className="text-xs text-amber-600 mb-2">Nenhuma pasta-raiz definida ainda.</p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={() => openBrowser()} className="text-xs px-3 py-1.5 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50">
                    {status.rootFolderName ? 'Trocar pasta' : 'Escolher pasta'}
                  </button>
                  <span className="text-xs text-slate-300">ou</span>
                  <input
                    value={folderLinkInput}
                    onChange={(e) => setFolderLinkInput(e.target.value)}
                    placeholder="Cole o link da pasta do Drive"
                    className="text-xs px-2.5 py-1.5 rounded-lg border border-af-border flex-1 min-w-[200px] focus:outline-none focus:ring-1 focus:ring-af-accent"
                  />
                  <button
                    onClick={handleSetFolderByLink}
                    disabled={!folderLinkInput.trim() || settingByLink}
                    className="text-xs px-3 py-1.5 rounded-lg text-white font-medium disabled:opacity-50"
                    style={{ backgroundColor: '#2261a8' }}
                  >
                    {settingByLink ? 'Definindo…' : 'Usar este link'}
                  </button>
                </div>
              </div>

              {status.rootFolderName && (
                <div className="border-t border-af-border pt-4">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1">Anexos do WhatsApp</p>
                  <p className="text-xs text-slate-400 mb-2">
                    Fotos e documentos recebidos/enviados agora sobem direto para o Drive (não ficam guardados no banco).
                    Use o botão abaixo uma vez para arquivar os que já estavam salvos de antes.
                  </p>
                  <ArchiveOldAttachmentsButton />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Navegador de pastas */}
      {browsing && (
        <div className="bg-white rounded-2xl border border-af-border shadow-sm p-4">
          <div className="flex items-center gap-1 text-xs text-slate-500 mb-3 flex-wrap">
            {path.map((c, i) => (
              <span key={c.id} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={12} className="text-slate-300" />}
                <button onClick={() => goToCrumb(i)} className="hover:text-af-mid">{c.name}</button>
              </span>
            ))}
          </div>
          <div className="max-h-64 overflow-y-auto scrollbar-thin border border-af-border rounded-lg divide-y divide-slate-100">
            {loadingFolders ? (
              <p className="text-xs text-slate-400 py-4 text-center">Carregando pastas...</p>
            ) : folders.length === 0 ? (
              <p className="text-xs text-slate-400 py-4 text-center">Nenhuma subpasta aqui</p>
            ) : folders.map(f => (
              <button key={f.id} onClick={() => openBrowser(f)} className="w-full flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 text-left">
                <Folder size={15} className="text-af-mid flex-shrink-0" /> <span className="flex-1 truncate">{f.name}</span>
                <ChevronRight size={13} className="text-slate-300" />
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between mt-3">
            <button onClick={() => setBrowsing(false)} className="text-xs text-slate-400 hover:text-slate-600">Cancelar</button>
            <button onClick={chooseCurrentFolder} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg text-white font-medium" style={{ backgroundColor: '#2261a8' }}>
              <CheckCircle2 size={14} /> Usar "{path[path.length - 1]?.name}" como raiz
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


function AgenteTab() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api.get('/api/settings/agent')
      .then(({ data }) => { if (active) setPrompt(data.systemPrompt || ''); })
      .catch(() => toast('Erro ao carregar prompt do agente', 'error'))
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function handleSave() {
    if (!prompt.trim()) { toast('O prompt não pode ficar vazio', 'error'); return; }
    setSaving(true);
    try {
      await api.put('/api/settings/agent', { systemPrompt: prompt });
      toast('Prompt do agente salvo!');
    } catch {
      toast('Erro ao salvar prompt do agente', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-gradient-to-r from-purple-50 to-blue-50 border border-purple-200 rounded-xl p-4 flex items-start gap-3">
        <div className="p-2 bg-purple-100 rounded-lg flex-shrink-0">
          <Bot size={20} className="text-purple-600" />
        </div>
        <div>
          <p className="text-sm font-semibold text-purple-900">Agente interno (assistente dos colaboradores)</p>
          <p className="text-xs text-purple-700 mt-0.5">
            Esse é o prompt do assistente de IA que aparece no botão de chat dentro do CRM (canto inferior direito), usado pela sua equipe para tirar dúvidas, pedir ajuda e (conforme você for treinando) executar tarefas. Escreva aqui as instruções, o papel e os limites do agente — as mudanças valem para a próxima mensagem enviada por qualquer colaborador.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium text-slate-700">Prompt do agente</label>
          <span className="text-xs text-slate-400">{prompt.length} caracteres</span>
        </div>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          disabled={loading}
          rows={16}
          placeholder="Descreva o papel do agente, o que ele pode e não pode fazer, o tom de voz, e qualquer contexto sobre o processo da empresa..."
          className="w-full px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent font-mono leading-relaxed disabled:opacity-50"
        />
      </div>

      <button
        onClick={handleSave}
        disabled={saving || loading}
        className="px-4 py-2 bg-af-mid text-white text-sm font-semibold rounded-lg hover:bg-af-dark disabled:opacity-50 transition-colors"
      >
        {saving ? 'Salvando...' : 'Salvar prompt'}
      </button>

      <KnowledgeBasePanel />
    </div>
  );
}

interface KBFile { id: string; name: string; mimeType: string; status: string; chunkCount: number; error?: string | null; indexedAt?: string | null; }
interface KBStatus { voyageConfigured: boolean; folderId: string | null; folderName: string | null; files: KBFile[]; totalChunks: number; }

function KnowledgeBasePanel() {
  const [status, setStatus] = useState<KBStatus | null>(null);
  const [folder, setFolder] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingFolder, setSavingFolder] = useState(false);
  const [syncing, setSyncing] = useState(false);

  async function load() {
    try {
      const { data } = await api.get('/api/knowledge/status');
      setStatus(data);
    } catch {
      toast('Erro ao carregar a base de conhecimento', 'error');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function saveFolder() {
    if (!folder.trim()) { toast('Cole o link da pasta do Drive', 'error'); return; }
    setSavingFolder(true);
    try {
      await api.put('/api/knowledge/folder', { folder });
      toast('Pasta salva!');
      setFolder('');
      await load();
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao salvar a pasta', 'error');
    } finally {
      setSavingFolder(false);
    }
  }

  async function sync() {
    setSyncing(true);
    try {
      const { data } = await api.post('/api/knowledge/sync');
      toast(`Sincronizado: ${data.indexed} indexado(s), ${data.skipped} em dia, ${data.removed} removido(s)${data.failed ? `, ${data.failed} com erro` : ''}.`);
      await load();
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Erro ao sincronizar', 'error');
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="mt-8 pt-6 border-t border-af-border space-y-4">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-emerald-100 rounded-lg flex-shrink-0"><HardDrive size={20} className="text-emerald-600" /></div>
        <div>
          <p className="text-sm font-semibold text-slate-800">Base de conhecimento (treinamento)</p>
          <p className="text-xs text-slate-500 mt-0.5">
            Aponte uma pasta do Google Drive com os documentos de treinamento (processos, passo a passo, normativos). O assistente passa a responder com base neles.
            <strong className="text-slate-700"> Coloque só material genérico da empresa — nunca CPF ou dados de cliente.</strong>
          </p>
        </div>
      </div>

      {status && !status.voyageConfigured && (
        <div className="flex items-center gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          <Info size={14} /> A busca inteligente está desligada: falta definir a chave <code className="font-mono">VOYAGE_API_KEY</code> no servidor.
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-600">Pasta do Drive (cole o link)</label>
        <div className="flex gap-2">
          <input
            value={folder}
            onChange={e => setFolder(e.target.value)}
            placeholder={status?.folderId ? 'Trocar a pasta...' : 'https://drive.google.com/drive/folders/...'}
            className="flex-1 px-3 py-2 text-sm border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent"
          />
          <button onClick={saveFolder} disabled={savingFolder} className="px-3 py-2 bg-slate-100 text-slate-700 text-sm font-medium rounded-lg hover:bg-slate-200 disabled:opacity-50">
            {savingFolder ? 'Salvando...' : 'Salvar pasta'}
          </button>
        </div>
        {status?.folderId && (
          <p className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
            <Folder size={12} /> Pasta atual: <span className="font-medium">{status.folderName || status.folderId}</span>
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={sync}
          disabled={syncing || !status?.folderId || !status?.voyageConfigured}
          className="inline-flex items-center gap-2 px-4 py-2 bg-af-mid text-white text-sm font-semibold rounded-lg hover:bg-af-dark disabled:opacity-50 transition-colors"
        >
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Sincronizando...' : 'Sincronizar base'}
        </button>
        {status && status.files.length > 0 && (
          <span className="text-xs text-slate-500">{status.files.length} arquivo(s) · {status.totalChunks} trechos indexados</span>
        )}
      </div>

      {loading ? (
        <p className="text-xs text-slate-400">Carregando...</p>
      ) : status && status.files.length > 0 ? (
        <div className="border border-af-border rounded-lg divide-y divide-slate-100 overflow-hidden">
          {status.files.map(f => (
            <div key={f.id} className="px-3 py-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="truncate text-slate-700">{f.name}</span>
                <span className="flex items-center gap-2 flex-shrink-0 ml-3">
                  {f.status === 'indexed' ? (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 size={12} /> {f.chunkCount} trechos</span>
                  ) : f.status === 'error' ? (
                    <span className="inline-flex items-center gap-1 text-xs text-red-600"><XCircle size={12} /> erro</span>
                  ) : (
                    <span className="text-xs text-slate-400">pendente</span>
                  )}
                </span>
              </div>
              {f.status === 'error' && f.error && (
                <p className="text-xs text-red-500 mt-1 leading-snug">{f.error}</p>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-slate-400">Nenhum arquivo indexado ainda. Defina a pasta e clique em Sincronizar.</p>
      )}
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
