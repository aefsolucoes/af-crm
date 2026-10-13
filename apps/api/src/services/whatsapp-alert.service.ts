import { PrismaClient } from '@prisma/client';

/**
 * Aviso vermelho quando a Meta trava o envio do WhatsApp (Fabio 13/10: achou
 * que a conta tinha sido bloqueada por falta de crédito e não havia como
 * saber). Três jeitos de descobrir, do mais rápido ao mais amplo:
 *  1. falha síncrona na hora de enviar (parseGraphError → noteWhatsAppFailure);
 *  2. falha assíncrona avisada pelo webhook de status (processWhatsAppStatus);
 *  3. checagem a cada 30 min da saúde da conta na própria Meta
 *     (checkWhatsAppHealth) — pega o bloqueio antes de um cliente falhar.
 * Códigos que acendem o aviso: 131042 (pagamento), 131031 (conta restrita),
 * 190 (token expirado). 131049 ("engajamento saudável") NÃO acende — só
 * barra aquela mensagem. O aviso apaga sozinho quando uma mensagem enviada
 * DEPOIS dele é entregue de verdade (delivered/read), ou quando a checagem de
 * saúde volta a "disponível". Mostra no banner do CRM (só ADMIN) e manda push.
 */

const prisma = new PrismaClient();
const HEALTH_CODE = 999000;
const PUSH_EVERY_MS = 6 * 60 * 60 * 1000;

const TITLES: Record<number, string> = {
  131042: 'WhatsApp sem envio: pendência de pagamento na Meta',
  131031: 'WhatsApp restrito pela Meta',
  190: 'WhatsApp desconectado: acesso expirado',
  [HEALTH_CODE]: 'A Meta bloqueou o envio do WhatsApp',
};
const ALERT_CODES = new Set([131042, 131031, 190]);

let ioRef: any = null;
export function setWhatsAppAlertIo(io: any) { ioRef = io; }

export interface WhatsAppAlert { active: boolean; code?: number; title?: string; message?: string; since?: string }

export async function getWhatsAppAlert(accountId: string): Promise<WhatsAppAlert> {
  const c = await prisma.whatsAppConfig.findFirst({ where: { accountId, alertCode: { not: null } }, orderBy: { alertAt: 'desc' }, select: { alertCode: true, alertMessage: true, alertAt: true } });
  if (!c?.alertCode) return { active: false };
  return { active: true, code: c.alertCode, title: TITLES[c.alertCode] || 'Problema no WhatsApp', message: c.alertMessage || '', since: c.alertAt?.toISOString() };
}

async function setAlert(accountId: string, code: number, message: string, opts: { silent?: boolean } = {}): Promise<void> {
  const current = await prisma.whatsAppConfig.findFirst({ where: { accountId, alertCode: code }, select: { alertPushAt: true } });
  const isNew = !current;
  await prisma.whatsAppConfig.updateMany({
    where: { accountId },
    data: { alertCode: code, alertMessage: message, ...(isNew ? { alertAt: new Date(), alertPushAt: null } : {}) },
  });
  if (opts.silent) return;
  if (isNew) ioRef?.to(`account_${accountId}`).emit('whatsapp_alert', { code, title: TITLES[code], message });
  const lastPush = current?.alertPushAt?.getTime() || 0;
  if (isNew || Date.now() - lastPush > PUSH_EVERY_MS) {
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    const admins = await prisma.user.findMany({ where: { accountId, role: 'ADMIN' }, select: { id: true } });
    sendPushToAccount(accountId, { title: `⚠️ ${TITLES[code] || 'Problema no WhatsApp'}`, body: message.slice(0, 160) }, admins.map((a) => a.id)).catch(() => {});
    await prisma.whatsAppConfig.updateMany({ where: { accountId, alertCode: code }, data: { alertPushAt: new Date() } });
  }
}

/** Erro da Meta ao enviar. Só os códigos graves acendem o aviso. */
export async function noteWhatsAppFailure(accountId: string | undefined, code: number | undefined, opts: { silent?: boolean } = {}): Promise<void> {
  try {
    if (!accountId || !code || !ALERT_CODES.has(code)) return;
    const { friendlyWhatsAppError } = require('./whatsapp.service') as typeof import('./whatsapp.service');
    await setAlert(accountId, code, friendlyWhatsAppError(code) || TITLES[code] || 'A Meta recusou o envio.', opts);
    console.error(`[Alerta WhatsApp] código ${code} — aviso vermelho ligado`);
  } catch (err: any) {
    console.error('[Alerta WhatsApp] falha ao registrar:', err?.message);
  }
}

/** Uma mensagem foi ENTREGUE: se ela foi enviada depois do alerta, o problema passou. */
export async function noteWhatsAppDelivered(accountId: string | undefined, messageCreatedAt: Date, opts: { silent?: boolean } = {}): Promise<void> {
  try {
    if (!accountId) return;
    const cleared = await prisma.whatsAppConfig.updateMany({
      where: { accountId, alertCode: { not: null }, alertAt: { lt: messageCreatedAt } },
      data: { alertCode: null, alertMessage: null, alertAt: null, alertPushAt: null },
    });
    if (cleared.count && !opts.silent) {
      ioRef?.to(`account_${accountId}`).emit('whatsapp_alert_cleared', {});
      console.log('[Alerta WhatsApp] mensagem entregue depois do alerta — aviso apagado');
    }
  } catch { /* nunca atrapalha o webhook */ }
}

/** Lê o health_status da Meta e devolve o motivo se algo estiver BLOQUEADO pra enviar (null = ok).
 *  "Limitado" não conta (ex.: nome de exibição ainda não aprovado — só reduz o limite diário). */
export function blockedReason(health: any): string | null {
  const blocked = (health?.entities || []).filter((e: any) => e?.can_send_message === 'BLOCKED');
  if (health?.can_send_message === 'BLOCKED' && !blocked.length) return 'A Meta informa que a conta não pode enviar mensagens agora.';
  if (!blocked.length) return null;
  const parts = blocked.map((e: any) => {
    const err = (e.errors || [])[0];
    return `${e.entity_type}: ${err?.error_description || 'bloqueado'}${err?.possible_solution ? ` — ${err.possible_solution}` : ''}`;
  });
  return `A Meta informa que o envio está BLOQUEADO. ${parts.join(' | ')}`;
}

/** Checagem periódica (index.ts, a cada 30 min). */
export async function checkWhatsAppHealth(): Promise<void> {
  try {
    const configs = await prisma.whatsAppConfig.findMany({ where: { active: true }, select: { accountId: true, accessToken: true, phoneNumberId: true, alertCode: true } });
    for (const c of configs) {
      if (!c.accessToken || !c.phoneNumberId) continue;
      const res = await fetch(`https://graph.facebook.com/v20.0/${c.phoneNumberId}?fields=health_status`, { headers: { Authorization: `Bearer ${c.accessToken}` } }).catch(() => null);
      if (!res) continue;
      const json: any = await res.json().catch(() => null);
      if (json?.error?.code === 190) { await noteWhatsAppFailure(c.accountId, 190); continue; }
      const reason = blockedReason(json?.health_status);
      if (reason) {
        await setAlert(c.accountId, HEALTH_CODE, reason);
      } else if (json?.health_status && c.alertCode === HEALTH_CODE) {
        await prisma.whatsAppConfig.updateMany({ where: { accountId: c.accountId, alertCode: HEALTH_CODE }, data: { alertCode: null, alertMessage: null, alertAt: null, alertPushAt: null } });
        ioRef?.to(`account_${c.accountId}`).emit('whatsapp_alert_cleared', {});
        console.log('[Alerta WhatsApp] a Meta voltou a liberar o envio — aviso apagado');
      }
    }
  } catch (err: any) {
    console.error('[Alerta WhatsApp] checagem de saúde falhou:', err?.message);
  }
}
