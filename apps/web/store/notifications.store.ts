import { create } from 'zustand';
import api from '@/lib/api';

/**
 * Notificações do CRM guardadas por usuário (Fabio 18/11, "notificação fantasma"): cada push que o servidor dispara
 * chega aqui pelo socket `crm_notification`, aparece uns segundos na tela (<NotificationGhost />) e fica na sineta
 * (<ActivityBell />, aba Notificações) pra abrir depois. Lida = abriu pela sineta/aviso, abriu a conversa do card
 * ou abriu a sineta (zera o contador). Ver apps/api/src/services/notification.service.ts.
 */
export interface CrmNotification {
  id: string;
  title: string;
  body: string;
  url: string;
  leadId: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationsState {
  items: CrmNotification[];
  unread: number;
  nextCursor: string | null;
  loaded: boolean;
  loadingMore: boolean;
  load: () => Promise<void>;
  loadMore: () => Promise<void>;
  /** Chegou pelo socket. */
  add: (n: CrmNotification) => void;
  markRead: (by: { id?: string; leadId?: string; all?: boolean }) => void;
  /** Outra aba/aparelho da pessoa marcou como lida (socket `crm_notifications_read`). */
  applyRead: (by: { id?: string | null; leadId?: string | null; all?: boolean }) => void;
}

function readLocally(items: CrmNotification[], by: { id?: string | null; leadId?: string | null; all?: boolean }) {
  const now = new Date().toISOString();
  let changed = 0;
  const next = items.map((n) => {
    if (n.readAt) return n;
    const hit = by.all || (by.id && n.id === by.id) || (by.leadId && n.leadId === by.leadId);
    if (!hit) return n;
    changed++;
    return { ...n, readAt: now };
  });
  return { next, changed };
}

export const useNotificationsStore = create<NotificationsState>((set, get) => ({
  items: [],
  unread: 0,
  nextCursor: null,
  loaded: false,
  loadingMore: false,

  load: async () => {
    try {
      const { data } = await api.get('/api/notifications', { params: { limit: 40 } });
      set({ items: data.items || [], unread: data.unread || 0, nextCursor: data.nextCursor || null, loaded: true });
    } catch { /* rede — tenta de novo no próximo tick */ }
  },

  loadMore: async () => {
    const { nextCursor, loadingMore } = get();
    if (!nextCursor || loadingMore) return;
    set({ loadingMore: true });
    try {
      const { data } = await api.get('/api/notifications', { params: { limit: 40, cursor: nextCursor } });
      set((s) => ({ items: [...s.items, ...(data.items || [])], nextCursor: data.nextCursor || null }));
    } catch { /* ignore */ } finally {
      set({ loadingMore: false });
    }
  },

  add: (n) => set((s) => (s.items.some((x) => x.id === n.id) ? s : { items: [n, ...s.items], unread: s.unread + 1 })),

  markRead: (by) => {
    const { next, changed } = readLocally(get().items, by);
    if (!changed && !by.all) return;
    set((s) => ({ items: next, unread: by.all ? 0 : Math.max(0, s.unread - changed) }));
    api.post('/api/notifications/read', by).catch(() => {});
  },

  applyRead: (by) => {
    if (by.all) { set((s) => ({ items: readLocally(s.items, by).next, unread: 0 })); return; }
    const { next, changed } = readLocally(get().items, by);
    if (changed) { set((s) => ({ items: next, unread: Math.max(0, s.unread - changed) })); return; }
    // Esta aba mesma já tinha marcado (o aviso volta pra todas as abas da pessoa) — nada a fazer.
    if (get().items.some((n) => (by.id && n.id === by.id) || (by.leadId && n.leadId === by.leadId))) return;
    get().load(); // o que foi lido não está na página carregada — confere o contador no servidor
  },
}));
