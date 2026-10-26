'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Bot, X, Send, Loader2, FileText, Trash2 } from 'lucide-react';
import api from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';

/* Assistente do CRM (Fabio 26/10): chat da EQUIPE pra perguntar qualquer coisa sobre qualquer cliente — inclusive "preciso da simulação do cliente X",
 * que volta aqui como PDF (só pra equipe, nunca vai ao cliente). O servidor (routes/assistant.ts) usa o Claude com ferramentas que leem o CRM.
 * O histórico fica só neste navegador. */

type Attachment = { type: 'simulation'; id: string; banco: string; leadName: string };
type Msg = { role: 'user' | 'assistant'; content: string; attachments?: Attachment[] };
const STORE_KEY = 'af_crm_assistant_chat';

function load(): Msg[] {
  try { const raw = localStorage.getItem(STORE_KEY); const v = raw ? JSON.parse(raw) : []; return Array.isArray(v) ? v.slice(-40) : []; } catch { return []; }
}
function save(msgs: Msg[]) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(msgs.slice(-40))); } catch { /* navegador sem armazenamento: segue sem histórico */ }
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

export function CrmAssistant() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMsgs(load()); }, []);
  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: 'end' }); }, [msgs, open, sending]);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || sending) return;
    const next: Msg[] = [...msgs, { role: 'user', content }];
    setMsgs(next); save(next); setInput(''); setSending(true);
    try {
      const { data } = await api.post('/api/assistant/chat', { messages: next.map((m) => ({ role: m.role, content: m.content })) });
      const done: Msg[] = [...next, { role: 'assistant', content: data.reply || '(sem resposta)', attachments: data.attachments?.length ? data.attachments : undefined }];
      setMsgs(done); save(done);
    } catch (err: any) {
      const done: Msg[] = [...next, { role: 'assistant', content: `⚠️ ${err?.response?.data?.error || 'Não consegui responder agora. Tente de novo.'}` }];
      setMsgs(done); save(done);
    } finally { setSending(false); }
  }

  function limpar() {
    if (!window.confirm('Apagar a conversa com o assistente (só neste navegador)?')) return;
    setMsgs([]); save([]);
  }

  const hideOnMobile = pathname.startsWith('/inbox');
  const sugestoes = ['Preciso da simulação do cliente …', 'Quem está em Pré-Análise hoje?', 'Resumo do cliente …', 'Em que pé está a análise do cliente …?'];

  return (
    <>
      {open && (
        <div className="fixed z-50 bottom-20 right-4 md:right-5 w-[420px] max-w-[calc(100vw-2rem)] h-[620px] max-h-[calc(100vh-7rem)] flex flex-col rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 text-white" style={{ backgroundColor: '#1e1b4b' }}>
            <Bot size={18} />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold leading-tight">Assistente do CRM</p>
              <p className="text-[11px] text-white/70 leading-tight">Pergunte sobre qualquer cliente — inclusive simulação em PDF</p>
            </div>
            {msgs.length > 0 && <button onClick={limpar} title="Apagar a conversa" className="p-1 rounded hover:bg-white/10"><Trash2 size={15} /></button>}
            <button onClick={() => setOpen(false)} title="Fechar" className="p-1 rounded hover:bg-white/10"><X size={17} /></button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5 bg-slate-50">
            {msgs.length === 0 && (
              <div className="text-sm text-slate-500 space-y-2">
                <p>Me pergunte qualquer coisa sobre os clientes do CRM. Exemplos:</p>
                <div className="flex flex-wrap gap-1.5">
                  {sugestoes.map((s) => (
                    <button key={s} onClick={() => setInput(s.replace(' …', ' ').replace('…', ''))} className="text-xs rounded-full border border-slate-300 bg-white px-2.5 py-1 hover:bg-slate-100 text-slate-600">{s}</button>
                  ))}
                </div>
                <p className="text-[11px] text-slate-400">Eu só leio o CRM e peço simulações (que ficam só pra equipe). Não mando mensagem a cliente nem mexo em card.</p>
              </div>
            )}
            {msgs.map((m, i) => (
              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                <div className={cn('max-w-[88%] rounded-2xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]', m.role === 'user' ? 'bg-[#2261a8] text-white rounded-br-sm' : 'bg-white text-slate-800 border border-slate-200 rounded-bl-sm')}>
                  {m.content}
                  {m.attachments?.map((a) => <SimulationCard key={a.id} a={a} />)}
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
              placeholder="Ex.: preciso da simulação do cliente Pedro Francisco"
              className="flex-1 resize-none rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm text-slate-800 focus:outline-none focus:border-[#2261a8]"
            />
            <button onClick={() => send()} disabled={sending || !input.trim()} className="self-end rounded-lg px-3 py-2 text-white disabled:opacity-50" style={{ backgroundColor: '#2261a8' }} aria-label="Enviar">
              {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
            </button>
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'fixed z-40 bottom-[76px] right-4 md:bottom-[84px] md:right-5 w-[48px] h-[48px] rounded-full text-white shadow-lg flex items-center justify-center hover:brightness-110 transition',
          hideOnMobile && !open && 'hidden md:flex',
        )}
        style={{ backgroundColor: '#1e1b4b' }}
        aria-label="Assistente do CRM"
        title="Assistente do CRM — pergunte sobre qualquer cliente"
      >
        {open ? <X size={20} /> : <Bot size={22} />}
      </button>
    </>
  );
}
