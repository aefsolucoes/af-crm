'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell } from 'lucide-react';
import api from '@/lib/api';
import { useNotificationsStore } from '@/store/notifications.store';
import { openNotificationUrl } from '@/components/ui/notification-ghost';

/**
 * Sineta do Topbar (está em todas as telas), com duas abas:
 * - Notificações (Fabio 18/11): os avisos do CRM pra esta pessoa — os mesmos do push do celular. Cada um aparece uns
 *   segundos na tela (<NotificationGhost />) e fica aqui pra abrir depois. Número vermelho = não lidas; abrir a sineta
 *   marca todas como lidas (as que eram novas ficam destacadas enquanto o painel está aberto).
 * - Atividade da equipe: o que a equipe fez (mexeu em card, respondeu cliente, mudou status…). SILENCIOSA — sem som,
 *   sem popup; só acumula. Pontinho quando tem coisa mais nova do que a última vez que a aba foi vista (localStorage).
 */
interface ActivityItem {
  id: string;
  userName: string;
  action: string;
  leadId: string | null;
  leadName: string | null;
  summary: string;
  channel: string | null;
  createdAt: string;
}

const SEEN_KEY = 'af:activity-seen';

function timeAgo(iso: string): string {
  const diffS = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (diffS < 60) return 'agora';
  const m = Math.floor(diffS / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} d`;
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export function ActivityBell() {
  const router = useRouter();
  const notif = useNotificationsStore();
  const [tab, setTab] = useState<'notif' | 'activity'>('notif');
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasNew, setHasNew] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);

  const seenAt = () => {
    try { return localStorage.getItem(SEEN_KEY) || ''; } catch { return ''; }
  };

  const loadFirst = useCallback(async () => {
    try {
      const { data } = await api.get('/api/activity', { params: { limit: 40 } });
      const list: ActivityItem[] = data.items || [];
      setItems(list);
      setCursor(data.nextCursor || null);
      const newest = list[0]?.createdAt || '';
      setHasNew(!!newest && newest > seenAt());
    } catch { /* rede — tenta de novo no próximo tick */ }
  }, []);

  useEffect(() => {
    loadFirst();
    const t = setInterval(loadFirst, 60000);
    return () => clearInterval(t);
  }, [loadFirst]);

  function markActivitySeen() {
    try { localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* ignore */ }
    setHasNew(false);
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      // Sem notificação nova, abre direto no registro (como era antes) se lá tiver novidade.
      const startTab = notif.unread > 0 || !hasNew ? 'notif' : 'activity';
      setTab(startTab);
      setFreshIds(new Set(notif.items.filter((n) => !n.readAt).map((n) => n.id)));
      if (notif.unread > 0) notif.markRead({ all: true });
      if (startTab === 'activity') markActivitySeen();
      loadFirst();
    }
  }

  function switchTab(t: 'notif' | 'activity') {
    setTab(t);
    if (t === 'activity') markActivitySeen();
  }

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { data } = await api.get('/api/activity', { params: { limit: 40, cursor } });
      setItems((prev) => [...prev, ...(data.items || [])]);
      setCursor(data.nextCursor || null);
    } catch { /* ignore */ } finally {
      setLoadingMore(false);
    }
  }

  const panel = (
    <>
      {/* backdrop transparente — clicar fora fecha */}
      <div className="fixed inset-0 z-[998]" onClick={() => setOpen(false)} />
      <div className="fixed top-14 right-3 z-[999] w-80 max-w-[calc(100vw-1.5rem)] bg-white rounded-xl shadow-2xl border border-af-border overflow-hidden">
        <div className="flex border-b border-af-border">
          {([
            ['notif', 'Notificações', false],
            ['activity', 'Atividade da equipe', hasNew],
          ] as const).map(([key, label, dot]) => (
            <button
              key={key}
              onClick={() => switchTab(key)}
              className={`relative flex-1 px-3 py-2.5 text-xs font-semibold transition-colors ${tab === key ? 'text-af-navy border-b-2 border-af-accent -mb-px' : 'text-slate-400 hover:text-slate-600'}`}
            >
              {label}
              {dot && tab !== key && <span className="absolute top-2 right-3 w-1.5 h-1.5 rounded-full bg-af-accent" />}
            </button>
          ))}
        </div>
        {tab === 'notif' ? (
        <div className="max-h-[70vh] overflow-y-auto scrollbar-thin">
          {notif.items.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-8">{notif.loaded ? 'Nenhuma notificação ainda.' : 'Carregando…'}</p>
          ) : (
            notif.items.map((n) => (
              <button
                key={n.id}
                onClick={() => { setOpen(false); notif.markRead({ id: n.id }); openNotificationUrl(router, n.url); }}
                className={`block w-full text-left px-4 py-2.5 border-b border-slate-100 hover:bg-slate-50 ${freshIds.has(n.id) ? 'bg-blue-50/60' : ''}`}
              >
                <div className="flex items-start gap-2">
                  {freshIds.has(n.id) && <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-af-accent flex-shrink-0" />}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-slate-800 leading-snug">{n.title}</p>
                    {n.body && <p className="text-xs text-slate-600 leading-snug mt-0.5 line-clamp-3 whitespace-pre-line">{n.body}</p>}
                    <p className="text-[11px] text-slate-400 mt-0.5">{timeAgo(n.createdAt)}</p>
                  </div>
                </div>
              </button>
            ))
          )}
          {notif.nextCursor && (
            <button
              onClick={() => notif.loadMore()}
              disabled={notif.loadingMore}
              className="w-full text-xs text-af-mid hover:bg-slate-50 py-2.5 disabled:opacity-50"
            >
              {notif.loadingMore ? 'Carregando…' : 'Carregar mais'}
            </button>
          )}
        </div>
        ) : (
        <div className="max-h-[70vh] overflow-y-auto scrollbar-thin">
          <p className="px-4 pt-2 pb-1 text-[11px] text-slate-400">O que a equipe fez — sem alarde, só registrado</p>
          {items.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-8">Nada registrado ainda.</p>
          ) : (
            items.map((it) => {
              const body = (
                <div className="px-4 py-2.5 hover:bg-slate-50 border-b border-slate-100">
                  <p className="text-xs text-slate-700 leading-snug">
                    <span className="font-semibold">{it.userName}</span> {it.summary}
                    {it.leadName && (
                      <> — <span className="font-medium text-slate-900">{it.leadName}</span></>
                    )}
                  </p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{timeAgo(it.createdAt)}</p>
                </div>
              );
              return it.leadId ? (
                <Link key={it.id} href={`/inbox?leadId=${it.leadId}`} onClick={() => setOpen(false)} className="block">
                  {body}
                </Link>
              ) : (
                <div key={it.id}>{body}</div>
              );
            })
          )}
          {cursor && (
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="w-full text-xs text-af-mid hover:bg-slate-50 py-2.5 disabled:opacity-50"
            >
              {loadingMore ? 'Carregando…' : 'Carregar mais'}
            </button>
          )}
        </div>
        )}
      </div>
    </>
  );

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={toggle}
        className="relative app-topbar-text-muted hover:text-af-mid p-1.5 rounded-lg hover:bg-white/10 transition-colors"
        title={notif.unread > 0 ? `${notif.unread} notificação(ões) nova(s)` : 'Notificações e atividade da equipe'}
      >
        <Bell size={18} />
        {notif.unread > 0 ? (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-4 text-center">
            {notif.unread > 99 ? '99+' : notif.unread}
          </span>
        ) : hasNew && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-af-accent" />}
      </button>

      {/* Portal pro <body> — senão os cards do Kanban (que têm transform) ficam
          por cima do painel. */}
      {open && mounted && createPortal(panel, document.body)}
    </div>
  );
}
