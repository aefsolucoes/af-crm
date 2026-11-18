'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Bell, X } from 'lucide-react';
import { getSocket } from '@/lib/socket';
import { useAuthStore } from '@/store/auth.store';
import { useNotificationsStore, type CrmNotification } from '@/store/notifications.store';

/**
 * Aviso "fantasma" (Fabio 18/11: "aparece e depois some, daí abre a notificação e consegue ver essa notificação").
 * Cada notificação nova do CRM (o mesmo push que vai pro celular, ver notification.service.ts no servidor) aparece uns
 * segundos num cartão translúcido no alto da tela e some sozinha; continua na sineta (aba Notificações) pra abrir depois.
 * No alto de propósito: nunca cobre a caixa de digitar da Inbox (celular e computador). Clicar abre o card/tela do aviso.
 * Sem som — quem toca som é a mensagem do cliente (layout). Conversa já aberta na tela: não pisca, só marca como lida.
 */

const SHOW_MS = 6000;
const MAX_VISIBLE = 3;

type Ghost = CrmNotification & { phase: 'enter' | 'shown' | 'leave' };

/** Abre o endereço de um aviso dentro do CRM — mesmo caminho do toque na notificação do celular (layout): a Inbox troca a conversa na hora. */
export function openNotificationUrl(router: ReturnType<typeof useRouter>, url: string) {
  try {
    const u = new URL(url || '/inbox', window.location.origin);
    if (u.origin !== window.location.origin) { window.open(u.toString(), '_blank', 'noopener'); return; }
    const leadId = u.pathname.startsWith('/inbox') ? u.searchParams.get('leadId') : null;
    if (leadId) window.dispatchEvent(new CustomEvent('af:open-lead', { detail: leadId }));
    router.push(u.pathname + u.search);
  } catch {
    router.push('/inbox');
  }
}

function openLeadOnScreen(): string | null {
  if (typeof window === 'undefined' || window.location.pathname !== '/inbox') return null;
  return new URLSearchParams(window.location.search).get('leadId');
}

export function NotificationGhost() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const userId = useAuthStore((s) => s.user?.id);
  const { load, add, markRead, applyRead, loaded } = useNotificationsStore();
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const remove = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setGhosts((g) => g.map((x) => (x.id === id ? { ...x, phase: 'leave' } : x)));
    setTimeout(() => setGhosts((g) => g.filter((x) => x.id !== id)), 350);
  }, []);

  const schedule = useCallback((id: string, ms: number) => {
    const old = timers.current.get(id);
    if (old) clearTimeout(old);
    timers.current.set(id, setTimeout(() => remove(id), ms));
  }, [remove]);

  // Lista inicial + recarga de segurança (o socket pode ter caído e voltado sem os avisos do meio).
  useEffect(() => {
    if (!userId) return;
    load();
    const t = setInterval(load, 2 * 60 * 1000);
    return () => clearInterval(t);
  }, [userId, load]);

  useEffect(() => {
    if (!userId) return;
    const socket = getSocket();
    function onNotification(n: CrmNotification) {
      add(n);
      // A conversa do aviso já está na tela: não precisa piscar nada.
      if (n.leadId && n.leadId === openLeadOnScreen() && document.visibilityState === 'visible') {
        markRead({ id: n.id });
        return;
      }
      // Aba escondida: o aviso do aparelho já aparece; aqui ele só fica na sineta.
      if (document.visibilityState !== 'visible') return;
      setGhosts((g) => {
        const next = [{ ...n, phase: 'enter' as const }, ...g.filter((x) => x.id !== n.id)];
        next.slice(MAX_VISIBLE).forEach((x) => { const t = timers.current.get(x.id); if (t) clearTimeout(t); timers.current.delete(x.id); });
        return next.slice(0, MAX_VISIBLE);
      });
      requestAnimationFrame(() => requestAnimationFrame(() => setGhosts((g) => g.map((x) => (x.id === n.id && x.phase === 'enter' ? { ...x, phase: 'shown' } : x)))));
      schedule(n.id, SHOW_MS);
    }
    function onRead(by: { id?: string | null; leadId?: string | null; all?: boolean }) { applyRead(by); }
    function onReconnect() { load(); }
    socket.on('crm_notification', onNotification);
    socket.on('crm_notifications_read', onRead);
    socket.on('connect', onReconnect);
    return () => {
      socket.off('crm_notification', onNotification);
      socket.off('crm_notifications_read', onRead);
      socket.off('connect', onReconnect);
    };
  }, [userId, add, markRead, applyRead, load, schedule]);

  // Abriu a conversa de um card: os avisos dele contam como vistos.
  const leadOnScreen = pathname === '/inbox' ? searchParams.get('leadId') : null;
  useEffect(() => {
    if (leadOnScreen && loaded) markRead({ leadId: leadOnScreen });
  }, [leadOnScreen, loaded, markRead]);

  useEffect(() => () => { timers.current.forEach((t) => clearTimeout(t)); timers.current.clear(); }, []);

  if (!ghosts.length) return null;

  return (
    <div
      className="fixed z-[1000] top-2 inset-x-2 md:inset-x-auto md:top-16 md:right-4 md:w-80 flex flex-col gap-2 pointer-events-none"
      aria-live="polite"
    >
      {ghosts.map((g) => (
        <div
          key={g.id}
          role="button"
          tabIndex={0}
          onClick={() => { remove(g.id); markRead({ id: g.id }); openNotificationUrl(router, g.url); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { remove(g.id); markRead({ id: g.id }); openNotificationUrl(router, g.url); } }}
          onMouseEnter={() => { const t = timers.current.get(g.id); if (t) clearTimeout(t); timers.current.delete(g.id); }}
          onMouseLeave={() => schedule(g.id, 2500)}
          className={[
            'pointer-events-auto cursor-pointer select-none flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl',
            'bg-white/80 backdrop-blur-md border border-white/70 shadow-lg ring-1 ring-black/5',
            'transition-all duration-300 ease-out',
            g.phase === 'enter' ? 'opacity-0 -translate-y-2' : g.phase === 'leave' ? 'opacity-0 translate-x-3' : 'opacity-100 translate-y-0',
          ].join(' ')}
          title="Abrir"
        >
          <Bell size={15} className="text-af-mid mt-0.5 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-slate-800 leading-snug line-clamp-1">{g.title}</p>
            {g.body && <p className="text-[11px] text-slate-600 leading-snug line-clamp-2 mt-0.5">{g.body}</p>}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); remove(g.id); }}
            className="text-slate-400 hover:text-slate-600 p-0.5 -mr-1 flex-shrink-0"
            title="Fechar (continua na sineta)"
            aria-label="Fechar"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
