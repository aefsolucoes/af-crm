'use client';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Ban, ExternalLink, X, Paperclip, SendHorizontal, Trash2, FileText, Image as ImageIcon, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast';
import { DocumentCard, SimulationCard, CopyCard, RecorderCard, VoicePicker, type Attachment, type AudioReq, type CopyReq, type Nav, type Pending, type Voice } from '@/components/ui/jarvis-cards';

/* CHAT POR TEXTO do Jarvis (Fabio 23/11: "abrir o chat para fazer as funções novamente, exemplo: colocar documentação, pedir para criar card, rodar crédito").
 * Painel à direita (no celular, tela cheia) aberto pelo 💬 da bolinha. A conversa é a MESMA da voz: o que se fala na bolinha também entra aqui.
 * Ação que mexe com cliente, card, Drive, e-mail, análise ou regra da IA só sai no Confirmar (ou "sim" digitado). Arquivo: 📎, arrastar ou colar. */

export type ChatItem = {
  id: string; role: 'user' | 'assistant'; texto: string; at: number; arquivos?: string[];
  pending?: Pending[]; attachments?: Attachment[]; nav?: Nav | null; audio?: AudioReq | null; copiar?: CopyReq[]; escolherVoz?: boolean; erro?: boolean;
};

const MAX_ARQ = 20_000_000;
const kb = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
const aceito = (f: File) => f.type === 'application/pdf' || f.type.startsWith('image/') || /\.(pdf|jpe?g|png|heic|heif|webp)$/i.test(f.name);

/** **negrito** e quebras de linha; o resto como texto (o Jarvis no chat responde curto, com "•"). */
function Texto({ t }: { t: string }) {
  const partes = String(t || '').split(/(\*\*[^*\n]+\*\*)/g);
  return <>{partes.map((p, i) => (/^\*\*[^*]+\*\*$/.test(p) ? <strong key={i}>{p.slice(2, -2)}</strong> : <Fragment key={i}>{p}</Fragment>))}</>;
}

export function JarvisChat(p: {
  itens: ChatItem[];
  pensando: boolean;
  status: string;
  orb: ReactNode;
  vozLigada: boolean;
  vozAtual: string;
  primeiroNome: string;
  onEnviar: (texto: string, arquivos: File[]) => Promise<boolean>;
  onConfirmar: (id: string) => void;
  onCancelar: (id: string) => void;
  onAbrir: (path: string) => void;
  onMic: () => void;
  onFechar: () => void;
  onLimpar: () => void;
  onAudioFeito: (itemId: string, msg: string) => void;
  onEscolherVoz: (v: Voice) => void;
}) {
  const [texto, setTexto] = useState('');
  const [arquivos, setArquivos] = useState<File[]>([]);
  const [arrastando, setArrastando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const fimRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { fimRef.current?.scrollIntoView({ block: 'end' }); }, [p.itens.length, p.pensando]);
  useEffect(() => { const t = setTimeout(() => taRef.current?.focus(), 50); return () => clearTimeout(t); }, []);
  useEffect(() => { // textarea cresce até ~5 linhas
    const ta = taRef.current; if (!ta) return;
    ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 130)}px`;
  }, [texto]);

  function juntar(lista: File[] | FileList | null) {
    const fs = Array.from(lista || []);
    if (!fs.length) return;
    const ok: File[] = [];
    for (const f of fs) {
      if (!aceito(f)) { toast(`${f.name}: só PDF ou foto`, 'error'); continue; }
      if (f.size > MAX_ARQ) { toast(`${f.name}: passa de 20 MB`, 'error'); continue; }
      ok.push(f);
    }
    setArquivos((a) => [...a, ...ok].slice(0, 10));
  }
  async function enviar() {
    const t = texto.trim();
    if ((!t && !arquivos.length) || enviando || p.pensando) return;
    setEnviando(true);
    const ok = await p.onEnviar(t, arquivos).catch(() => false);
    setEnviando(false);
    if (ok) { setTexto(''); setArquivos([]); }
    taRef.current?.focus();
  }

  const exemplos = ['Cria um card pro João Silva, 61 99999-8888, Home Equity', 'Anexa este RG no card da Maria Souza', 'Roda o crédito do Pedro no Inter', 'Quem mandou documento e precisa de andamento?'];

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-white text-slate-800 shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:w-[410px] md:border-l md:border-slate-200"
      onDragOver={(e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setArrastando(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setArrastando(false); }}
      onDrop={(e) => { e.preventDefault(); setArrastando(false); juntar(e.dataTransfer?.files || null); }}
    >
      <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
        <button onClick={p.onMic} className="h-9 w-9 shrink-0 rounded-full focus:outline-none" title={p.vozLigada ? 'Encerrar a conversa por voz' : 'Falar com o Jarvis (voz)'} aria-label="Voz">{p.orb}</button>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-sm font-semibold">Jarvis</div>
          <div className="truncate text-[11px] text-slate-500">{p.status || (p.vozLigada ? 'Voz ligada — toque na bolinha pra encerrar' : 'Toque na bolinha pra falar')}</div>
        </div>
        <button onClick={() => { if (confirm('Apagar esta conversa do chat? (as ações já feitas continuam no CRM)')) p.onLimpar(); }} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="Limpar conversa"><Trash2 size={16} /></button>
        <button onClick={p.onFechar} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" title="Fechar o chat"><X size={18} /></button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {!p.itens.length && (
          <div className="mt-6 space-y-2 text-sm text-slate-500">
            <p>{p.primeiroNome ? `Oi, ${p.primeiroNome}.` : 'Oi.'} Pode pedir por escrito, anexar documentos (📎, arrastar ou colar) ou tocar na bolinha pra falar.</p>
            <p className="text-xs">Tudo que mexe com cliente, card, Drive, e-mail ou análise só sai quando você clicar em <b>Confirmar</b>.</p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {exemplos.map((e) => <button key={e} onClick={() => { setTexto(e); taRef.current?.focus(); }} className="rounded-full border border-slate-200 px-2.5 py-1 text-left text-xs text-slate-600 hover:bg-slate-50">{e}</button>)}
            </div>
          </div>
        )}
        {p.itens.map((m) => (m.role === 'user' ? (
          <div key={m.id} className="flex flex-col items-end">
            {m.texto && <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-[#2261a8] px-3 py-2 text-sm text-white">{m.texto}</div>}
            {m.arquivos?.map((a, i) => <div key={i} className="mt-1 flex max-w-[85%] items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600"><FileText size={12} className="shrink-0 text-blue-500" /><span className="truncate">{a}</span></div>)}
          </div>
        ) : (
          <div key={m.id} className="flex flex-col items-start">
            <div className={cn('max-w-[92%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm', m.erro ? 'bg-red-50 text-red-700' : 'bg-slate-100')}>
              {m.texto && <div className="whitespace-pre-wrap break-words leading-snug"><Texto t={m.texto} /></div>}
              {m.attachments?.map((a) => (a.type === 'document' ? <DocumentCard key={`${a.source}:${a.ref}`} a={a} /> : <SimulationCard key={a.id} a={a} />))}
              {m.copiar?.map((c, i) => <CopyCard key={i} c={c} />)}
              {m.escolherVoz && <VoicePicker atual={p.vozAtual} primeiroNome={p.primeiroNome} onPick={p.onEscolherVoz} />}
              {m.audio && <RecorderCard req={m.audio} onDone={(msg) => p.onAudioFeito(m.id, msg)} />}
              {m.pending?.map((x) => (
                <div key={x.id} className={cn('mt-2 rounded-lg border p-2 text-xs', x.estado === 'PENDENTE' ? 'border-amber-300 bg-amber-50' : x.estado === 'ERRO' ? 'border-red-200 bg-red-50' : 'border-slate-200 bg-white')}>
                  <div className="max-h-56 overflow-y-auto whitespace-pre-wrap text-slate-700">{x.descricao}</div>
                  {x.estado === 'PENDENTE' ? (
                    <div className="mt-1.5 flex gap-1.5">
                      <button onClick={() => p.onConfirmar(x.id)} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 font-medium text-white hover:brightness-110"><Check size={12} /> Confirmar</button>
                      <button onClick={() => p.onCancelar(x.id)} className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-slate-600 hover:bg-slate-100"><Ban size={12} /> Cancelar</button>
                    </div>
                  ) : (
                    <div className={cn('mt-1 font-medium', x.estado === 'ERRO' ? 'text-red-600' : x.estado === 'CANCELADO' ? 'text-slate-500' : 'text-emerald-700')}>
                      {x.resultado === 'Fazendo…' ? <span className="inline-flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Fazendo…</span> : x.resultado}
                    </div>
                  )}
                  {x.nav?.path && <button onClick={() => p.onAbrir(x.nav!.path)} className="mt-1 flex items-center gap-1 font-medium text-[#2261a8] hover:underline"><ExternalLink size={11} /> {x.nav.label}</button>}
                </div>
              ))}
              {m.nav?.path && <button onClick={() => p.onAbrir(m.nav!.path)} className="mt-1.5 flex items-center gap-1 text-xs font-medium text-[#2261a8] hover:underline"><ExternalLink size={12} /> {m.nav.label}</button>}
            </div>
          </div>
        )))}
        {p.pensando && <div className="flex items-center gap-1.5 text-xs text-slate-500"><Loader2 size={13} className="animate-spin" /> Pensando…</div>}
        <div ref={fimRef} />
      </div>

      <div className="border-t border-slate-200 p-2" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
        {arquivos.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {arquivos.map((f, i) => (
              <span key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">
                {f.type.startsWith('image/') ? <ImageIcon size={12} className="shrink-0 text-emerald-600" /> : <FileText size={12} className="shrink-0 text-blue-500" />}
                <span className="max-w-[200px] truncate">{f.name}</span><span className="text-slate-400">{kb(f.size)}</span>
                <button onClick={() => setArquivos((a) => a.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500" title="Tirar"><X size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <input ref={inputRef} type="file" multiple accept="application/pdf,image/*,.heic,.heif" className="hidden" onChange={(e) => { juntar(e.target.files); e.target.value = ''; }} />
          <button onClick={() => inputRef.current?.click()} className="mb-0.5 rounded-lg p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700" title="Anexar PDF ou foto"><Paperclip size={18} /></button>
          <textarea
            ref={taRef}
            value={texto}
            rows={1}
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void enviar(); } }}
            onPaste={(e) => { const fs = Array.from(e.clipboardData?.files || []); if (fs.length) { e.preventDefault(); juntar(fs); } }}
            placeholder={arquivos.length ? 'O que faço com o arquivo? (ex.: anexa no card do João)' : 'Escreva pro Jarvis…'}
            className="max-h-[130px] min-h-[38px] flex-1 resize-none rounded-xl border border-slate-300 px-3 py-2 text-sm focus:border-[#2261a8] focus:outline-none"
          />
          <button onClick={() => void enviar()} disabled={enviando || p.pensando || (!texto.trim() && !arquivos.length)} className="mb-0.5 rounded-lg bg-[#2261a8] p-2 text-white hover:brightness-110 disabled:opacity-40" title="Enviar">
            {enviando ? <Loader2 size={18} className="animate-spin" /> : <SendHorizontal size={18} />}
          </button>
        </div>
      </div>

      {arrastando && <div className="pointer-events-none absolute inset-0 flex items-center justify-center border-2 border-dashed border-[#2261a8] bg-white/85 text-sm font-medium text-[#2261a8]">Solte o PDF ou a foto aqui</div>}
    </div>
  );
}
