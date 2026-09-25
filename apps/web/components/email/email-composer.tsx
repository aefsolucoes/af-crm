'use client';
import { useState } from 'react';
import { Send, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';

export interface MailboxOption {
  id: string;
  address: string;
  displayName: string | null;
  shared: boolean;
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

  async function send() {
    if (!mailboxId) { toast('Nenhuma caixa de e-mail disponível', 'error'); return; }
    if (!toValue.trim() || !body.trim()) { toast('Preencha o destinatário e a mensagem', 'warning'); return; }
    setSending(true);
    try {
      await api.post(`/api/email/accounts/${mailboxId}/send`, { to: toValue, cc, subject: subjectValue, body, replyToId, leadId });
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
        <p className="text-[11px] text-slate-400">
          {replyToId ? 'A mensagem original vai citada embaixo. ' : ''}A assinatura entra automaticamente.
        </p>
        <div className="flex justify-end gap-2 pt-1">
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
