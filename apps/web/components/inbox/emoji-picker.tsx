'use client';
import { useEffect, useRef, useState } from 'react';
import { Smile } from 'lucide-react';
import { cn } from '@/lib/utils';

// Conjunto curado (não é a lista Unicode inteira, mas cobre o uso do dia a
// dia de atendimento) — mesmo espírito do QUICK_EMOJI do menu de reação,
// só que mais completo por ficar numa grade rolável em vez de uma fileira.
const CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: 'Sorrisos',
    emojis: [
      '😀', '😁', '😂', '🤣', '😊', '😇', '🙂', '🙃', '😉', '😍', '🥰', '😘',
      '😋', '😜', '🤪', '😎', '🤩', '🥳', '😏', '😌', '😴', '🤔', '🤗', '🤭',
      '😅', '😆', '🙁', '😢', '😭', '😤', '😡', '😱', '😳', '🥺', '😬', '🙄',
      '😐', '😑', '🤨', '😮', '🤝', '🫡',
    ],
  },
  {
    label: 'Gestos',
    emojis: ['👍', '👎', '👌', '✌️', '🤞', '🤝', '👏', '🙌', '🙏', '💪', '👋', '🤙', '✋', '☝️', '👆', '👇', '👉', '👈'],
  },
  {
    label: 'Corações',
    emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '❣️', '💕', '💞'],
  },
  {
    label: 'Negócios',
    emojis: ['💰', '💵', '💳', '📈', '📉', '📊', '💼', '📅', '📌', '📎', '📝', '✅', '❌', '⏰', '🔒', '🔑', '📞', '📱', '💻', '✉️', '🏠', '🏢', '🎯', '🏆'],
  },
  {
    label: 'Símbolos',
    emojis: ['🔥', '✨', '⭐', '💯', '❗', '❓', '⚠️', '🚫', '🔴', '🟢', '🟡', '🔵'],
  },
  {
    label: 'Outros',
    emojis: ['☕', '🎉', '🎂', '🚗', '✈️', '🏡', '📍', '🎁'],
  },
];

interface EmojiPickerButtonProps {
  onSelect: (emoji: string) => void;
  disabled?: boolean;
}

/** Botão de emoji da barra de mensagem — ficava só de enfeite (ícone sem
 *  nenhum onClick), clicar não fazia nada. Agora abre um seletor ancorado
 *  (mesmo padrão do menu ⋮ por mensagem: só o próprio componente sabe se
 *  está aberto, trigger+popover num único ref, fecha ao clicar fora ou Esc
 *  sem fechar a conversa inteira junto). */
export function EmojiPickerButton({ onSelect, disabled }: EmojiPickerButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        // Captura ANTES do listener global de Esc do chat-window (que fecha
        // a conversa inteira) — sem isso, Esc fechava o seletor E a
        // conversa no mesmo toque.
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title="Emoji"
        className={cn('p-2 transition-colors disabled:opacity-40', open ? 'text-[#00a884]' : 'text-[#8696a0] hover:text-[#e9edef]')}
      >
        <Smile size={22} />
      </button>

      {open && (
        <div
          className="absolute z-20 bottom-full left-0 mb-2 w-72 h-72 rounded-lg shadow-xl overflow-hidden flex flex-col"
          style={{ backgroundColor: '#233138' }}
        >
          <div className="flex-1 overflow-y-auto scrollbar-thin p-2 space-y-2.5">
            {CATEGORIES.map((cat) => (
              <div key={cat.label}>
                <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[#8696a0]">{cat.label}</p>
                <div className="grid grid-cols-8">
                  {cat.emojis.map((emoji, idx) => (
                    <button
                      key={`${cat.label}-${idx}`}
                      type="button"
                      // Mantém aberto após escolher — deixa emendar vários
                      // emoji seguidos, igual o seletor de verdade do WhatsApp.
                      onClick={() => onSelect(emoji)}
                      className="text-lg leading-none py-1.5 rounded hover:bg-[#182229] transition-colors"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
