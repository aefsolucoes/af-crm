'use client';
import { Fragment, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Mail, Paperclip } from 'lucide-react';

/** Um e-mail do fio (GET /api/email/thread/:id). text = parte nova; full = com o histórico citado. */
export interface ThreadMessage {
  id: string;
  folder: string;
  date: string;
  fromName: string | null;
  fromAddress: string | null;
  to: string[];
  cc: string[];
  subject: string | null;
  text: string;
  full: string | null;
  attachments: string[];
  respondendo: boolean;
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;
function comLinks(text: string) {
  return text.split(URL_RE).map((p, i) => (i % 2
    ? <a key={i} href={p} target="_blank" rel="noreferrer" className="text-af-mid underline break-all">{p}</a>
    : <Fragment key={i}>{p}</Fragment>));
}

function quando(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function Item({ m, aberto, onToggle }: { m: ThreadMessage; aberto: boolean; onToggle: () => void }) {
  const [citado, setCitado] = useState(false);
  const quem = m.fromName || m.fromAddress || '—';
  return (
    <div className={`border-t border-af-border first:border-t-0 ${m.respondendo ? 'bg-blue-50/40' : ''}`}>
      <button type="button" onClick={onToggle} className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-slate-50">
        {aberto ? <ChevronDown size={14} className="mt-0.5 flex-shrink-0 text-slate-400" /> : <ChevronRight size={14} className="mt-0.5 flex-shrink-0 text-slate-400" />}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-xs font-semibold text-slate-700">{m.folder === 'SENT' ? `Nós (${quem})` : quem}</span>
            {m.respondendo && <span className="flex-shrink-0 rounded bg-blue-100 px-1.5 py-px text-[10px] font-medium text-[#2261a8]">respondendo</span>}
            {m.attachments.length > 0 && <Paperclip size={11} className="flex-shrink-0 text-slate-400" />}
            <span className="ml-auto flex-shrink-0 text-[10px] text-slate-400">{quando(m.date)}</span>
          </span>
          {!aberto && <span className="block truncate text-[11px] text-slate-500">{m.text.replace(/\s+/g, ' ').slice(0, 160) || '(sem texto)'}</span>}
        </span>
      </button>
      {aberto && (
        <div className="px-3 pb-3 pl-8 space-y-1.5">
          <div className="text-[11px] leading-4 text-slate-500 space-y-0.5 break-words">
            {m.fromAddress && <p><span className="text-slate-400">De:</span> {m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress}</p>}
            {m.to.length > 0 && <p><span className="text-slate-400">Para:</span> {m.to.join(', ')}</p>}
            {m.cc.length > 0 && <p><span className="text-slate-400">Cc:</span> {m.cc.join(', ')}</p>}
            {m.subject && <p><span className="text-slate-400">Assunto:</span> {m.subject}</p>}
          </div>
          <p className="whitespace-pre-wrap break-words text-[13px] leading-5 text-slate-700">{m.text ? comLinks(m.text) : '(sem texto)'}</p>
          {m.attachments.length > 0 && (
            <p className="flex items-start gap-1 text-[11px] text-slate-500"><Paperclip size={11} className="mt-0.5 flex-shrink-0" /> <span className="break-words">{m.attachments.join(', ')}</span></p>
          )}
          {m.full && (
            <>
              <button type="button" onClick={() => setCitado((v) => !v)} className="text-[11px] text-af-mid hover:underline">
                {citado ? 'Esconder o histórico citado' : 'Mostrar o histórico citado (•••)'}
              </button>
              {citado && (
                <p className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words border-l-[3px] border-slate-200 pl-3 text-[12px] leading-5 text-slate-500">{comLinks(m.full)}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Fio da conversa por e-mail embaixo da resposta, como no Outlook (Fabio 18/11: "abra o restante dos e-mails"): o e-mail que está
 * sendo respondido já vem aberto; os outros do fio ficam numa linha e abrem com um clique (ou "Abrir todos").
 */
export function EmailThread({ messages, loading }: { messages: ThreadMessage[] | null; loading: boolean }) {
  const [abertos, setAbertos] = useState<Set<string> | null>(null);
  const [visivel, setVisivel] = useState(true);
  if (loading) return <div className="flex items-center gap-2 text-[11px] text-slate-400"><Loader2 size={12} className="animate-spin" /> Buscando os e-mails anteriores...</div>;
  if (!messages?.length) return null;
  const set = abertos ?? new Set(messages.filter((m) => m.respondendo).map((m) => m.id));
  const todosAbertos = messages.every((m) => set.has(m.id));
  const toggle = (id: string) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); setAbertos(n); };
  return (
    <div className="rounded-lg border border-af-border bg-white">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-af-border bg-slate-50 rounded-t-lg">
        <button type="button" onClick={() => setVisivel((v) => !v)} className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-slate-700">
          {visivel ? <ChevronDown size={14} className="text-slate-400" /> : <ChevronRight size={14} className="text-slate-400" />}
          <Mail size={13} className="text-af-mid" />
          <span className="truncate">{messages.length > 1 ? `E-mails anteriores do fio (${messages.length})` : 'E-mail que você está respondendo'}</span>
        </button>
        {visivel && messages.length > 1 && (
          <button type="button" onClick={() => setAbertos(todosAbertos ? new Set() : new Set(messages.map((m) => m.id)))} className="ml-auto flex-shrink-0 text-[11px] text-af-mid hover:underline">
            {todosAbertos ? 'Fechar todos' : 'Abrir todos'}
          </button>
        )}
      </div>
      {visivel && <div>{messages.map((m) => <Item key={m.id} m={m} aberto={set.has(m.id)} onToggle={() => toggle(m.id)} />)}</div>}
    </div>
  );
}
