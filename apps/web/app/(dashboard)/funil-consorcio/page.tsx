'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Rota antiga (item de menu próprio) virou o seletor de setor dentro de
// /funil — mantido só como redirect pra não quebrar favorito/link salvo.
export default function FunilConsorcioRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace('/funil?dep=' + encodeURIComponent('Consórcio'));
  }, [router]);
  return null;
}
