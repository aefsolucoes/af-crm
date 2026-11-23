'use client';
import { useEffect, useRef, useState } from 'react';
import { Loader2, FileText, Ban, Mic, Square, Send, RotateCcw, Play, Volume2 } from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';

/* Cartões do Jarvis — os mesmos no balãozinho da bolinha e no chat por texto (Fabio 23/11: chat de volta, junto com a bolinha). */

export type Attachment = { type: 'simulation'; id: string; banco: string; leadName: string } | { type: 'document'; leadId: string; source: 'att' | 'drive'; ref: string; fileName: string; mimeType: string };
export type Nav = { path: string; label: string };
export type Pending = { id: string; descricao: string; estado?: 'PENDENTE' | 'FEITO' | 'CANCELADO' | 'ERRO'; resultado?: string; nav?: Nav | null };
export type AudioReq = { leadId: string; leadName: string };
export type CopyReq = { label: string; texto: string };
export type Voice = { id: string; nome: string; desc: string };

/** Documento do cliente espelhado AQUI no balão (Fabio 29/10: "sem abrir telas reais"): foto ou PDF da conversa ou da pasta do Drive, baixado pelo CRM. */
export function DocumentCard({ a }: { a: Extract<Attachment, { type: 'document' }> }) {
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

export function SimulationCard({ a }: { a: Extract<Attachment, { type: 'simulation' }> }) {
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

/** Texto pra copiar e encaminhar (ex.: PIX da certidão): o assistente não lê em voz alta, só mostra aqui. */
export function CopyCard({ c }: { c: CopyReq }) {
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
export function VoicePicker({ atual, primeiroNome, onPick }: { atual: string; primeiroNome: string; onPick: (v: Voice) => void }) {
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

/** Gravador de áudio pro cliente: a pessoa grava com a própria voz, ouve e só sai no Enviar (mesmo envio da Inbox, convertido pra voz do WhatsApp no servidor). */
export function RecorderCard({ req, onDone }: { req: AudioReq; onDone: (msg: string) => void }) {
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
