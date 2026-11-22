import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { listUserNotifications, markUserNotificationsRead } from '../services/notification.service';

// Sineta de notificações (Fabio 18/11): os avisos do CRM que apareceram na tela por uns segundos — cada um vê só os seus.
const router = Router();
router.use(authMiddleware);

// GET /api/notifications?limit=&cursor=
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { limit, cursor } = req.query as Record<string, string | undefined>;
    res.json(await listUserNotifications(req.user!.id, { limit: limit ? parseInt(limit, 10) || undefined : undefined, cursor: cursor || undefined }));
  } catch {
    res.status(500).json({ error: 'Erro ao buscar as notificações' });
  }
});

// POST /api/notifications/read  { id? | leadId? | all? }
router.post('/read', async (req: AuthRequest, res: Response) => {
  try {
    const { id, leadId, all } = (req.body || {}) as { id?: string; leadId?: string; all?: boolean };
    res.json(await markUserNotificationsRead(req.user!.id, {
      id: typeof id === 'string' ? id : undefined,
      leadId: typeof leadId === 'string' ? leadId : undefined,
      all: all === true,
    }));
  } catch {
    res.status(500).json({ error: 'Erro ao marcar como lida' });
  }
});

// POST /api/notifications/apagar { contem, desde, ate } (administrador) — apaga da sineta de TODOS da conta os avisos com esse texto (título ou corpo) nesse intervalo
// (Fabio 21/11: "tira os avisos que contenham teste… que você mandou antes… apaga eles do CRM"). Intervalo obrigatório e de no máximo 1 dia: nunca apaga o histórico inteiro.
router.post('/apagar', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só administradores' });
  const { contem, desde, ate } = (req.body || {}) as { contem?: string; desde?: string; ate?: string };
  const de = new Date(String(desde || ''));
  const atE = new Date(String(ate || ''));
  const texto = String(contem || '').trim();
  if (texto.length < 3 || isNaN(de.getTime()) || isNaN(atE.getTime()) || atE <= de || atE.getTime() - de.getTime() > 86_400_000) {
    return res.status(400).json({ error: 'Informe contem (3+ letras), desde e ate (intervalo de até 1 dia)' });
  }
  const { prisma } = require('../lib/prisma') as typeof import('../lib/prisma');
  const r = await prisma.userNotification.deleteMany({
    where: { accountId: req.user!.accountId, createdAt: { gte: de, lte: atE }, OR: [{ title: { contains: texto, mode: 'insensitive' } }, { body: { contains: texto, mode: 'insensitive' } }] },
  });
  res.json({ ok: true, apagados: r.count });
});

export default router;
