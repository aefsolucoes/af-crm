import { randomUUID } from 'crypto';
import type { Server } from 'socket.io';
import { prisma } from '../lib/prisma';

/**
 * Notificação fantasma (Fabio 18/11: "aparece e depois some, daí abre a notificação e consegue ver essa notificação").
 * Todo push do CRM (sendPushToAccount) passa por aqui ANTES de ir pros aparelhos: vira uma linha por destinatário em
 * UserNotification e sai pelo socket `crm_notification` na sala do usuário — a tela mostra o aviso por uns segundos
 * (<NotificationGhost />) e ele fica na sineta pra abrir depois. Mesmas pessoas do push: `onlyUserIds` quando vier,
 * senão todo mundo da conta. Grava mesmo sem as chaves VAPID (aí só não vai pro celular).
 * Fire-and-forget: nunca lança — o fluxo que avisou não pode quebrar por causa disso.
 */

let ioRef: Server | null = null;
export function setNotificationIo(io: Server) { ioRef = io; }

export type InAppNotification = { id: string; title: string; body: string; url: string; leadId: string | null; readAt: string | null; createdAt: string };

const KEEP_DAYS = 30;
let lastPrune = 0;

function pruneOld() {
  if (Date.now() - lastPrune < 6 * 60 * 60 * 1000) return;
  lastPrune = Date.now();
  prisma.userNotification
    .deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000) } } })
    .catch((err: any) => console.warn('[Notificações] Limpeza:', err?.message));
}

export async function recordInAppNotification(
  accountId: string,
  payload: { title: string; body: string; url: string; leadId?: string | null },
  onlyUserIds?: string[],
): Promise<void> {
  try {
    if (onlyUserIds && !onlyUserIds.length) return;
    const users = await prisma.user.findMany({
      where: { accountId, ...(onlyUserIds ? { id: { in: onlyUserIds } } : {}) },
      select: { id: true },
    });
    if (!users.length) return;

    const createdAt = new Date();
    const base = {
      accountId,
      title: String(payload.title || 'AF CRM').slice(0, 200),
      body: String(payload.body || '').slice(0, 600),
      url: String(payload.url || '/inbox').slice(0, 500),
      leadId: payload.leadId || null,
      createdAt,
    };
    const rows = users.map((u) => ({ id: randomUUID(), userId: u.id, ...base }));
    await prisma.userNotification.createMany({ data: rows });

    if (ioRef) {
      for (const r of rows) {
        const out: InAppNotification = { id: r.id, title: r.title, body: r.body, url: r.url, leadId: r.leadId, readAt: null, createdAt: createdAt.toISOString() };
        ioRef.to(`user_${r.userId}`).emit('crm_notification', out);
      }
    }
    pruneOld();
  } catch (err: any) {
    console.warn('[Notificações] Não gravou o aviso:', err?.message);
  }
}

export async function listUserNotifications(userId: string, opts: { limit?: number; cursor?: string }) {
  const limit = Math.min(Math.max(opts.limit || 40, 1), 100);
  const items = await prisma.userNotification.findMany({
    where: { userId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    select: { id: true, title: true, body: true, url: true, leadId: true, readAt: true, createdAt: true },
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const unread = await prisma.userNotification.count({ where: { userId, readAt: null } });
  return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null, unread };
}

/** Marca como lidas: uma (`id`), as de um card (`leadId` — abriu a conversa) ou todas. Avisa as outras abas/aparelhos da pessoa. */
export async function markUserNotificationsRead(userId: string, by: { id?: string; leadId?: string; all?: boolean }) {
  if (!by.id && !by.leadId && !by.all) return { updated: 0 };
  const where = { userId, readAt: null, ...(by.id ? { id: by.id } : {}), ...(by.leadId ? { leadId: by.leadId } : {}) };
  const { count } = await prisma.userNotification.updateMany({ where, data: { readAt: new Date() } });
  if (count && ioRef) ioRef.to(`user_${userId}`).emit('crm_notifications_read', { id: by.id || null, leadId: by.leadId || null, all: !!by.all });
  return { updated: count };
}
