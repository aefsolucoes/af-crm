'use client';
import { useRef, useState } from 'react';
import { Send, Loader2, Paperclip, X } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';

// Mesmo limite do servidor (email-inbox.service.ts): cabe no ~25 MB do provedor.
const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 15 * 1024 * 1024;

interface PickedFile { name: string; type: string; size: number; dataBase64: string }

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function formatSize(bytes: number) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export interface MailboxOption {
  id: string;
  address: string;
  displayName: string | null;
  shared: boolean;
  /** Assinatura que vai no fim do e-mail (a da caixa ou a padrão). */
  signature?: string;
}

/**
 * Janela de escrever/responder e-mail — usada na página E-mail e no card do
 * cliente. Em resposta (replyToId), o servidor cita o e-mail original embaixo
 * e mantém o mesmo fio; com leadId, o enviado aparece na conversa do card.
 */
export function EmailComposer({
  mailboxes, defaultMailboxId, to = '', subject = '', replyToId = null, leadId = null, onClose, onSent,
}: {
  mailboxes: MailboxOption[];
  defaultMailboxId?: string;
  to?: string;
  subject?: string;
  replyToId?: string | null;
  leadId?: string | null;
  onClose: () => void;
  onSent?: () => void;
}) {
  const [mailboxId, setMailboxId] = useState(defaultMailboxId || mailboxes.find((m) => !m.shared)?.id || mailboxes[0]?.id || '');
  const [toValue, setToValue] = useState(to);
  const [cc, setCc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [subjectValue, setSubjectValue] = useState(subject);
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    const picked = Array.from(list);
    if (files.length + picked.length > MAX_FILES) { toast(`No máximo ${MAX_FILES} anexos por e-mail`, 'warning'); return; }
    const newTotal = totalBytes + picked.reduce((sum, f) => sum + f.size, 0);
    if (newTotal > MAX_TOTAL_BYTES) { toast('Os anexos passam de 15 MB — mande em mais de um e-mail ou use um link do Drive', 'warning'); return; }
    try {
      const read = await Promise.all(picked.map(async (f) => ({ name: f.name, type: f.type || 'application/octet-stream', size: f.size, dataBase64: await readAsBase64(f) })));
      setFiles((prev) => [...prev, ...read]);
    } catch {
      toast('Não consegui ler o arquivo', 'error');
    }
  }

  async function send() {
    if (!mailboxId) { toast('Nenhuma caixa de e-mail disponível', 'error'); return; }
    if (!toValue.trim() || !body.trim()) { toast('Preencha o destinatário e a mensagem', 'warning'); return; }
    setSending(true);
    try {
      await api.post(`/api/email/accounts/${mailboxId}/send`, {
        to: toValue, cc, subject: subjectValue, body, replyToId, leadId,
        attachments: files.map((f) => ({ filename: f.name, contentType: f.type, dataBase64: f.dataBase64 })),
      });
      toast('E-mail enviado');
      onSent?.();
      onClose();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não consegui enviar o e-mail', 'error');
    } finally {
      setSending(false);
    }
  }

  const field = 'w-full text-sm px-3 py-2 border border-af-border rounded-lg focus:outline-none focus:ring-2 focus:ring-af-accent text-slate-800';

  return (
    <Modal title={replyToId ? 'Responder e-mail' : 'Novo e-mail'} onClose={onClose} onBackdropClick={() => {}} size="lg">
      <div className="space-y-2.5">
        <div className="flex items-center gap-2">
          <label className="w-14 text-xs text-slate-500 flex-shrink-0">De</label>
          <select value={mailboxId} onChange={(e) => setMailboxId(e.target.value)} className={field} disabled={!!replyToId}>
            {mailboxes.map((m) => (
              <option key={m.id} value={m.id}>{m.shared ? `${m.displayName || 'Comercial'} — ` : ''}{m.address}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="w-14 text-xs text-slate-500 flex-shrink-0">Para</label>
          <input value={toValue} onChange={(e) => setToValue(e.target.value)} placeholder="cliente@exemplo.com (separe vários com vírgula)" className={field} />
          {!showCc && <button onClick={() => setShowCc(true)} className="text-xs text-af-mid hover:underline flex-shrink-0">Cc</button>}
        </div>
        {showCc && (
          <div className="flex items-center gap-2">
            <label className="w-14 text-xs text-slate-500 flex-shrink-0">Cc</label>
            <input value={cc} onChange={(e) => setCc(e.target.value)} className={field} />
          </div>
        )}
        <div className="flex items-center gap-2">
          <label className="w-14 text-xs text-slate-500 flex-shrink-0">Assunto</label>
          <input value={subjectValue} onChange={(e) => setSubjectValue(e.target.value)} className={field} />
        </div>
        <textarea
          autoFocus={!!replyToId || !!to}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          placeholder="Escreva a mensagem..."
          className={`${field} resize-y min-h-[180px]`}
        />
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="flex items-center gap-1.5 text-xs pl-2.5 pr-1.5 py-1 rounded-lg border border-af-border bg-slate-50 text-slate-600 max-w-[260px]">
                <Paperclip size={11} className="flex-shrink-0" />
                <span className="truncate">{f.name}</span>
                <span className="text-slate-400 flex-shrink-0">{formatSize(f.size)}</span>
                <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))} className="text-slate-400 hover:text-red-500 flex-shrink-0" title="Tirar anexo"><X size={12} /></button>
              </span>
            ))}
          </div>
        )}
        {(() => {
          const sig = mailboxes.find((m) => m.id === mailboxId)?.signature;
          return sig ? (
            <div className="border-l-[3px] border-blue-500/70 pl-3 py-0.5">
              {sig.split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => (
                <p key={i} className={i === 0 ? 'text-xs font-semibold text-slate-600' : 'text-[11px] text-slate-400'}>{l}</p>
              ))}
            </div>
          ) : null;
        })()}
        <p className="text-[11px] text-slate-400">
          {replyToId ? 'A mensagem original vai citada embaixo. ' : ''}Assinatura acima entra automaticamente (muda no lápis ao lado da caixa, na página E-mail).
        </p>
        <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={() => fileInput.current?.click()}
            disabled={sending}
            className="mr-auto flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border border-af-border text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <Paperclip size={14} /> Anexar
            {files.length > 0 && <span className="text-xs text-slate-400">({formatSize(totalBytes)} de 15 MB)</span>}
          </button>
          <button onClick={onClose} className="text-sm px-4 py-2 rounded-lg text-slate-500 hover:bg-slate-100">Cancelar</button>
          <button
            onClick={send}
            disabled={sending}
            className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg text-white font-medium disabled:opacity-50"
            style={{ backgroundColor: '#2261a8' }}
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Enviar
          </button>
        </div>
      </div>
    </Modal>
  );
}
