'use client';
import { Suspense } from 'react';
import { FunilView } from '@/components/funil/funil-view';

// Item único de menu ("Funil de Vendas") — substitui os 3 antigos
// (Habitação/Consórcio/Home Equity), cada um com sua própria tela fixa. O
// seletor de setor dentro de FunilView escolhe qual ver agora.
export default function FunilPage() {
  return (
    <Suspense fallback={null}>
      <FunilView />
    </Suspense>
  );
}
