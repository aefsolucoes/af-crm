'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2, FileText, Check, Ban, ExternalLink, X, Mic, Square, Send, RotateCcw, Play, Volume2 } from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth.store';
import { useOutboundCallStore } from '@/store/outbound-call.store';

/* "Jarvis" — o assistente do CRM em forma de BOLINHA (Fabio 29/10: "não precisa ter chat, só a bolinha mesmo, como se fosse uma Siri").
 * Toca na bolinha → ela ouve, o Claude raciocina com as ferramentas do CRM (routes/assistant.ts) e responde FALANDO (voz Matilda da ElevenLabs; a do navegador
 * de reserva). Ela é 3D e passeia pela tela enquanto conversa; parada, fica no canto. O que precisa de tela aparece num balãozinho ao lado dela:
 * confirmar/cancelar ação ("sim"/"não" falado também vale), gravador de áudio pro cliente, PDF da simulação, link pra tela aberta.
 * Ligação: confirmada, ela para de ouvir, abre a conversa e disca (quem fala é o colaborador). Lembretes ("me lembra de…") ela fala na hora.
 * O contexto da conversa fica só neste navegador e é esquecido depois de 2 h parado. */

type Attachment = { type: 'simulation'; id: string; banco: string; leadName: string } | { type: 'document'; leadId: string; source: 'att' | 'drive'; ref: string; fileName: string; mimeType: string };
type Pending = { id: string; descricao: string; estado?: 'PENDENTE' | 'FEITO' | 'CANCELADO' | 'ERRO'; resultado?: string };
type Nav = { path: string; label: string };
type AudioReq = { leadId: string; leadName: string };
type Msg = { role: 'user' | 'assistant'; content: string };
type Voz = 'off' | 'ouvindo' | 'pensando' | 'falando';
type CopyReq = { label: string; texto: string };
type Cartao = { fala?: string; disse?: string; pending?: Pending[]; attachments?: Attachment[]; nav?: Nav | null; audio?: AudioReq | null; copiar?: CopyReq[]; escolherVoz?: boolean };
type Voice = { id: string; nome: string; desc: string };
const VOZ_KEY = 'af_jarvis_voz';
const lerVoz = () => { try { return localStorage.getItem(VOZ_KEY) || ''; } catch { return ''; } };
const STORE_KEY = 'af_crm_jarvis_ctx';
const SPOKEN_KEY = 'af_crm_assistant_reminders_spoken';
const ORB = 64;
const MOVE_MS = 4200;

function load(): Msg[] {
  try { const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); return v && Date.now() - v.at < 2 * 3600_000 && Array.isArray(v.msgs) ? v.msgs.slice(-20) : []; } catch { return []; }
}
function save(msgs: Msg[]) { try { localStorage.setItem(STORE_KEY, JSON.stringify({ at: Date.now(), msgs: msgs.slice(-20) })); } catch { /* sem armazenamento: segue sem contexto */ } }
function spokenIds(): string[] { try { const v = JSON.parse(localStorage.getItem(SPOKEN_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function markSpoken(id: string) { try { localStorage.setItem(SPOKEN_KEY, JSON.stringify([...spokenIds(), id].slice(-100))); } catch { /* */ } }

const SIM = /^(sim|pode|pode sim|confirmo|confirma|confirmar|manda|pode mandar|faz|pode fazer|isso|ok|beleza|claro|liga|pode ligar)\b/i;
const NAO = /^(não|nao|cancela|cancelar|deixa|esquece|negativo)\b/i;
const FALHA_MIC = '\u0000falha';
const PARAR = /^(parar|para|para de ouvir|chega|encerrar|tchau|obrigado|valeu|só isso|é só isso)[.!]?$/i;

/** Bolinha 3D: esfera com luz, sombra e "plasma" girando dentro. Gira mais rápido pensando, pulsa falando, respira ouvindo. */
function Orb3D({ voz }: { voz: Voz }) {
  const ativo = voz !== 'off';
  return (
    <span className="relative block w-full h-full" style={{ perspective: 300 }}>
      <span className="absolute left-[12%] right-[12%] -bottom-[14%] h-[18%] rounded-[50%] bg-black/30 blur-[6px]" style={{ animation: 'jvShadow 3.6s ease-in-out infinite' }} />
      <span
        className="absolute inset-0 rounded-full overflow-hidden"
        style={{
          background: 'radial-gradient(circle at 32% 26%, #ffffff 0%, #c9e8ff 7%, #63b3ff 26%, #3a4fd6 55%, #1a0f5c 82%, #0b0730 100%)',
          boxShadow: `inset -9px -12px 20px rgba(5,3,30,.55), inset 7px 7px 16px rgba(255,255,255,.22), 0 0 ${ativo ? 34 : 18}px rgba(99,179,255,${ativo ? 0.7 : 0.45})`,
          animation: voz === 'falando' ? 'jvTalk .5s ease-in-out infinite alternate' : voz === 'ouvindo' ? 'jvBreath 1.8s ease-in-out infinite' : 'jvWobble 7s ease-in-out infinite',
        }}
      >
        <span className="absolute -inset-[30%] opacity-60 mix-blend-screen blur-[7px]" style={{ background: 'conic-gradient(from 0deg, transparent 0 15%, #a78bfa 25%, transparent 38%, #38bdf8 55%, transparent 68%, #f0abfc 82%, transparent 92%)', animation: `jvSpin ${voz === 'pensando' ? '1.2s' : voz === 'falando' ? '2.2s' : '6s'} linear infinite` }} />
        <span className="absolute -inset-[30%] opacity-45 mix-blend-screen blur-[9px]" style={{ background: 'conic-gradient(from 120deg, transparent 0 20%, #22d3ee 32%, transparent 45%, #818cf8 70%, transparent 85%)', animation: `jvSpin ${voz === 'pensando' ? '1.8s' : '9s'} linear infinite reverse` }} />
        <span className="absolute left-[18%] top-[12%] w-[38%] h-[26%] rounded-[50%] bg-white/70 blur-[5px]" />
        <span className="absolute left-[26%] top-[16%] w-[14%] h-[9%] rounded-[50%] bg-white blur-[1px]" />
        <span className="absolute inset-0 rounded-full" style={{ boxShadow: 'inset 0 -3px 6px rgba(167,139,250,.35)' }} />
      </span>
      <style>{`
        @keyframes jvSpin { to { transform: rotate(360deg); } }
        @keyframes jvTalk { from { transform: scale(.9); } to { transform: scale(1.08); } }
        @keyframes jvBreath { 0%,100% { transform: scale(.95); } 50% { transform: scale(1.03); } }
        @keyframes jvWobble { 0%,100% { transform: rotateX(0deg) rotateY(0deg) translateY(0); } 25% { transform: rotateX(10deg) rotateY(-12deg) translateY(-3px); } 50% { transform: rotateX(-5deg) rotateY(9deg) translateY(1px); } 75% { transform: rotateX(7deg) rotateY(5deg) translateY(-2px); } }
        @keyframes jvShadow { 0%,100% { transform: scaleX(1); opacity: .9; } 50% { transform: scaleX(.85); opacity: .6; } }
      `}</style>
    </span>
  );
}

/** Documento do cliente espelhado AQUI no balão (Fabio 29/10: "sem abrir telas reais"): foto ou PDF da conversa ou da pasta do Drive, baixado pelo CRM. */
function DocumentCard({ a }: { a: Extract<Attachment, { type: 'document' }> }) {
  const [url, setUrl] = useState('');
  const [erro, setErro] = useState('');
  const [grande, setGrande] = useState(false);
  useEffect(() => {
    let vivo = true; let u = '';
    api.get('/api/assistant/document', { params: { leadId: a.leadId, source: a.source, ref: a.ref }, responseType: 'blob' })
      .then((r) => { if (!vivo) return; u = URL.createObjectURL(r.data as Blob); setUrl(u); })
      .catch(() => { if (vivo) setErro('Não consegui carregar o documento'); });
    return () => { vivo = false; if (u) URL.revokeObjectURL(u); };
  }, [a.leadId, a.source, a.ref]);
  const pdf = a.mimeType === 'application/pdf';
  const nome = a.fileName.split('/').pop() || a.fileName;
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white p-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-slate-700"><FileText size={13} className="text-blue-500" /> <span className="truncate" title={a.fileName}>{nome}</span>
        <button onClick={() => setGrande((g) => !g)} className="ml-auto shrink-0 text-[11px] text-slate-400 hover:text-slate-600">{grande ? 'diminuir' : 'ampliar'}</button>
      </div>
      {erro && <div className="mt-1 text-red-600">{erro}</div>}
      {!url && !erro && <div className="mt-1 text-slate-500">Carregando…</div>}
      {url && (pdf
        ? <iframe src={url} title={nome} className={cn('mt-1.5 w-full rounded border border-slate-100', grande ? 'h-[70vh]' : 'h-72')} />
        : <img src={url} alt={nome} className={cn('mt-1.5 w-full rounded object-contain', grande ? 'max-h-[70vh]' : 'max-h-72')} />)}
    </div>
  );
}

function SimulationCard({ a }: { a: Extract<Attachment, { type: 'simulation' }> }) {
  const [st, setSt] = useState<{ status: string; detail?: string | null; hasPdf?: boolean } | null>(null);
  const [opening, setOpening] = useState(false);
  useEffect(() => {
    let vivo = true;
    let t: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const { data } = await api.get(`/api/assistant/simulation/${a.id}`);
        if (!vivo) return;
        setSt(data);
        if (['REQUESTED', 'RUNNING', 'READY'].includes(data.status)) t = setTimeout(tick, 5000);
      } catch { if (vivo) setSt({ status: 'ERRO' }); }
    };
    tick();
    return () => { vivo = false; if (t) clearTimeout(t); };
  }, [a.id]);
  async function abrir() {
    const w = window.open('', '_blank'); // abre já (antes do download) pra o navegador não bloquear a janela
    setOpening(true);
    try {
      const { data } = await api.get(`/api/assistant/simulation/${a.id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([data], { type: 'application/pdf' }));
      if (w) w.location.href = url; else window.location.href = url;
    } catch { w?.close(); toast('Não consegui abrir o PDF', 'error'); } finally { setOpening(false); }
  }
  const banco = a.banco === 'SANTANDER' ? 'Santander' : a.banco === 'INTER' ? 'Inter' : a.banco;
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white p-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-slate-700"><FileText size={13} className="text-red-500" /> Simulação {banco} — {a.leadName}</div>
      <div className="mt-1 text-slate-500">{!st ? 'Conferindo…' : st.hasPdf ? 'PDF pronto (só pra equipe).' : st.status === 'FAILED' || st.status === 'ERRO' ? `Não saiu: ${st.detail || 'erro ao gerar'}` : 'Gerando no portal do banco (1 a 2 min)…'}</div>
      {st?.hasPdf && <button onClick={abrir} disabled={opening} className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-[#2261a8] px-2.5 py-1 font-medium text-white hover:brightness-110 disabled:opacity-50">{opening ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} Abrir PDF</button>}
    </div>
  );
}

/** Gravador de áudio pro cliente: a pessoa grava com a própria voz, ouve e só sai no Enviar (mesmo envio da Inbox, convertido pra voz do WhatsApp no servidor). */
/** Texto pra copiar e encaminhar (ex.: PIX da certidão): o assistente não lê em voz alta, só mostra aqui. */
function CopyCard({ c }: { c: CopyReq }) {
  const [ok, setOk] = useState(false);
  async function copiar() {
    try { await navigator.clipboard.writeText(c.texto); setOk(true); setTimeout(() => setOk(false), 2500); } catch { /* sem permissão: dá pra selecionar o texto à mão */ }
  }
  return (
    <div className="mt-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2">
      <div className="text-[11px] font-medium text-emerald-300">{c.label}</div>
      <div className="mt-1 max-h-16 overflow-y-auto break-all rounded bg-black/30 p-1.5 font-mono text-[10px] leading-tight text-gray-200 select-all">{c.texto}</div>
      <button type="button" onClick={copiar} className="mt-1.5 w-full rounded-md bg-emerald-600 py-1 text-xs font-medium text-white hover:bg-emerald-500">{ok ? 'Copiado ✓' : 'Copiar'}</button>
    </div>
  );
}

/** Cada colaborador escolhe a voz do assistente (Fabio 29/10) — todas brasileiras; a escolha fica neste navegador. */
function VoicePicker({ atual, primeiroNome, onPick }: { atual: string; primeiroNome: string; onPick: (v: Voice) => void }) {
  const [vozes, setVozes] = useState<Voice[]>([]);
  const [tocando, setTocando] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => { api.get('/api/assistant/voices').then((r) => setVozes(r.data || [])).catch(() => setVozes([])); return () => { try { audio.current?.pause(); } catch { /* */ } }; }, []);
  async function ouvir(v: Voice) {
    try { audio.current?.pause(); } catch { /* */ }
    setTocando(v.id);
    try {
      const masc = /masculin/i.test(v.desc);
      const r = await api.post('/api/assistant/tts', { text: `Oi${primeiroNome ? `, ${primeiroNome}` : ''}! Eu sou ${masc ? 'o' : 'a'} ${v.nome}, ${masc ? 'seu assistente' : 'sua assistente'} aqui no CRM. É só tocar na bolinha e falar comigo.`, voiceId: v.id }, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data as Blob);
      const a = new Audio(url); audio.current = a;
      a.onended = () => { setTocando(''); URL.revokeObjectURL(url); };
      await a.play();
    } catch { setTocando(''); toast('Não consegui tocar a amostra', 'error'); }
  }
  return (
    <div className="mt-2 space-y-1.5">
      <p className="text-xs font-medium text-slate-600">Escolha a voz do seu assistente:</p>
      {!vozes.length && <Loader2 size={14} className="animate-spin text-slate-400" />}
      {vozes.map((v) => (
        <div key={v.id} className={cn('flex items-center gap-2 rounded-lg border px-2 py-1.5', v.id === atual ? 'border-emerald-400 bg-emerald-50' : 'border-slate-200')}>
          <button onClick={() => ouvir(v)} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-sky-600 text-white hover:brightness-110" title="Ouvir">{tocando === v.id ? <Volume2 size={13} className="animate-pulse" /> : <Play size={13} />}</button>
          <div className="min-w-0 flex-1 leading-tight"><div className="text-xs font-semibold text-slate-800">{v.nome}</div><div className="truncate text-[11px] text-slate-500">{v.desc}</div></div>
          <button onClick={() => { try { audio.current?.pause(); } catch { /* */ } onPick(v); }} className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-medium text-white hover:brightness-110">{v.id === atual ? 'Usando' : 'Escolher'}</button>
        </div>
      ))}
    </div>
  );
}

function RecorderCard({ req, onDone }: { req: AudioReq; onDone: (msg: string) => void }) {
  const [fase, setFase] = useState<'pronto' | 'gravando' | 'ouvir' | 'enviando'>('pronto');
  const [seg, setSeg] = useState(0);
  const [url, setUrl] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const blob = useRef<Blob | null>(null);
  const solta = () => { stream.current?.getTracks().forEach((t) => t.stop()); stream.current = null; if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  useEffect(() => () => solta(), []);
  async function gravar() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = s;
      const mime = ['audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported?.(t)) || '';
      const r = new MediaRecorder(s, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      r.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      r.onstop = () => { blob.current = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' }); setUrl(URL.createObjectURL(blob.current)); setFase('ouvir'); solta(); };
      r.start(); rec.current = r; setSeg(0); setFase('gravando');
      timer.current = setInterval(() => setSeg((x) => x + 1), 1000);
    } catch { toast('Não consegui acessar o microfone — verifique a permissão do navegador.', 'error'); }
  }
  async function enviar() {
    if (!blob.current) return;
    setFase('enviando');
    try {
      const mime = blob.current.type || 'audio/webm';
      const ext = mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm';
      const dataBase64 = await new Promise<string>((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(String(fr.result).split(',')[1] || ''); fr.onerror = reject; fr.readAsDataURL(blob.current!); });
      await api.post('/api/messages/send-media', { leadId: req.leadId, fileName: `audio-${Date.now()}.${ext}`, mimeType: mime, dataBase64, transcodeAudio: true });
      onDone(`Áudio enviado pro ${req.leadName}.`);
    } catch (err: any) { toast(err?.response?.data?.error || 'Erro ao enviar o áudio', 'error'); setFase('ouvir'); }
  }
  const mmss = `${Math.floor(seg / 60)}:${String(seg % 60).padStart(2, '0')}`;
  return (
    <div className="mt-2 rounded-lg border border-sky-200 bg-sky-50 p-2 text-xs">
      <div className="font-medium text-slate-700">Áudio pro {req.leadName}</div>
      {fase === 'pronto' && <button onClick={gravar} className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-red-500 px-2.5 py-1 font-medium text-white hover:brightness-110"><Mic size={12} /> Gravar</button>}
      {fase === 'gravando' && <div className="mt-1.5 flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" /> <span className="tabular-nums text-slate-600">{mmss}</span><button onClick={() => rec.current?.stop()} className="inline-flex items-center gap-1 rounded-md bg-slate-700 px-2.5 py-1 font-medium text-white"><Square size={11} /> Parar</button></div>}
      {(fase === 'ouvir' || fase === 'enviando') && (
        <div className="mt-1.5 space-y-1.5">
          <audio src={url} controls className="w-full h-8" />
          <div className="flex gap-1.5">
            <button onClick={enviar} disabled={fase === 'enviando'} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 font-medium text-white hover:brightness-110 disabled:opacity-50">{fase === 'enviando' ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Enviar</button>
            <button onClick={() => { setUrl(''); blob.current = null; setFase('pronto'); }} disabled={fase === 'enviando'} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-slate-600"><RotateCcw size={12} /> Regravar</button>
            <button onClick={() => onDone('Áudio cancelado.')} disabled={fase === 'enviando'} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-slate-600"><Ban size={12} /> Cancelar</button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CrmAssistant() {
  const pathname = usePathname();
  const router = useRouter();
  const userName = useAuthStore((s) => s.user?.name) || '';
  const primeiroNome = userName.split(/\s+/)[0] || '';
  const [voz, setVoz] = useState<Voz>('off');
  const [cartao, setCartao] = useState<Cartao | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const msgsRef = useRef<Msg[]>([]);
  const vozRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recRef = useRef<any>(null);
  const cartaoRef = useRef<Cartao | null>(null);
  const vozIdRef = useRef('');
  const [vozNome, setVozNome] = useState('');
  const vozNomeRef = useRef('');
  useEffect(() => { vozNomeRef.current = vozNome; }, [vozNome]);
  // Chamar pelo nome (Fabio 29/10: "somente o primeiro nome, sem ei"): desligado por padrão; ligado, um reconhecimento fica ouvindo (com o CRM aberto) e abre a conversa quando ouve o nome da voz escolhida.
  const WAKE_KEY = 'jv_chamar_nome';
  const [chamarPorNome, setChamarPorNome] = useState(false);
  const partidaRef = useRef('');
  useEffect(() => { try { setChamarPorNome(localStorage.getItem(WAKE_KEY) === '1'); } catch { /* */ } }, []);
  function alternaChamarPorNome() {
    const novo = !chamarPorNome; setChamarPorNome(novo);
    try { localStorage.setItem(WAKE_KEY, novo ? '1' : '0'); } catch { /* */ }
    toast(novo ? `Pronto: é só dizer "${vozNome || 'o nome da voz'}" (Chrome com o CRM aberto)` : 'Chamar pelo nome desligado', 'success');
  }
  useEffect(() => { vozIdRef.current = lerVoz(); try { setVozNome(localStorage.getItem(`${VOZ_KEY}_nome`) || ''); } catch { /* */ } }, []);
  const setCard = (c: Cartao | null) => { cartaoRef.current = c; setCartao(c); };

  useEffect(() => { msgsRef.current = load(); }, []);

  // ── posição: no canto quando parada; passeando pela tela enquanto conversa (para quando há algo pra clicar no balão) ──
  const canto = () => ({ x: window.innerWidth - ORB - 20, y: window.innerHeight - ORB - 84 });
  const precisaClique = !!(cartao?.pending?.some((p) => p.estado === 'PENDENTE') || cartao?.audio || cartao?.attachments?.length || cartao?.copiar?.length || cartao?.escolherVoz);
  const conversando = voz !== 'off';
  // Mouse em cima da bolinha ou do balão: ela PARA onde está pra pessoa olhar (Fabio 29/10); ao sair, volta a passear.
  const [mouseEm, setMouseEm] = useState(false);
  const orbRef = useRef<HTMLButtonElement | null>(null);
  const pressRef = useRef<{ t: ReturnType<typeof setTimeout> | null; abriu: boolean }>({ t: null, abriu: false });
  const segura = () => { const r = orbRef.current?.getBoundingClientRect(); if (r) setPos({ x: r.left, y: r.top }); setMouseEm(true); };
  const solta = () => setMouseEm(false);
  useEffect(() => {
    setPos(canto());
    const onR = () => { if (!vozRef.current) setPos(canto()); };
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);
  useEffect(() => {
    if (!conversando) { if (!precisaClique) setPos(canto()); return; }
    if (precisaClique || mouseEm) return;
    const passeia = () => {
      const w = window.innerWidth, h = window.innerHeight;
      setPos({ x: 260 + Math.random() * Math.max(40, w - 260 - ORB - 40), y: 90 + Math.random() * Math.max(40, h - 90 - ORB - 120) });
    };
    let t: ReturnType<typeof setInterval> | undefined;
    const primeiro = setTimeout(() => { passeia(); t = setInterval(passeia, MOVE_MS); }, 1200);
    return () => { clearTimeout(primeiro); if (t) clearInterval(t); };
  }, [conversando, precisaClique, mouseEm]);

  // ── voz ──
  function vozNavegador(frase: string): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(frase);
      u.lang = 'pt-BR'; u.rate = 1.05;
      const vs = window.speechSynthesis.getVoices();
      const v = vs.find((x) => x.lang?.toLowerCase().replace('_', '-') === 'pt-br') || vs.find((x) => /brasil|brazil|luciana|felipe/i.test(x.name)); // nunca pt-PT (Fabio 29/10: português do Brasil)
      if (v) u.voice = v;
      u.onend = () => resolve(); u.onerror = () => resolve();
      window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
    });
  }
  async function falar(frase: string): Promise<void> {
    const t = frase.replace(/[*_#`>⏰]/g, '').replace(/https?:\S+/g, '').trim();
    if (!t) return;
    setVoz('falando');
    try { audioRef.current?.pause(); } catch { /* */ }
    const soltaVigia = vigiarInterrupcao(t);
    try {
      const r = await api.post('/api/assistant/tts', { text: t.slice(0, 900), voiceId: vozIdRef.current || undefined }, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data as Blob);
      await new Promise<void>((resolve) => {
        const a = new Audio(url); audioRef.current = a;
        a.onended = () => resolve(); a.onerror = () => resolve(); a.onpause = () => resolve();
        a.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
    } catch { await vozNavegador(t); }
    soltaVigia();
    await new Promise((r) => setTimeout(r, 250)); // o navegador só deixa um reconhecimento por vez: dá tempo de o vigia soltar o microfone
    setVoz(vozRef.current ? 'pensando' : 'off');
  }
  /** Interromper a bolinha falando (Fabio 29/10: "falei o nome da cliente e ela continuou a lista"). Enquanto ela fala, um 2º reconhecimento fica ouvindo: palavra que ela NÃO está dizendo (o eco da própria voz é descartado) ou "pare/espera/calma/chega" corta a fala na hora e o que foi dito vira o pedido seguinte. */
  const interrompidoRef = useRef('');
  function vigiarInterrupcao(falado: string): () => void {
    const SR: any = typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;
    if (!SR || !vozRef.current) return () => {};
    const norm = (x: string) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    const dele = new Set(norm(falado));
    let ativo = true;
    let rec: any;
    try {
      rec = new SR(); rec.lang = 'pt-BR'; rec.continuous = true; rec.interimResults = true;
      rec.onresult = (e: any) => {
        if (!ativo) return;
        let txt = ''; let final = false;
        for (let i = e.resultIndex; i < e.results.length; i++) { txt += `${e.results[i][0].transcript} `; if (e.results[i].isFinal) final = true; }
        const ws = norm(txt);
        if (!ws.length) return;
        // Fabio 29/10: ela parava sozinha — o microfone ouve a PRÓPRIA voz e o reconhecimento erra as palavras ("para" também está na fala dela). Agora só corta com:
        //  1) palavra de parar que ela NÃO está dizendo (pare, espera, calma, chega, o nome da voz) ou
        //  2) uma frase de verdade: 3+ palavras que não estão na fala dela, sendo a maioria do que foi ouvido (eco mal reconhecido mistura com as palavras dela).
        const nomeVoz = norm(vozNomeRef.current || '')[0];
        const pararCom = ['pare', 'espera', 'espere', 'calma', 'chega', 'jarvis', ...(nomeVoz ? [nomeVoz] : [])].filter((w) => !dele.has(w));
        const pediuParar = ws.some((w) => pararCom.includes(w));
        const novas = ws.filter((w) => w.length > 2 && !dele.has(w));
        const frase = (final || ws.length >= 4) && novas.length >= 3 && novas.length / ws.length >= 0.6;
        if (pediuParar || frase) { ativo = false; interrompidoRef.current = txt.trim(); try { rec.abort(); } catch { /* */ } calar(); }
      };
      rec.onend = () => { if (ativo) { try { rec.start(); } catch { /* */ } } };
      rec.onerror = () => { /* sem microfone livre: segue sem interromper */ };
      rec.start();
    } catch { return () => {}; }
    return () => { ativo = false; try { rec.abort(); } catch { /* */ } };
  }
  function calar() {
    try { audioRef.current?.pause(); } catch { /* */ }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }
  function escutar(): Promise<string> {
    return new Promise((resolve) => {
      const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SR) { resolve(''); return; }
      const rec = new SR(); rec.lang = 'pt-BR'; rec.interimResults = false; rec.maxAlternatives = 1;
      recRef.current = rec;
      let dito = '';
      rec.onresult = (e: any) => { dito = String(e.results?.[0]?.[0]?.transcript || '').trim(); };
      let falhou = false;
      rec.onend = () => resolve(falhou ? FALHA_MIC : dito);
      // 'no-speech' = silêncio de verdade; outro erro ('aborted', microfone ainda preso pelo vigia da interrupção) NÃO conta como silêncio — o loop tenta de novo (Fabio 29/10: "parava sem eu falar nada").
      rec.onerror = (ev: any) => { if (ev?.error !== 'no-speech') falhou = true; };
      setVoz('ouvindo');
      try { rec.start(); } catch { resolve(FALHA_MIC); }
    });
  }

  // ── conversa com o Claude ──
  function lembra(m: Msg) { msgsRef.current = [...msgsRef.current, m].slice(-20); save(msgsRef.current); }
  // "Um instante" na mesma voz, quando a resposta demora (o áudio é baixado uma vez e reaproveitado).
  const aguardeRef = useRef<string | null>(null);
  async function avisaQueEstaVendo() {
    try {
      if (!aguardeRef.current) {
        const r = await api.post('/api/assistant/tts', { text: 'Um instante, já vejo.', voiceId: vozIdRef.current || undefined }, { responseType: 'blob' });
        aguardeRef.current = URL.createObjectURL(r.data as Blob);
      }
      const a = new Audio(aguardeRef.current); audioRef.current = a;
      await a.play();
    } catch { /* sem aviso, segue pensando */ }
  }
  async function perguntar(content: string): Promise<Cartao> {
    lembra({ role: 'user', content });
    setVoz('pensando');
    const demora = setTimeout(() => { if (vozRef.current) void avisaQueEstaVendo(); }, 2500);
    try {
      const { data } = await api.post('/api/assistant/chat', { voice: true, messages: msgsRef.current }).finally(() => clearTimeout(demora));
      const fala = String(data.reply || '').trim() || 'Não consegui responder agora.';
      lembra({ role: 'assistant', content: fala });
      const c: Cartao = { disse: content, fala, pending: data.pending?.length ? data.pending.map((p: Pending) => ({ ...p, estado: 'PENDENTE' })) : undefined, attachments: data.attachments?.length ? data.attachments : undefined, nav: data.navigate || null, audio: data.audio || null, copiar: data.copiar?.length ? data.copiar : undefined, escolherVoz: data.escolherVoz === true || undefined };
      setCard(c);
      if (c.nav?.path) router.push(c.nav.path);
      return c;
    } catch (err: any) {
      const c: Cartao = { disse: content, fala: err?.response?.data?.error || 'Não consegui responder agora. Tenta de novo.' };
      setCard(c);
      return c;
    }
  }

  function atualizaPendente(id: string, patch: Partial<Pending>) {
    const c = cartaoRef.current;
    if (c?.pending) setCard({ ...c, pending: c.pending.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }
  async function confirmar(id: string): Promise<string> {
    atualizaPendente(id, { estado: 'FEITO', resultado: 'Fazendo…' });
    try {
      const { data } = await api.post(`/api/assistant/confirm/${id}`);
      atualizaPendente(id, { estado: 'FEITO', resultado: data.resultado || 'Feito.' });
      lembra({ role: 'assistant', content: `(feito: ${data.resultado || 'ok'})` });
      if (data.call?.leadId) await discar(data.call.leadId, data.call.leadName);
      return data.resultado || 'Feito.';
    } catch (err: any) {
      const e = err?.response?.data?.error || 'Não consegui fazer.';
      atualizaPendente(id, { estado: 'ERRO', resultado: e });
      return `Não deu: ${e}`;
    }
  }
  function cancelar(id: string) {
    atualizaPendente(id, { estado: 'CANCELADO', resultado: 'Cancelado.' });
    lembra({ role: 'assistant', content: '(ação cancelada pela pessoa)' });
    api.post(`/api/assistant/cancel/${id}`).catch(() => {});
  }
  // Ligação confirmada: o colaborador fala; a bolinha só disca (mesmo fluxo do botão Ligar) e para de ouvir pra não disputar o microfone.
  async function discar(leadId: string, leadName: string) {
    parar();
    router.push(`/inbox?leadId=${leadId}`);
    const call = useOutboundCallStore.getState();
    if (call.stage !== 'idle') { toast('Já tem uma ligação em andamento', 'warning'); return; }
    await call.checkAndCall(leadId, leadName);
    if (useOutboundCallStore.getState().stage === 'confirm') await useOutboundCallStore.getState().confirmCall();
  }

  function parar() {
    vozRef.current = false; setVoz('off'); calar();
    try { recRef.current?.abort?.(); } catch { /* */ }
  }
  function escolherVoz(v: Voice) {
    vozIdRef.current = v.id; setVozNome(v.nome);
    try { localStorage.setItem(VOZ_KEY, v.id); localStorage.setItem(`${VOZ_KEY}_nome`, v.nome); } catch { /* */ }
    if (aguardeRef.current) { URL.revokeObjectURL(aguardeRef.current); aguardeRef.current = null; } // o "um instante" é refeito na voz nova
    setCard(null);
    void conversar();
  }
  async function conversar() {
    if (vozRef.current) { parar(); return; }
    // 1ª vez neste navegador: cada colaborador escolhe a voz antes de conversar.
    if (!vozIdRef.current) { setCard({ escolherVoz: true }); return; }
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { toast('Este navegador não reconhece fala (use o Chrome ou o Safari)', 'error'); return; }
    vozRef.current = true;
    if (!precisaClique) setCard(null);
    const inicial = partidaRef.current; partidaRef.current = '';
    if (!inicial) await falar(primeiroNome ? `Oi, ${primeiroNome}.` : 'Oi.');
    let primeira = inicial;
    let silencios = 0;
    let falhasMic = 0;
    while (vozRef.current) {
      const parcial = interrompidoRef.current; interrompidoRef.current = '';
      // se interrompeu, ainda pega o resto da frase (no máx. 2 s: o que ela já ouviu vale como pedido)
      const mais = primeira ? '' : parcial ? await Promise.race([escutar(), new Promise<string>((r) => setTimeout(() => { try { recRef.current?.stop(); } catch { /* */ } r(''); }, 2000))]) : await escutar();
      if (mais === FALHA_MIC && !primeira && !parcial) { if (++falhasMic > 4) break; await new Promise((r) => setTimeout(r, 350)); continue; }
      falhasMic = 0;
      const dito = primeira || [parcial, mais === FALHA_MIC ? '' : mais].filter(Boolean).join(' ').trim();
      primeira = '';
      if (!vozRef.current) break;
      if (!dito) { if (++silencios >= 2) break; continue; }
      silencios = 0;
      if (PARAR.test(dito.trim())) { setCard(null); await falar('Até já.'); break; }
      if (/^(trocar|mudar|muda|troca)\s+(a\s+|de\s+)?voz/i.test(dito.trim())) { setCard({ escolherVoz: true }); await falar('Escolha a voz nova aqui no balão.'); break; }
      const pend = (cartaoRef.current?.pending || []).filter((p) => p.estado === 'PENDENTE');
      // Mais de uma ação esperando: "sim" sozinho NÃO confirma todas (Fabio 29/10: pediu a mensagem ao cliente e saiu também o pedido da certidão). Pergunta qual.
      const ORD = /\b(primeir[ao]|1|um|segund[ao]|2|dois|terceir[ao]|3|tr[eê]s)\b/i;
      if (pend.length > 1 && (SIM.test(dito.trim()) || ORD.test(dito)) && !/\b(todas|todos|tudo|as duas|os dois|ambas|ambos)\b/i.test(dito)) {
        const m = ORD.exec(dito);
        if (!m) { await falar(`Tem ${pend.length} ações esperando: ${pend.map((p, i) => `${i + 1}, ${p.descricao.split(/[.\n]/)[0]}`).join('; ')}. Qual eu confirmo? Diga a primeira, a segunda ou todas.`); continue; }
        const w = m[1].toLowerCase();
        const idx = /^(primeir|1|um)/.test(w) ? 0 : /^(segund|2|dois)/.test(w) ? 1 : 2;
        const alvo = pend[idx];
        if (!alvo) { await falar('Não achei essa. Diga a primeira ou a segunda.'); continue; }
        setVoz('pensando');
        const r = await confirmar(alvo.id);
        if (!vozRef.current) break;
        await falar(r);
        continue;
      }
      if (pend.length && SIM.test(dito.trim())) {
        setCard({ ...cartaoRef.current, disse: dito });
        setVoz('pensando');
        const res: string[] = [];
        for (const p of pend) res.push(await confirmar(p.id));
        if (!vozRef.current) break;
        await falar(res.join(' '));
        continue;
      }
      if (pend.length && NAO.test(dito.trim())) {
        pend.forEach((p) => cancelar(p.id));
        await falar('Cancelado.');
        continue;
      }
      setCard({ disse: dito });
      const c = await perguntar(dito);
      if (!vozRef.current) break;
      if (c.audio) { await falar(c.fala || 'Pode gravar.'); break; } // gravador aberto: solta o microfone pra gravação
      if (c.escolherVoz) { await falar(c.fala || 'Escolha a voz aqui no balão.'); break; } // lista de vozes aberta: solta o microfone pra pessoa ouvir as amostras
      if (c.fala) await falar(c.fala);
    }
    parar();
  }
  useEffect(() => () => { vozRef.current = false; calar(); }, []);
  useEffect(() => {
    if (!chamarPorNome || !vozNome || voz !== 'off') return;
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const nome = vozNome.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean)[0];
    if (!nome) return;
    let vivo = true;
    let rec: any;
    const iniciar = () => {
      if (!vivo || document.visibilityState !== 'visible') return;
      try {
        rec = new SR(); rec.lang = 'pt-BR'; rec.continuous = true; rec.interimResults = true;
        rec.onresult = (e: any) => {
          if (!vivo) return;
          let txt = '';
          for (let i = e.resultIndex; i < e.results.length; i++) txt += `${e.results[i][0].transcript} `;
          const ws = txt.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
          const i = ws.indexOf(nome);
          if (i < 0) return;
          vivo = false; try { rec.abort(); } catch { /* */ }
          partidaRef.current = ws.slice(i + 1).join(' '); // "Nina, abre o card do Pedro": o resto já vale como pedido
          void conversar();
        };
        rec.onend = () => { if (vivo) setTimeout(iniciar, 400); };
        rec.onerror = () => { /* microfone ocupado/negado: tenta de novo no onend */ };
        rec.start();
      } catch { /* */ }
    };
    iniciar();
    return () => { vivo = false; try { rec?.abort(); } catch { /* */ } };
  }, [chamarPorNome, vozNome, voz]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── lembretes: na hora, a bolinha fala (além do push) ──
  useEffect(() => {
    let vivo = true;
    const tick = async () => {
      try {
        const { data } = await api.get('/api/assistant/reminders/due');
        if (!vivo || !Array.isArray(data)) return;
        const ja = new Set(spokenIds());
        for (const r of data as { id: string; titulo: string; leadId: string | null; cliente: string | null }[]) {
          if (ja.has(r.id)) continue;
          markSpoken(r.id);
          setCard({ fala: `⏰ Lembrete: ${r.titulo}${r.cliente ? ` (${r.cliente})` : ''}.`, nav: r.leadId ? { path: `/inbox?leadId=${r.leadId}`, label: `Conversa do ${r.cliente}` } : null });
          if (!vozRef.current) await falar(`${primeiroNome ? `${primeiroNome}, ` : ''}lembrete: ${r.titulo}.`);
        }
      } catch { /* sem rede: tenta no próximo */ }
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => { vivo = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primeiroNome]);

  if (!pos) return null;
  const escondeCelular = pathname.startsWith('/inbox') && !conversando && !cartao;
  const status = voz === 'ouvindo' ? 'Ouvindo…' : voz === 'pensando' ? 'Pensando…' : '';
  // balão ao lado da bolinha: em cima se houver espaço, senão embaixo; sempre dentro da tela
  const W = 300;
  const bx = Math.min(Math.max(pos.x + ORB / 2 - W / 2, 8), window.innerWidth - W - 8);
  const acima = pos.y > 300;
  const anda = mouseEm ? 'none' : `left ${MOVE_MS}ms ease-in-out, top ${MOVE_MS}ms ease-in-out, bottom ${MOVE_MS}ms ease-in-out`;

  return (
    <>
      {(cartao || status) && (
        <div
          className="fixed z-50 w-[300px] max-w-[calc(100vw-1rem)] rounded-2xl border border-slate-200 bg-white/95 backdrop-blur shadow-xl p-3 text-sm text-slate-800"
          style={{ left: bx, ...(acima ? { bottom: window.innerHeight - pos.y + 12 } : { top: pos.y + ORB + 12 }), transition: anda }}
          onMouseEnter={segura}
          onMouseLeave={solta}
        >
          <button onClick={() => setCard(null)} className="absolute right-2 top-2 text-slate-400 hover:text-slate-600" title="Fechar"><X size={14} /></button>
          {cartao?.disse && <p className="pr-5 text-xs italic text-slate-500">“{cartao.disse}”</p>}
          {status && <p className="mt-0.5 text-xs font-medium text-sky-600">{status}</p>}
          {cartao?.fala && <p className="mt-1 pr-4 leading-snug whitespace-pre-wrap max-h-48 overflow-y-auto">{cartao.fala}</p>}
          {cartao?.attachments?.map((a) => (a.type === 'document' ? <DocumentCard key={`${a.source}:${a.ref}`} a={a} /> : <SimulationCard key={a.id} a={a} />))}
          {cartao?.copiar?.map((c, i) => <CopyCard key={i} c={c} />)}
          {cartao?.escolherVoz && <VoicePicker atual={vozIdRef.current} primeiroNome={primeiroNome} onPick={escolherVoz} />}
          {cartao?.audio && <RecorderCard req={cartao.audio} onDone={(m) => setCard({ fala: m })} />}
          {cartao?.pending?.map((p) => (
            <div key={p.id} className={cn('mt-2 rounded-lg border p-2 text-xs', p.estado === 'PENDENTE' ? 'border-amber-300 bg-amber-50' : p.estado === 'ERRO' ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-slate-50')}>
              <div className="text-slate-700 whitespace-pre-wrap max-h-40 overflow-y-auto">{p.descricao}</div>
              {p.estado === 'PENDENTE' ? (
                <div className="mt-1.5 flex gap-1.5">
                  <button onClick={async () => { const r = await confirmar(p.id); if (!vozRef.current) setCard({ ...cartaoRef.current, fala: r }); }} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 font-medium text-white hover:brightness-110"><Check size={12} /> Confirmar</button>
                  <button onClick={() => cancelar(p.id)} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-slate-600 hover:bg-slate-100"><Ban size={12} /> Cancelar</button>
                </div>
              ) : (
                <div className={cn('mt-1 font-medium', p.estado === 'ERRO' ? 'text-red-600' : p.estado === 'CANCELADO' ? 'text-slate-500' : 'text-emerald-700')}>{p.resultado}</div>
              )}
            </div>
          ))}
          {cartao?.nav?.path && <button onClick={() => router.push(cartao.nav!.path)} className="mt-1.5 flex items-center gap-1 text-xs font-medium text-[#2261a8] hover:underline"><ExternalLink size={12} /> {cartao.nav.label}</button>}
          {!cartao?.escolherVoz && vozNome && <button onClick={() => { if (vozRef.current) parar(); setCard({ escolherVoz: true }); }} className="mt-2 flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600"><Volume2 size={11} /> Voz: {vozNome} · trocar</button>}
          {!cartao?.escolherVoz && vozNome && <button onClick={alternaChamarPorNome} className="mt-1 flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600"><Volume2 size={11} /> Chamar dizendo "{vozNome}": {chamarPorNome ? 'ligado' : 'desligado'}</button>}
        </div>
      )}

      <button
        ref={orbRef}
        onClick={() => { if (pressRef.current.abriu) { pressRef.current.abriu = false; return; } void conversar(); }}
        onTouchStart={() => { pressRef.current.abriu = false; pressRef.current.t = setTimeout(() => { pressRef.current.abriu = true; if (vozRef.current) parar(); setCard({ escolherVoz: true }); }, 650); }}
        onTouchEnd={() => { if (pressRef.current.t) clearTimeout(pressRef.current.t); }}
        onMouseEnter={segura}
        onMouseLeave={solta}
        // Botão direito (ou segurar o dedo no celular) abre a lista de vozes (Fabio 29/10: "colocar a opção de escolher vozes").
        onContextMenu={(e) => { e.preventDefault(); if (vozRef.current) parar(); setCard({ escolherVoz: true }); }}
        className={cn('fixed z-50 rounded-full focus:outline-none', escondeCelular && 'hidden md:block')}
        style={{ left: pos.x, top: pos.y, width: ORB, height: ORB, transition: anda }}
        aria-label="Assistente do CRM"
        title={conversando ? 'Conversando — toque pra parar' : 'Assistente do CRM — toque e fale (botão direito ou segurar: escolher a voz)'}
      >
        <Orb3D voz={voz} />
      </button>
    </>
  );
}
