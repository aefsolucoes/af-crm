/** Link de card/conversa aberto SEM sessão (ou com a sessão vencida) passa pelo login e VOLTA pra onde o link apontava
 *  (Fabio 23/10: copiou o link do cliente e a Andreia, ao abrir, só caiu no CRM — o login mandava sempre pra /dashboard). */

/** /login?next=<caminho atual>, só quando o caminho vale a pena guardar. */
export function loginUrlWithNext(): string {
  if (typeof window === 'undefined') return '/login';
  const here = `${window.location.pathname}${window.location.search}`;
  if (!here || here === '/' || here.startsWith('/login') || here.startsWith('/dashboard')) return '/login';
  return `/login?next=${encodeURIComponent(here)}`;
}

/** Pra onde ir depois de entrar: o `next` do login se for um caminho interno seguro; senão o /dashboard. */
export function postLoginTarget(): string {
  if (typeof window === 'undefined') return '/dashboard';
  try {
    const next = new URLSearchParams(window.location.search).get('next') || '';
    // só caminho interno ("/inbox?leadId=..."): nada de "//site-de-fora", "/\\", nem voltar pro próprio login
    if (/^\/(?![/\\])/.test(next) && !next.startsWith('/login')) return next;
  } catch { /* usa o padrão */ }
  return '/dashboard';
}
