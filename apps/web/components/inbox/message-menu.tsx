'use client';
import { useEffect, useRef, useState } from 'react';
import { Message } from '@/types';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { MoreVertical, Reply, Forward, Copy, Pin, PinOff, Star, Trash2, Loader2, Download } from 'lucide-react';

const QUICK_EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

interface MessageMenuProps {
  message: Message;
  isOut: boolean;
  onReply: () => void;
  onForward: () => void;
  onDeleted: (id: string) => void;
  onReaction: (id: string, reactions: { emoji: string; fromMe: boolean; at: string }[]) => void;
  onPinned: (id: string, pinned: boolean) => void;
  onStarred: (id: string, starred: boolean) => void;
}

/** Menu (⋮) ancorado por mensagem, estilo WhatsApp Desktop — primeiro
 *  dropdown ancorado do projeto (antes só existiam modais full-screen). Fica
 *  no lugar dos 2 ícones soltos de hover (Responder/Encaminhar) que existiam
 *  antes; esses dois continuam aqui dentro, junto dos novos. */
export function MessageMenu({ message, isOut, onReply, onForward, onDeleted, onReaction, onPinned, onStarred }: MessageMenuProps) {
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setConfirmingDelete(false);
  }

  async function handleReact(emoji: string) {
    setBusy(true);
    try {
      const { data } = await api.post(`/api/messages/${message.id}/react`, { emoji });
      onReaction(message.id, data.reactions || []);
      close();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao reagir', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleTogglePin() {
    setBusy(true);
    try {
      const nextPinned = !message.pinned;
      const { data } = await api.post(`/api/messages/${message.id}/pin`, { pinned: nextPinned });
      onPinned(message.id, data.pinned);
      close();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao fixar', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleStar() {
    setBusy(true);
    try {
      const nextStarred = !message.starred;
      const { data } = await api.post(`/api/messages/${message.id}/star`, { starred: nextStarred });
      onStarred(message.id, data.starred);
      close();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao favoritar', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await api.post(`/api/messages/${message.id}/delete`);
      onDeleted(message.id);
      close();
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao apagar', 'error');
    } finally {
      setBusy(false);
    }
  }

  function handleCopy() {
    if (message.content) {
      navigator.clipboard.writeText(message.content).then(() => toast('Copiado!')).catch(() => {});
    }
    close();
  }

  // Baixa todos os anexos da mensagem (quase sempre 1) — mesmo endpoint que
  // o preview em tela cheia usa, só que disparado daqui, sem precisar abrir
  // a imagem/documento primeiro.
  async function handleDownload() {
    if (!message.attachments || message.attachments.length === 0) return;
    setBusy(true);
    try {
      for (const att of message.attachments) {
        const res = await api.get(`/api/messages/attachment/${att.id}`, { responseType: 'blob' });
        const objUrl = URL.createObjectURL(res.data);
        const a = document.createElement('a');
        a.href = objUrl;
        a.download = att.fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objUrl);
      }
      close();
    } catch (err: any) {
      const isDrive = err?.response?.status === 410;
      toast(isDrive ? 'Arquivo salvo no Google Drive — não é possível baixar por aqui' : (err?.response?.data?.error || 'Erro ao baixar'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Mais opções"
        className={cn('text-[#8696a0] hover:text-[#e9edef] transition-colors', open && 'text-[#e9edef]')}
      >
        <MoreVertical size={14} />
      </button>

      {open && (
        <div
          className={cn(
            'absolute z-20 top-full mt-1 w-52 rounded-lg shadow-xl overflow-hidden py-1',
            isOut ? 'right-0' : 'left-0'
          )}
          style={{ backgroundColor: '#233138' }}
        >
          <div className="flex items-center justify-around px-2 py-2 border-b border-[#182229]">
            {QUICK_EMOJI.map((emoji) => (
              <button
                key={emoji}
                onClick={() => handleReact(emoji)}
                disabled={busy}
                className="text-lg hover:scale-125 transition-transform disabled:opacity-40"
              >
                {emoji}
              </button>
            ))}
          </div>

          {confirmingDelete ? (
            <div className="px-3 py-2 flex items-center justify-between gap-2">
              <span className="text-xs text-[#e9edef]">Apagar mensagem?</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button onClick={() => setConfirmingDelete(false)} className="text-xs text-[#8696a0] hover:text-[#e9edef]">Não</button>
                <button onClick={handleDelete} disabled={busy} className="text-xs font-medium text-red-400 hover:text-red-300 flex items-center gap-1">
                  {busy ? <Loader2 size={12} className="animate-spin" /> : null} Apagar
                </button>
              </div>
            </div>
          ) : (
            <>
              <MenuItem icon={<Reply size={14} />} label="Responder" onClick={() => { onReply(); close(); }} />
              <MenuItem icon={<Forward size={14} />} label="Encaminhar" onClick={() => { onForward(); close(); }} />
              {message.attachments && message.attachments.length > 0 && (
                <MenuItem
                  icon={busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  label="Baixar"
                  onClick={handleDownload}
                />
              )}
              <MenuItem icon={<Copy size={14} />} label="Copiar" onClick={handleCopy} />
              <MenuItem
                icon={message.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                label={message.pinned ? 'Desafixar' : 'Fixar'}
                onClick={handleTogglePin}
              />
              <MenuItem
                icon={<Star size={14} className={message.starred ? 'fill-current' : ''} />}
                label={message.starred ? 'Desfavoritar' : 'Favoritar'}
                onClick={handleToggleStar}
              />
              <MenuItem icon={<Trash2 size={14} />} label="Apagar" onClick={() => setConfirmingDelete(true)} danger />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left hover:bg-[#182229] transition-colors',
        danger ? 'text-red-400' : 'text-[#e9edef]'
      )}
    >
      {icon} {label}
    </button>
  );
}
