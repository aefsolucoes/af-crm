import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import webpush from 'web-push';


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
  // 'call' faz o service worker manter a notificação visível (requireInteraction)
  // e mostrar ações de Atender/Recusar — omitido = comportamento normal de mensagem.
  // 'call_cancel' é o inverso: a ligação foi atendida/recusada/perdida, então o service
  // worker troca (mesmo tag) a notificação "tocando" por um aviso mudo que some sozinho.
  type?: 'call' | 'call_cancel';
  /** Pra onde o clique na notificação leva (padrão: a conversa do card, ou a Inbox). */
  url?: string;
};

export type PushDeliveryResult = { id: string; device: string; status: 'enviado' | 'expirado' | 'erro'; error?: string };

type SubWithUser = { id: string; endpoint: string; p256dh: string; auth: string; userAgent: string | null; user: { name: string } };

/** Nome do aparelho pelo navegador que se inscreveu — lista de Configurações, resultado do teste e log de inscrição removida. */
export function deviceLabel(userAgent?: string | null): string {
  const ua = userAgent || '';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Celular Android' : 'Tablet Android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Aparelho desconhecido';
}

/** Entrega o push em cada inscrição e diz o que aconteceu com cada uma. Autolimpa as que o provedor devolveu como expiradas (410/404). */
async function deliverToSubs(subs: SubWithUser[], body: string): Promise<PushDeliveryResult[]> {
  const settled = await Promise.allSettled(
    subs.map((sub) =>
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        body,
        // Sem isso o provedor trata como "normal": com o celular em economia de energia o aviso fica pra depois (Fabio 08/11, "não estou recebendo").
        { urgency: 'high' },
      ),
    ),
  );

  const expiredIds: string[] = [];
  const results = settled.map((r, i): PushDeliveryResult => {
    const device = deviceLabel(subs[i].userAgent);
    if (r.status === 'fulfilled') return { id: subs[i].id, device, status: 'enviado' };
    const reason = r.reason as any;
    const statusCode = reason?.statusCode;
    if (statusCode === 404 || statusCode === 410) {
      expiredIds.push(subs[i].id);
      console.log(`[Push] Inscrição expirada removida: ${subs[i].user.name} — ${device} (HTTP ${statusCode})`);
      return { id: subs[i].id, device, status: 'expirado' };
    }
    const error = statusCode ? `HTTP ${statusCode} ${String(reason?.body || '').slice(0, 200)}`.trim() : String(reason?.message || reason);
    console.warn(`[Push] Falha ao enviar (${subs[i].user.name} — ${device}):`, error);
    return { id: subs[i].id, device, status: 'erro', error };
  });

  if (expiredIds.length) {
    await prisma.pushSubscription.deleteMany({ where: { id: { in: expiredIds } } });
  }
  return results;
}

/** Push de teste pros aparelhos de quem pediu (botão em Configurações → Sons), com o resultado de cada um. */
export async function sendTestPush(userId: string): Promise<{ configured: boolean; results: PushDeliveryResult[] }> {
  if (!configured) return { configured: false, results: [] };
  const subs = await prisma.pushSubscription.findMany({ where: { userId }, include: { user: { select: { name: true } } } });
  if (!subs.length) return { configured: true, results: [] };
  const body = JSON.stringify({ title: '🔔 Teste do AF CRM', body: 'Se este aviso apareceu, as notificações estão chegando neste aparelho.', url: '/configuracoes' });
  return { configured: true, results: await deliverToSubs(subs, body) };
}

/**
 * Dispara push para todos os dispositivos de todos os usuários da conta —
 * mesmo escopo do evento `new_notification` (conta inteira, sem filtro por
 * setor), ou só pra `onlyUserIds` quando vier. Fire-and-forget: nunca deve
 * travar o fluxo de mensagem que chamou.
 * Autolimpa subscriptions que o provedor devolveu como expiradas (410/404).
 */
export async function sendPushToAccount(accountId: string, payload: PushPayload, onlyUserIds?: string[], opts?: { desktopOnly?: boolean }) {
  if (!configured) return;
  if (onlyUserIds && !onlyUserIds.length) return;

  try {
    let subs = await prisma.pushSubscription.findMany({
      where: { user: { accountId }, ...(onlyUserIds ? { userId: { in: onlyUserIds } } : {}) },
      include: { user: { select: { name: true } } },
    });
    // `desktopOnly`: só os navegadores de computador do usuário (celular/tablet ficam de fora) — ex.: o aviso de "banco deslogado" é pra quem tem as extensões no Chrome do computador.
    if (opts?.desktopOnly) subs = subs.filter((x) => !/Android|iPhone|iPad|iPod|Mobile/i.test(x.userAgent || ''));
    if (!subs.length) return;

    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || (payload.leadId ? `/inbox?leadId=${payload.leadId}` : '/inbox'),
      ...(payload.type ? { type: payload.type } : {}),
    });

    await deliverToSubs(subs, body);
  } catch (err) {
    console.error('[Push] Erro ao disparar notificações:', err);
  }
}
