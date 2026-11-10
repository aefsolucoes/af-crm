'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';

/* Um botão só no menu (Fabio 10/11: "deixe apenas um botão de Análise de Crédito no canto esquerdo e quando entro lá aparece HE e FH para eu escolher").
 * A escolha fica lembrada neste navegador: o "Análise de Crédito" do menu abre o último produto escolhido (sidebar.tsx lê CHAVE_PRODUTO). */
export const CHAVE_PRODUTO = 'analise-credito-produto';
export const ANALISE_HREF = { he: '/analise-credito', fh: '/analise-financiamento' } as const;

export function lerProdutoEscolhido(): 'he' | 'fh' {
  try { return localStorage.getItem(CHAVE_PRODUTO) === 'fh' ? 'fh' : 'he'; } catch { return 'he'; }
}

export function ProdutoSwitch({ atual }: { atual: 'he' | 'fh' }) {
  useEffect(() => { try { localStorage.setItem(CHAVE_PRODUTO, atual); } catch { /* sem armazenamento: o menu abre o HE */ } }, [atual]);
  const item = (p: 'he' | 'fh', label: string) => (
    <Link
      href={ANALISE_HREF[p]}
      aria-current={atual === p ? 'page' : undefined}
      className={cn('rounded-lg px-4 py-1.5 text-sm font-medium transition-colors', atual === p ? 'bg-white text-slate-800 shadow' : 'text-[#C9D4EA] hover:bg-[#243052] hover:text-white')}
    >
      {label}
    </Link>
  );
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-xl border border-[#2C3A5E] bg-[#1B2440] p-1">
      {item('he', 'Home Equity')}
      {item('fh', 'Financiamento Imobiliário')}
    </div>
  );
}
