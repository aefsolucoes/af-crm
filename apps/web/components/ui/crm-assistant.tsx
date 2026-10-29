'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2, FileText, Check, Ban, ExternalLink, X, Mic, Square, Send, RotateCcw } from 'lucide-react';
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

type Attachment = { type: 'simulation'; id: string; banco: string; leadName: string };
type Pending = { id: string; descricao: string; estado?: 'PENDENTE' | 'FEITO' | 'CANCELADO' | 'ERRO'; resultado?: string };
type Nav = { path: string; label: string };
type AudioReq = { leadId: string; leadName: string };
type Msg = { role: 'user' | 'assistant'; content: string };
type Voz = 'off' | 'ouvindo' | 'pensando' | 'falando';
type Cartao = { fala?: string; disse?: string; pending?: Pending[]; attachments?: Attachment[]; nav?: Nav | null; audio?: AudioReq | null };
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

function SimulationCard({ a }: { a: Attachment }) {
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
  const setCard = (c: Cartao | null) => { cartaoRef.current = c; setCartao(c); };

  useEffect(() => { msgsRef.current = load(); }, []);

  // ── posição: no canto quando parada; passeando pela tela enquanto conversa (para quando há algo pra clicar no balão) ──
  const canto = () => ({ x: window.innerWidth - ORB - 20, y: window.innerHeight - ORB - 84 });
  const precisaClique = !!(cartao?.pending?.some((p) => p.estado === 'PENDENTE') || cartao?.audio || cartao?.attachments?.length);
  const conversando = voz !== 'off';
  useEffect(() => {
    setPos(canto());
    const onR = () => { if (!vozRef.current) setPos(canto()); };
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);
  useEffect(() => {
    if (!conversando) { if (!precisaClique) setPos(canto()); return; }
    if (precisaClique) return;
    const passeia = () => {
      const w = window.innerWidth, h = window.innerHeight;
      setPos({ x: 260 + Math.random() * Math.max(40, w - 260 - ORB - 40), y: 90 + Math.random() * Math.max(40, h - 90 - ORB - 120) });
    };
    passeia();
    const t = setInterval(passeia, MOVE_MS);
    return () => clearInterval(t);
  }, [conversando, precisaClique]);

  // ── voz ──
  function vozNavegador(frase: string): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) return resolve();
      const u = new SpeechSynthesisUtterance(frase);
      u.lang = 'pt-BR'; u.rate = 1.05;
      const v = window.speechSynthesis.getVoices().find((x) => x.lang?.toLowerCase().startsWith('pt'));
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
    try {
      const r = await api.post('/api/assistant/tts', { text: t.slice(0, 900) }, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data as Blob);
      await new Promise<void>((resolve) => {
        const a = new Audio(url); audioRef.current = a;
        a.onended = () => resolve(); a.onerror = () => resolve(); a.onpause = () => resolve();
        a.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
    } catch { await vozNavegador(t); }
    setVoz(vozRef.current ? 'pensando' : 'off');
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
      rec.onend = () => resolve(dito);
      rec.onerror = () => resolve('');
      setVoz('ouvindo');
      try { rec.start(); } catch { resolve(''); }
    });
  }

  // ── conversa com o Claude ──
  function lembra(m: Msg) { msgsRef.current = [...msgsRef.current, m].slice(-20); save(msgsRef.current); }
  // "Um instante" na mesma voz, quando a resposta demora (o áudio é baixado uma vez e reaproveitado).
  const aguardeRef = useRef<string | null>(null);
  async function avisaQueEstaVendo() {
    try {
      if (!aguardeRef.current) {
        const r = await api.post('/api/assistant/tts', { text: 'Um instante, já vejo.' }, { responseType: 'blob' });
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
      const c: Cartao = { disse: content, fala, pending: data.pending?.length ? data.pending.map((p: Pending) => ({ ...p, estado: 'PENDENTE' })) : undefined, attachments: data.attachments?.length ? data.attachments : undefined, nav: data.navigate || null, audio: data.audio || null };
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
  async function conversar() {
    if (vozRef.current) { parar(); return; }
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { toast('Este navegador não reconhece fala (use o Chrome ou o Safari)', 'error'); return; }
    vozRef.current = true;
    if (!precisaClique) setCard(null);
    await falar(primeiroNome ? `Oi, ${primeiroNome}.` : 'Oi.');
    let silencios = 0;
    while (vozRef.current) {
      const dito = await escutar();
      if (!vozRef.current) break;
      if (!dito) { if (++silencios >= 2) break; continue; }
      silencios = 0;
      if (PARAR.test(dito.trim())) { setCard(null); await falar('Até já.'); break; }
      const pend = (cartaoRef.current?.pending || []).filter((p) => p.estado === 'PENDENTE');
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
      if (c.fala) await falar(c.fala);
    }
    parar();
  }
  useEffect(() => () => { vozRef.current = false; calar(); }, []);

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
  const anda = `left ${MOVE_MS}ms ease-in-out, top ${MOVE_MS}ms ease-in-out, bottom ${MOVE_MS}ms ease-in-out`;

  return (
    <>
      {(cartao || status) && (
        <div
          className="fixed z-50 w-[300px] max-w-[calc(100vw-1rem)] rounded-2xl border border-slate-200 bg-white/95 backdrop-blur shadow-xl p-3 text-sm text-slate-800"
          style={{ left: bx, ...(acima ? { bottom: window.innerHeight - pos.y + 12 } : { top: pos.y + ORB + 12 }), transition: anda }}
        >
          <button onClick={() => setCard(null)} className="absolute right-2 top-2 text-slate-400 hover:text-slate-600" title="Fechar"><X size={14} /></button>
          {cartao?.disse && <p className="pr-5 text-xs italic text-slate-500">“{cartao.disse}”</p>}
          {status && <p className="mt-0.5 text-xs font-medium text-sky-600">{status}</p>}
          {cartao?.fala && <p className="mt-1 pr-4 leading-snug whitespace-pre-wrap max-h-48 overflow-y-auto">{cartao.fala}</p>}
          {cartao?.attachments?.map((a) => <SimulationCard key={a.id} a={a} />)}
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
        </div>
      )}

      <button
        onClick={conversar}
        className={cn('fixed z-50 rounded-full focus:outline-none', escondeCelular && 'hidden md:block')}
        style={{ left: pos.x, top: pos.y, width: ORB, height: ORB, transition: anda }}
        aria-label="Assistente do CRM"
        title={conversando ? 'Conversando — toque pra parar' : 'Assistente do CRM — toque e fale'}
      >
        <Orb3D voz={voz} />
      </button>
    </>
  );
}
