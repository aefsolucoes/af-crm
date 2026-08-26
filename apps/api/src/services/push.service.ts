import { PrismaClient } from '@prisma/client';
import webpush from 'web-push';

const prisma = new PrismaClient();

let configured = false;

/**
 * Liga o Web Push só se as chaves VAPID estiverem no ambiente. Sem elas, vira
 * no-op silencioso (com 1 aviso no boot) — a API sobe normal mesmo antes de o
 * Railway ter as variáveis configuradas; só a etapa de push fica inativa.
 */
export function configureWebPush() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:efcrds@gmail.com';

  if (!publicKey || !privateKey) {
    console.warn('[Push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY não configuradas — notificações push desativadas.');
    return;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  console.log('[Push] Web Push configurado.');
}

export function isPushConfigured() {
  return configured;
}

type PushPayload = {
  title: string;
  body: string;
  leadId?: string;
};

/**
 * Dispara push para todos os dispositivos de todos os usuários da conta —
 * mesmo escopo do evento `new_notification` (conta inteira, sem filtro por
 * setor). Fire-and-forget: nunca deve travar o fluxo de mensagem que chamou.
 * Autolimpa subscriptions que o provedor devolveu como expiradas (410/404).
 */
export async function sendPushToAccount(accountId: string, payload: PushPayload) {
  if (!configured) return;

  try {
    const subs = await prisma.pushSubscription.findMany({
      where: { user: { accountId } },
    });
    if (!subs.length) return;

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.leadId ? `/inbox?leadId=${payload.leadId}` : '/inbox',
    });

    const results = await Promise.allSettled(
      subs.map((sub) =>
        webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        ),
      ),
    );

    const expiredIds: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const statusCode = (r.reason as any)?.statusCode;
        if (statusCode === 404 || statusCode === 410) expiredIds.push(subs[i].id);
        else console.warn('[Push] Falha ao enviar:', (r.reason as any)?.message || r.reason);
      }
    });

    if (expiredIds.length) {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: expiredIds } } });
    }
  } catch (err) {
    console.error('[Push] Erro ao disparar notificações:', err);
  }
}
