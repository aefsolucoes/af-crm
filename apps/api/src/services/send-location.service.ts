import { prisma } from '../lib/prisma';
import type { AuthRequest } from '../middleware/auth';

/* De onde a equipe mandou cada mensagem (Fabio 27/10, Andreia/Diego: "a Andreia encaminhou pelo celular ou pelo computador?").
 * O servidor grava na hora do envio quem mandou, aparelho (user-agent) e IP (status PENDENTE); o navegador manda a localização logo depois
 * (POST /api/messages/:id/send-location). O navegador só lê o GPS se o aparelho JÁ permitiu — o CRM nunca abre o pop-up pedindo; sem permissão = NAO_AUTORIZOU. */

const STATUS = new Set(['OK', 'NAO_AUTORIZOU', 'INDISPONIVEL', 'ERRO']);

function clientIp(req: AuthRequest): string | null {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.ip || null;
}

/** Na hora do envio (rotas da Inbox). Nunca derruba o envio. */
export async function recordSendOrigin(req: AuthRequest, messageId: string | undefined | null, leadId: string): Promise<void> {
  if (!messageId || !req.user) return;
  try {
    const [user, lead] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.user.id }, select: { name: true } }),
      prisma.lead.findUnique({ where: { id: leadId }, select: { name: true } }),
    ]);
    await prisma.messageSendLocation.create({
      data: {
        accountId: req.user.accountId, messageId, userId: req.user.id, userName: user?.name || '?', leadId, leadName: lead?.name || null,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300) || null, ip: clientIp(req),
      },
    });
  } catch (e: any) {
    if (e?.code !== 'P2002') console.error('[SendLocation] registro do envio:', e?.message || e);
  }
}

/** O navegador respondeu: localização (ou o motivo de não ter). Só quem mandou a mensagem grava. */
export async function saveSendLocation(req: AuthRequest, messageId: string, body: Record<string, unknown>): Promise<boolean> {
  const status = String(body.status || '');
  if (!STATUS.has(status)) return false;
  const num = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
  const latitude = num(body.latitude, -90, 90), longitude = num(body.longitude, -180, 180), accuracy = num(body.accuracy, 0, 1_000_000);
  const ok = status === 'OK' && latitude !== null && longitude !== null;
  const r = await prisma.messageSendLocation.updateMany({
    where: { messageId, userId: req.user!.id, accountId: req.user!.accountId },
    data: {
      status: status === 'OK' && !ok ? 'ERRO' : status,
      latitude: ok ? latitude : null, longitude: ok ? longitude : null, accuracy: ok ? accuracy : null,
      detail: String(body.detail || '').slice(0, 120) || null,
    },
  });
  return r.count > 0;
}

/** Relatório (admin): envios do período, mais novos primeiro. */
export async function listSendLocations(accountId: string, opts: { from?: Date; to?: Date; userId?: string }) {
  return prisma.messageSendLocation.findMany({
    where: { accountId, ...(opts.userId ? { userId: opts.userId } : {}), createdAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } },
    orderBy: { createdAt: 'desc' },
    take: 1000,
  });
}
