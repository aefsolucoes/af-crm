'use client';
import { useState } from 'react';
import type { Bank } from './shared';

/** Logo do banco. Se existir a imagem oficial em `public/banks/<santander|creditas|inter>.png` ela é usada; senão, um emblema desenhado na cor do banco (não é a marca oficial). */
const FILE: Record<Bank, string> = { CREDIMORAR: 'santander', CREDITAS: 'creditas', INTER: 'inter' };

export function BankLogo({ bank, size = 40 }: { bank: Bank; size?: number }) {
  const [semImagem, setSemImagem] = useState(false);
  const base = { width: size, height: size } as const;
  if (!semImagem) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={`/banks/${FILE[bank]}.png`} alt={FILE[bank]} {...base} className="rounded-lg object-contain bg-white" onError={() => setSemImagem(true)} />
    );
  }
  if (bank === 'CREDIMORAR') {
    // Santander: círculo vermelho com a chama estilizada
    return (
      <svg {...base} viewBox="0 0 40 40" role="img" aria-label="Santander">
        <circle cx="20" cy="20" r="20" fill="#EC0000" />
        <path d="M20 7c1.2 3.4-.6 5-2.3 7-1.9 2.2-3.1 4.6-2.6 7.6.5-1.6 1.9-2.8 3.3-3.3-.3 2 .6 3.4 1.7 4.6 1.4 1.5 1.9 3.3 1.1 5.4 2.9-.9 5.2-3.8 5-7.3-.1-2.7-1.6-4.3-2.6-6.2-.9-1.8-1-3.8-.2-5.8-2.3.4-3.4 2.1-3.4 3.9C18.9 11.9 20.2 9.6 20 7z" fill="#fff" />
        <rect x="9" y="29" width="22" height="2.6" rx="1.3" fill="#fff" />
      </svg>
    );
  }
  if (bank === 'INTER') {
    // Inter: quadrado arredondado laranja com "inter"
    return (
      <svg {...base} viewBox="0 0 40 40" role="img" aria-label="Inter">
        <rect width="40" height="40" rx="9" fill="#FF7A00" />
        <text x="20" y="25" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="13" fill="#fff">inter</text>
      </svg>
    );
  }
  // Creditas: círculo verde com "c"
  return (
    <svg {...base} viewBox="0 0 40 40" role="img" aria-label="Creditas">
      <circle cx="20" cy="20" r="20" fill="#0B8F5B" />
      <text x="20" y="28" textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontWeight="700" fontSize="24" fill="#fff">c</text>
    </svg>
  );
}
