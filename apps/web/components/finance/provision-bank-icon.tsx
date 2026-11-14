'use client';
import { useState } from 'react';
import { cn } from '@/lib/utils';

/** Símbolo do banco do processo (Fabio 14/11). "Credimorar (Inter)" = banco Inter pago pela Credimorar; "Credimorar" sozinho no Home Equity = Santander.
 *  Sem banco no card: "?" cinza (a taxa é a padrão do produto). Banco sem imagem em public/banks (BRB…): a sigla. */
const BANK_FILE: Array<[RegExp, string, string]> = [
  [/inter/i, 'inter.png', 'Inter'],
  [/creditas/i, 'creditas-simbolo.svg', 'Creditas'],
  [/santander/i, 'santander.png', 'Santander'],
  [/bradesco/i, 'bradesco.png', 'Bradesco'],
  [/ita[uú]/i, 'itau.png', 'Itaú'],
  [/caixa/i, 'caixa.png', 'CAIXA'],
];
/** Nome do banco do processo (o mesmo do símbolo): "Credimorar (Inter)" → Inter; Credimorar no Home Equity → Santander; sem banco → ''. */
export function bancoDaProvisao(payer?: string | null, product?: string | null): string {
  const banco = ((/\(([^)]+)\)/.exec(payer || '') || [])[1] || payer || '').trim();
  if (/^credimorar$/i.test(banco) && /home equity/i.test(product || '')) return 'Santander';
  const hit = BANK_FILE.find(([rx]) => rx.test(banco));
  return hit ? hit[2] : banco;
}
export function ProvisionBankIcon({ payer, product }: { payer?: string | null; product?: string | null }) {
  const [semImagem, setSemImagem] = useState(false);
  const nome = bancoDaProvisao(payer, product);
  const hit = BANK_FILE.find(([rx]) => rx.test(nome));
  const box = 'w-8 h-8 flex-shrink-0 rounded-lg';
  if (hit && !semImagem) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={`/banks/${hit[1]}`} alt={hit[2]} title={payer || hit[2]} className={cn(box, 'object-contain bg-white border border-af-border p-0.5')} onError={() => setSemImagem(true)} />;
  }
  const sigla = nome ? nome.replace(/[^A-Za-zÀ-ú]/g, '').slice(0, 3).toUpperCase() : '?';
  return (
    <span title={payer || 'Banco não identificado no card — taxa padrão do produto'} className={cn(box, 'flex items-center justify-center text-[10px] font-bold', nome ? 'bg-slate-100 text-slate-600' : 'bg-amber-50 text-amber-600 border border-amber-200')}>
      {sigla}
    </span>
  );
}

