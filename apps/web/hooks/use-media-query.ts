'use client';
import { useEffect, useState } from 'react';

/** Primeiro hook de media query do projeto — usar só onde a árvore de
 *  componentes precisa montar coisas DIFERENTES por breakpoint (ex.: Sidebar
 *  vira drawer, Inbox mostra um painel por vez). Pra tudo que é só visual
 *  (grid/stack/overflow), usar classes Tailwind puras — sem JS, sem flash,
 *  sem depender de hidratação pra acertar o layout. */
export function useMediaQuery(query: string): boolean {
  // Default "desktop" até montar no client — evita layout diferente entre o
  // HTML exportado estaticamente e a primeira pintura real no navegador.
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

/** Corte mobile/desktop do projeto: `md` do Tailwind (768px) — mesmo
 *  breakpoint já usado nos poucos lugares responsivos existentes
 *  (`md:grid-cols-2` etc.) e o que mantém a sidebar fixa útil em tablet. */
export const useIsMobile = () => useMediaQuery('(max-width: 767px)');
