'use client';
import { useRef, useState } from 'react';
import { X } from 'lucide-react';

/**
 * Campo de destinatários como no Outlook (Fabio 18/11: "os e-mails após o enter vire um hiperlink"): cada endereço vira um chip
 * clicável (clicar = corrigir, X = tirar). Enter, vírgula, ponto e vírgula, espaço ou sair do campo fecham o endereço; colar
 * "Nome <a@b.com>; c@d.com" vira um chip por endereço. Endereço inválido fica vermelho e o envio não sai até corrigir.
 */
const EMAIL_OK = /^[^@\s<>,;"'()]+@[^@\s<>,;"'()]+\.[^@\s<>,;"'()]{2,}$/;

export const emailValido = (a: string) => EMAIL_OK.test(a);

/**
 * Texto digitado/colado → endereços. Fica cada pedaço com "@" (o nome em volta sai: "Felix, Daniela <dafelix@inter.co>" → dafelix@inter.co;
 * "errado@semponto" fica, pra aparecer vermelho). Sem nenhum "@", cada pedaço vira um item (também vermelho), pra não sumir o que foi digitado.
 */
export function splitAddresses(text: string | null | undefined): string[] {
  const t = String(text || '');
  const pedacos = t.split(/[\s,;<>()"'[\]]+/).map((s) => s.replace(/^mailto:/i, '').replace(/[.:]+$/, '').trim()).filter(Boolean);
  const comArroba = pedacos.filter((s) => s.includes('@'));
  const list = comArroba.length ? comArroba.map((a) => a.toLowerCase()) : t.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  return uniqAddresses(list);
}

export function uniqAddresses(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((a) => { const k = a.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
}

export function RecipientInput({ value, onChange, placeholder, autoFocus, label }: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Nome do campo pro leitor de tela ("Para", "Cc"...). */
  label: string;
}) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const comNovos = (base: string[], raw: string) => uniqAddresses([...base, ...splitAddresses(raw)]);
  function commit() {
    if (!text.trim()) return;
    onChange(comNovos(value, text));
    setText('');
  }
  function edit(i: number) {
    // Clicar no chip devolve o endereço pro campo, pra corrigir (o que estava sendo digitado vira chip antes).
    const resto = value.filter((_, j) => j !== i);
    onChange(text.trim() ? comNovos(resto, text) : resto);
    setText(value[i]);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  return (
    <div
      onClick={() => inputRef.current?.focus()}
      className="flex-1 min-w-0 min-h-[38px] flex flex-wrap items-center gap-1 px-2 py-1 border border-af-border rounded-lg bg-white cursor-text focus-within:ring-2 focus-within:ring-af-accent"
    >
      {value.map((a, i) => {
        const ok = emailValido(a);
        return (
          <span
            key={`${a}-${i}`}
            className={`inline-flex items-center max-w-full rounded-md border pl-2 pr-0.5 py-0.5 text-[13px] leading-5 ${ok ? 'border-blue-200 bg-blue-50 text-[#2261a8]' : 'border-red-300 bg-red-50 text-red-700'}`}
          >
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); edit(i); }}
              title={ok ? `${a} — clique pra corrigir` : 'Endereço inválido — clique pra corrigir'}
              className={`truncate underline underline-offset-2 ${ok ? 'decoration-blue-300 hover:decoration-[#2261a8]' : 'decoration-wavy decoration-red-400'}`}
            >
              {a}
            </button>
            <button
              type="button"
              aria-label={`Tirar ${a}`}
              onClick={(e) => { e.stopPropagation(); onChange(value.filter((_, j) => j !== i)); }}
              className="ml-0.5 flex-shrink-0 rounded p-1 hover:bg-black/10"
            >
              <X size={12} />
            </button>
          </span>
        );
      })}
      <input
        ref={inputRef}
        aria-label={label}
        value={text}
        autoFocus={autoFocus}
        type="text"
        inputMode="email"
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          // Separador digitado (inclusive no teclado do celular, que nem sempre manda o "Enter"): o que vem antes vira chip.
          const m = v.match(/^([\s\S]*)[,;\s]([^,;\s]*)$/);
          if (m && m[1].trim()) { onChange(comNovos(value, m[1])); setText(m[2]); return; }
          setText(v.replace(/^[,;\s]+/, ''));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Backspace' && !text && value.length) {
            // Apagar com o campo vazio: o último chip volta pro texto (dá pra corrigir ou continuar apagando).
            e.preventDefault();
            setText(value[value.length - 1]);
            onChange(value.slice(0, -1));
          }
        }}
        onPaste={(e) => {
          const colado = e.clipboardData.getData('text');
          if (/[,;\n<]/.test(colado) || splitAddresses(colado).length > 1) {
            e.preventDefault();
            onChange(comNovos(value, `${text} ${colado}`));
            setText('');
          }
        }}
        onBlur={commit}
        className="flex-1 min-w-[6rem] bg-transparent py-1 text-sm text-slate-800 outline-none placeholder:text-slate-400"
      />
    </div>
  );
}
