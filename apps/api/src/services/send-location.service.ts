import { prisma } from '../lib/prisma';
import type { AuthRequest } from '../middleware/auth';

/* De onde a equipe mandou cada mensagem (Fabio 27/10, Andreia/Diego: "a Andreia encaminhou pelo celular ou pelo computador?").
 * O servidor grava na hora do envio quem mandou, aparelho (user-agent) e IP (status PENDENTE); o navegador manda a localização logo depois
 * (POST /api/messages/:id/send-location). Sem a chave do pop-up (SendLocationSetting), o navegador só lê o GPS se o aparelho JÁ permitiu; sem
 * permissão = NAO_AUTORIZOU. Com a chave ligada pra pessoa, ela vê o aviso do CRM e o pedido do aparelho; "Não Permitir" = NEGOU. */

const STATUS = new Set(['OK', 'NAO_AUTORIZOU', 'NEGOU', 'INDISPONIVEL', 'ERRO']);

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

/* Pedido de permissão (Fabio 28/10): chave geral do pop-up + quem fica de fora. Sem linha = pop-up desligado e todo mundo ligado. */
export async function getSendLocationSetting(accountId: string) {
  const s = await prisma.sendLocationSetting.findUnique({ where: { accountId } });
  return { promptEnabled: !!s?.promptEnabled, disabledUserIds: s?.disabledUserIds || [] };
}

/** Esta pessoa pode ver o pedido de permissão agora? (chave geral ligada e ela não está na lista de fora) */
export async function promptAllowedFor(accountId: string, userId: string): Promise<boolean> {
  const s = await getSendLocationSetting(accountId);
  return s.promptEnabled && !s.disabledUserIds.includes(userId);
}

export async function setSendLocationSetting(accountId: string, patch: { promptEnabled?: boolean; disabledUserIds?: string[] }, userId: string) {
  const data = {
    ...(typeof patch.promptEnabled === 'boolean' ? { promptEnabled: patch.promptEnabled } : {}),
    ...(Array.isArray(patch.disabledUserIds) ? { disabledUserIds: patch.disabledUserIds.map(String).slice(0, 500) } : {}),
    updatedById: userId,
  };
  await prisma.sendLocationSetting.upsert({ where: { accountId }, create: { accountId, ...data }, update: data });
  return getSendLocationSetting(accountId);
}

/* Localizador da equipe (Fabio 28/10): um ponto quando a pessoa ABRE o CRM e de 1 em 1 min enquanto ficar aberto. Só grava se o aparelho já
 * permite a localização — nenhum pop-up. Para quando o app fecha (iPhone não roda site de fundo). */
export async function recordLocationPing(req: AuthRequest, body: Record<string, unknown>): Promise<void> {
  if (!req.user) return;
  const status = String(body.status || 'OK');
  if (!STATUS.has(status)) return;
  const num = (v: unknown, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null);
  const latitude = num(body.latitude, -90, 90), longitude = num(body.longitude, -180, 180), accuracy = num(body.accuracy, 0, 1_000_000);
  const ok = status === 'OK' && latitude !== null && longitude !== null;
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { name: true } });
  await prisma.userLocationPing.create({
    data: {
      accountId: req.user.accountId, userId: req.user.id, userName: user?.name || '?',
      status: status === 'OK' && !ok ? 'ERRO' : status,
      latitude: ok ? latitude : null, longitude: ok ? longitude : null, accuracy: ok ? accuracy : null,
      detail: String(body.detail || '').slice(0, 120) || null,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300) || null, ip: clientIp(req),
    },
  });
}

export interface LocationEvent {
  id: string; kind: 'open' | 'send'; userId: string; userName: string; leadId: string | null; leadName: string | null;
  status: string; latitude: number | null; longitude: number | null; accuracy: number | null; detail: string | null;
  userAgent: string | null; ip: string | null; createdAt: Date;
}

/** Trajeto: abre o CRM (UserLocationPing) + envia mensagem (MessageSendLocation), juntos, mais novos primeiro. Admin. */
export async function listLocationEvents(accountId: string, opts: { from?: Date; to?: Date; userId?: string }): Promise<LocationEvent[]> {
  const when = { createdAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } };
  const who = opts.userId ? { userId: opts.userId } : {};
  // 1 ponto por minuto com o app aberto: 1000 da equipe toda cobrem poucas horas; filtrado por uma pessoa vai até 3000 (Fabio 31/10)
  const take = opts.userId ? 3000 : 1000;
  const [pings, sends] = await Promise.all([
    prisma.userLocationPing.findMany({ where: { accountId, ...who, ...when }, orderBy: { createdAt: 'desc' }, take }),
    prisma.messageSendLocation.findMany({ where: { accountId, ...who, ...when }, orderBy: { createdAt: 'desc' }, take }),
  ]);
  const events: LocationEvent[] = [
    ...pings.map((p): LocationEvent => ({ id: p.id, kind: 'open', userId: p.userId, userName: p.userName, leadId: null, leadName: null, status: p.status, latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy, detail: p.detail, userAgent: p.userAgent, ip: p.ip, createdAt: p.createdAt })),
    ...sends.map((m): LocationEvent => ({ id: m.id, kind: 'send', userId: m.userId, userName: m.userName, leadId: m.leadId, leadName: m.leadName, status: m.status, latitude: m.latitude, longitude: m.longitude, accuracy: m.accuracy, detail: m.detail, userAgent: m.userAgent, ip: m.ip, createdAt: m.createdAt })),
  ];
  return events.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take);
}
