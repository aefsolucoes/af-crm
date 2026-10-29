'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Bot, X, Send, Loader2, FileText, Trash2, Mic, MicOff, Check, Ban, ExternalLink, Volume2 } from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth.store';

/* Assistente do CRM (Fabio 26/10): chat da EQUIPE pra perguntar qualquer coisa sobre qualquer cliente — inclusive "preciso da simulação do cliente X",
 * que volta aqui como PDF (só pra equipe, nunca vai ao cliente). O servidor (routes/assistant.ts) usa o Claude com ferramentas que leem o CRM.
 * 29/10 ("Jarvis"): também age — ações que mexem com cliente chegam como cartão "Confirmar/Cancelar" (ou "sim/não" falado); abre telas (conversa, funil…);
 * conversa por VOZ (só ao clicar no microfone; voz natural da ElevenLabs, com a do navegador de reserva) com o botão flutuante girando enquanto conversa;
 * lembretes ("me lembra de…") são falados aqui na hora, além do push.
 * O histórico fica só neste navegador. */

type Attachment = { type: 'simulation'; id: string; banco: string; leadName: string };
type Pending = { id: string; descricao: string; estado?: 'PENDENTE' | 'FEITO' | 'CANCELADO' | 'ERRO'; resultado?: string };
type Nav = { path: string; label: string };
type Msg = { role: 'user' | 'assistant'; content: string; attachments?: Attachment[]; pending?: Pending[]; nav?: Nav | null };
type Voz = 'off' | 'ouvindo' | 'pensando' | 'falando';
const STORE_KEY = 'af_crm_assistant_chat';
const SPOKEN_KEY = 'af_crm_assistant_reminders_spoken';

function load(): Msg[] {
  try { const raw = localStorage.getItem(STORE_KEY); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v.slice(-40) : []; } catch { return []; }
}
function save(msgs: Msg[]) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(msgs.slice(-40))); } catch { /* navegador sem armazenamento: segue sem histórico */ }
}
function spokenIds(): string[] { try { const v = JSON.parse(localStorage.getItem(SPOKEN_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function markSpoken(id: string) { try { localStorage.setItem(SPOKEN_KEY, JSON.stringify([...spokenIds(), id].slice(-100))); } catch { /* */ } }

const SIM = /^(sim|pode|pode sim|confirmo|confirma|confirmar|manda|pode mandar|faz|pode fazer|isso|ok|beleza|claro)\b/i;
const NAO = /^(não|nao|cancela|cancelar|deixa|esquece|para|negativo)\b/i;
const PARAR = /^(parar|para de ouvir|chega|encerrar|tchau|obrigado,? (é|e) só|só isso)[.!]?$/i;

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
    } catch (err: any) {
      w?.close();
      toast('Não consegui abrir o PDF', 'error');
    } finally { setOpening(false); }
  }

  const banco = a.banco === 'SANTANDER' ? 'Santander' : a.banco === 'INTER' ? 'Inter' : a.banco;
  const pronto = st?.hasPdf;
  const falhou = st?.status === 'FAILED' || st?.status === 'ERRO';
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white p-2 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-slate-700"><FileText size={13} className="text-red-500" /> Simulação {banco} — {a.leadName}</div>
      <div className="mt-1 text-slate-500">
        {!st ? 'Conferindo…'
          : pronto ? 'PDF pronto (só pra equipe).'
          : falhou ? `Não saiu: ${st.detail || 'erro ao gerar'}`
          : st.status === 'DONE' ? 'Esse PDF foi enviado ao cliente pelo WhatsApp.'
          : 'Gerando no portal do banco (1 a 2 min — o Chrome com a extensão precisa estar aberto)…'}
      </div>
      {pronto && (
        <button onClick={abrir} disabled={opening} className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-[#2261a8] px-2.5 py-1 font-medium text-white hover:brightness-110 disabled:opacity-50">
          {opening ? <Loader2 size={12} className="animate-spin" /> : <FileText size={12} />} Abrir PDF
        </button>
      )}
    </div>
  );
}

/** Bola animada do botão flutuante (estilo modo voz do ChatGPT): gira enquanto a conversa por voz está ligada; pulsa mais quando fala, respira quando ouve. */
function Orb({ voz }: { voz: Voz }) {
  return (
    <span className="relative block w-full h-full rounded-full overflow-hidden">
      <span
        className="absolute -inset-2 rounded-full"
        style={{
          background: 'conic-gradient(from 0deg, #1e1b4b, #2261a8, #38bdf8, #a78bfa, #2261a8, #1e1b4b)',
          animation: `afOrbSpin ${voz === 'falando' ? '1.6s' : voz === 'pensando' ? '1.1s' : '3.2s'} linear infinite`,
        }}
      />
      <span
        className="absolute inset-[5px] rounded-full"
        style={{
          background: 'radial-gradient(circle at 35% 30%, rgba(255,255,255,.85), rgba(186,230,253,.55) 30%, rgba(34,97,168,.35) 65%, rgba(30,27,75,.2))',
          animation: voz === 'falando' ? 'afOrbTalk .55s ease-in-out infinite alternate' : voz === 'ouvindo' ? 'afOrbBreath 1.8s ease-in-out infinite' : 'none',
        }}
      />
      <style>{`
        @keyframes afOrbSpin { to { transform: rotate(360deg); } }
        @keyframes afOrbTalk { from { transform: scale(.82); } to { transform: scale(1.05); } }
        @keyframes afOrbBreath { 0%,100% { transform: scale(.9); opacity: .85; } 50% { transform: scale(1); opacity: 1; } }
      `}</style>
    </span>
  );
}

export function CrmAssistant() {
  const pathname = usePathname();
  const router = useRouter();
  const userName = useAuthStore((s) => s.user?.name) || '';
  const primeiroNome = userName.split(/\s+/)[0] || '';
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [voz, setVoz] = useState<Voz>('off');
  const endRef = useRef<HTMLDivElement>(null);
  const msgsRef = useRef<Msg[]>([]);
  const vozRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recRef = useRef<any>(null);

  const setAll = (m: Msg[]) => { msgsRef.current = m; setMsgs(m); save(m); };
  useEffect(() => { const m = load(); msgsRef.current = m; setMsgs(m); }, []);
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs, open, sending, voz]);

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
    const t = frase.replace(/[*_#`>]/g, '').replace(/https?:\S+/g, '').trim();
    if (!t) return;
    setVoz('falando');
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

  // ── chat ──
  async function perguntar(content: string, porVoz: boolean): Promise<Msg | null> {
    const next: Msg[] = [...msgsRef.current, { role: 'user', content }];
    setAll(next); setSending(true);
    if (porVoz) setVoz('pensando');
    try {
      const { data } = await api.post('/api/assistant/chat', { voice: porVoz, messages: next.map((m) => ({ role: m.role, content: m.content })) });
      const resp: Msg = {
        role: 'assistant', content: data.reply || '(sem resposta)',
        attachments: data.attachments?.length ? data.attachments : undefined,
        pending: data.pending?.length ? data.pending.map((p: Pending) => ({ ...p, estado: 'PENDENTE' })) : undefined,
        nav: data.navigate || null,
      };
      setAll([...next, resp]);
      if (resp.nav?.path) router.push(resp.nav.path);
      return resp;
    } catch (err: any) {
      const resp: Msg = { role: 'assistant', content: `⚠️ ${err?.response?.data?.error || 'Não consegui responder agora. Tente de novo.'}` };
      setAll([...next, resp]);
      return resp;
    } finally { setSending(false); }
  }

  async function send() {
    const content = input.trim();
    if (!content || sending) return;
    setInput('');
    await perguntar(content, false);
  }

  function atualizaPendente(id: string, patch: Partial<Pending>) {
    setAll(msgsRef.current.map((m) => (m.pending?.some((p) => p.id === id) ? { ...m, pending: m.pending.map((p) => (p.id === id ? { ...p, ...patch } : p)) } : m)));
  }
  async function confirmar(id: string): Promise<string> {
    atualizaPendente(id, { estado: 'FEITO', resultado: 'Fazendo…' });
    try {
      const { data } = await api.post(`/api/assistant/confirm/${id}`);
      atualizaPendente(id, { estado: 'FEITO', resultado: data.resultado || 'Feito.' });
      return data.resultado || 'Feito.';
    } catch (err: any) {
      const e = err?.response?.data?.error || 'Não consegui fazer.';
      atualizaPendente(id, { estado: 'ERRO', resultado: e });
      return `Não deu: ${e}`;
    }
  }
  async function cancelar(id: string) {
    atualizaPendente(id, { estado: 'CANCELADO', resultado: 'Cancelado.' });
    api.post(`/api/assistant/cancel/${id}`).catch(() => {});
  }

  // ── conversa por voz (só ao clicar no microfone) ──
  function pararVoz() {
    vozRef.current = false; setVoz('off'); calar();
    try { recRef.current?.abort?.(); } catch { /* */ }
  }
  async function conversar() {
    if (vozRef.current) { pararVoz(); return; }
    const SR: any = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) { toast('Este navegador não reconhece fala (use o Chrome ou o Safari)', 'error'); return; }
    vozRef.current = true; setOpen(true);
    await falar(primeiroNome ? `Oi, ${primeiroNome}. Pode falar.` : 'Pode falar.');
    let silencios = 0;
    while (vozRef.current) {
      const dito = await escutar();
      if (!vozRef.current) break;
      if (!dito) { if (++silencios >= 2) { await falar('Vou ficar quieto. É só clicar no microfone de novo.'); break; } continue; }
      silencios = 0;
      if (PARAR.test(dito.trim())) { await falar('Tá bom. Até já.'); break; }
      // tem ação esperando confirmação? "sim" confirma, "não" cancela
      const pend = [...msgsRef.current].reverse().flatMap((m) => m.pending || []).filter((p) => p.estado === 'PENDENTE');
      if (pend.length && SIM.test(dito.trim())) {
        setAll([...msgsRef.current, { role: 'user', content: dito }]);
        setVoz('pensando');
        const res: string[] = [];
        for (const p of pend) res.push(await confirmar(p.id));
        if (!vozRef.current) break;
        await falar(res.join(' '));
        continue;
      }
      if (pend.length && NAO.test(dito.trim())) {
        setAll([...msgsRef.current, { role: 'user', content: dito }]);
        pend.forEach((p) => cancelar(p.id));
        await falar('Cancelado. Mais alguma coisa?');
        continue;
      }
      const r = await perguntar(dito, true);
      if (!vozRef.current) break;
      if (r) await falar(r.content.replace(/^⚠️\s*/, ''));
    }
    pararVoz();
  }
  useEffect(() => () => { vozRef.current = false; calar(); }, []);

  // ── lembretes: na hora, o balão abre e fala (além do push) ──
  useEffect(() => {
    let vivo = true;
    const tick = async () => {
      try {
        const { data } = await api.get('/api/assistant/reminders/due');
        if (!vivo || !Array.isArray(data)) return;
        const ja = new Set(spokenIds());
        for (const r of data as { id: string; titulo: string; quando: string; leadId: string | null; cliente: string | null }[]) {
          if (ja.has(r.id)) continue;
          markSpoken(r.id);
          const texto = `⏰ Lembrete: ${r.titulo}${r.cliente ? ` (${r.cliente})` : ''}.`;
          setAll([...msgsRef.current, { role: 'assistant', content: texto, nav: r.leadId ? { path: `/inbox?leadId=${r.leadId}`, label: `Conversa do ${r.cliente}` } : null }]);
          setOpen(true);
          if (!vozRef.current) await falar(`${primeiroNome ? `${primeiroNome}, ` : ''}lembrete: ${r.titulo}.`);
        }
      } catch { /* sem rede: tenta no próximo */ }
    };
    tick();
    const t = setInterval(tick, 30_000);
    return () => { vivo = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primeiroNome]);

  function limpar() {
    if (!window.confirm('Apagar a conversa com o assistente (só neste navegador)?')) return;
    setAll([]);
  }

  const hideOnMobile = pathname.startsWith('/inbox');
  const sugestoes = ['Quem está parado há mais de 3 dias?', 'Resumo do cliente …', 'Me lembra de falar com … amanhã às 10h', 'Abre a conversa do …', 'Preciso da simulação do cliente …'];
  const statusVoz = voz === 'ouvindo' ? 'Ouvindo…' : voz === 'pensando' ? 'Pensando…' : voz === 'falando' ? 'Falando…' : '';

  return (
    <>
      {open && (
        <div className="fixed z-50 bottom-20 right-4 md:right-5 w-[420px] max-w-[calc(100vw-2rem)] h-[620px] max-h-[calc(100vh-7rem)] flex flex-col rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 text-white" style={{ backgroundColor: '#1e1b4b' }}>
            <Bot size={18} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold leading-tight">Assistente do CRM</p>
              <p className="text-[11px] text-white/70 leading-tight">{statusVoz || 'Pergunte, peça ou converse por voz'}</p>
            </div>
            <button onClick={conversar} title={voz !== 'off' ? 'Parar a conversa por voz' : 'Conversar por voz'} className={cn('p-1.5 rounded-full', voz !== 'off' ? 'bg-red-500 hover:bg-red-600' : 'hover:bg-white/10')}>
              {voz !== 'off' ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
            {msgs.length > 0 && <button onClick={limpar} title="Apagar a conversa" className="p-1 rounded hover:bg-white/10"><Trash2 size={15} /></button>}
            <button onClick={() => { setOpen(false); pararVoz(); }} title="Fechar" className="p-1 rounded hover:bg-white/10"><X size={17} /></button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5 bg-slate-50">
            {msgs.length === 0 && (
              <div className="text-sm text-slate-500 space-y-2">
                <p>Me pergunte ou me peça qualquer coisa no CRM. Exemplos:</p>
                <div className="flex flex-wrap gap-1.5">
                  {sugestoes.map((s) => (
                    <button key={s} onClick={() => setInput(s.replace(' …', ' ').replace('…', ''))} className="text-xs rounded-full border border-slate-300 bg-white px-2.5 py-1 hover:bg-slate-100 text-slate-600">{s}</button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-400">Anotação, lembrete e abrir telas eu faço direto. Mensagem a cliente, mover card, ganho/perdido, análise, vistoria e certidão só depois que você confirmar. Clique no microfone pra conversar por voz.</p>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]', m.role === 'user' ? 'bg-[#2261a8] text-white rounded-br-sm' : 'bg-white text-slate-800 border border-slate-200 rounded-bl-sm')}>
                  {m.content}
                  {m.role === 'assistant' && voz === 'off' && !m.content.startsWith('⚠️') && (
                    <button onClick={() => falar(m.content)} title="Ouvir" className="ml-1 align-middle text-slate-400 hover:text-slate-600"><Volume2 size={13} /></button>
                  )}
                  {m.attachments?.map((a) => <SimulationCard key={a.id} a={a} />)}
                  {m.pending?.map((p) => (
                    <div key={p.id} className={cn('mt-2 rounded-lg border p-2 text-xs', p.estado === 'PENDENTE' ? 'border-amber-300 bg-amber-50' : p.estado === 'ERRO' ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-slate-50')}>
                      <div className="text-slate-700">{p.descricao}</div>
                      {p.estado === 'PENDENTE' ? (
                        <div className="mt-1.5 flex gap-1.5">
                          <button onClick={() => confirmar(p.id)} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 font-medium text-white hover:brightness-110"><Check size={12} /> Confirmar</button>
                          <button onClick={() => cancelar(p.id)} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-slate-600 hover:bg-slate-100"><Ban size={12} /> Cancelar</button>
                        </div>
                      ) : (
                        <div className={cn('mt-1 font-medium', p.estado === 'ERRO' ? 'text-red-600' : p.estado === 'CANCELADO' ? 'text-slate-500' : 'text-emerald-700')}>{p.resultado}</div>
                      )}
                    </div>
                  ))}
                  {m.nav?.path && (
                    <button onClick={() => router.push(m.nav!.path)} className="mt-1.5 flex items-center gap-1 text-xs font-medium text-[#2261a8] hover:underline"><ExternalLink size={12} /> {m.nav.label}</button>
                  )}
                </div>
              </div>
            ))}
            {sending && <div className="flex justify-start"><div className="rounded-2xl rounded-bl-sm bg-white border border-slate-200 px-3 py-2 text-sm text-slate-500 flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" /> Consultando o CRM…</div></div>}
            <div ref={endRef} />
          </div>

          <div className="border-t border-slate-200 p-2 flex gap-2 bg-white">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
              rows={2}
              placeholder="Ex.: me lembra de ligar pro Pedro amanhã às 10h"
              className="flex-1 resize-none rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 focus:outline-none focus:border-[#2261a8]"
            />
            <button onClick={() => send()} disabled={sending || !input.trim()} className="self-end rounded-lg px-3 py-2 text-white disabled:opacity-50" style={{ backgroundColor: '#2261a8' }} aria-label="Enviar">
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
        </div>
      )}

      <button
        onClick={() => { if (voz !== 'off') { pararVoz(); return; } setOpen((v) => !v); }}
        className={cn(
          'fixed z-40 bottom-[76px] right-4 md:bottom-[84px] md:right-5 w-[48px] h-[48px] rounded-full text-white shadow-lg flex items-center justify-center hover:brightness-110 transition',
          hideOnMobile && !open && voz === 'off' && 'hidden md:flex',
          voz !== 'off' && 'w-[56px] h-[56px] shadow-[0_0_24px_rgba(56,189,248,.55)]',
        )}
        style={{ backgroundColor: '#1e1b4b' }}
        aria-label="Assistente do CRM"
        title={voz !== 'off' ? 'Conversando — clique pra parar' : 'Assistente do CRM — pergunte ou peça qualquer coisa'}
      >
        {voz !== 'off' ? <Orb voz={voz} /> : open ? <X size={20} /> : <Bot size={22} />}
      </button>
    </>
  );
}
