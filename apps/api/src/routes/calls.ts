import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { preAcceptCall, acceptCall, rejectCall, terminateCall } from '../services/whatsapp-calling.service';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

/** Busca a Call pelo waCallId, já confirmando que pertence à conta de quem
 *  está chamando (evita um agente de outra conta agir sobre uma ligação que
 *  não é dele) e trazendo o WhatsAppConfig certo (o que recebeu a ligação,
 *  não um resolvido de novo por setor). */
async function findOwnCallOrFail(waCallId: string, accountId: string, res: Response) {
  const call = await prisma.call.findFirst({
    where: { waCallId, accountId },
    include: { whatsappConfig: true },
  });
  if (!call) {
    res.status(404).json({ error: 'Ligação não encontrada' });
    return null;
  }
  return call;
}

const sdpSchema = z.object({ sdpAnswer: z.string().min(1) });

// POST /api/calls/:waCallId/pre-accept
router.post('/:waCallId/pre-accept', validate(sdpSchema), async (req: AuthRequest, res: Response) => {
  const call = await findOwnCallOrFail(req.params.waCallId, req.user!.accountId, res);
  if (!call) return;
  const result = await preAcceptCall(call.whatsappConfig, call.waCallId, req.body.sdpAnswer);
  if (!result.ok) return res.status(502).json({ error: result.json?.error?.message || 'Falha ao pré-aceitar a ligação' });
  res.json({ ok: true });
});

// POST /api/calls/:waCallId/accept
router.post('/:waCallId/accept', validate(sdpSchema), async (req: AuthRequest, res: Response) => {
  const call = await findOwnCallOrFail(req.params.waCallId, req.user!.accountId, res);
  if (!call) return;
  const result = await acceptCall(call.whatsappConfig, call.waCallId, req.body.sdpAnswer);
  if (!result.ok) return res.status(502).json({ error: result.json?.error?.message || 'Falha ao atender a ligação' });

  const updated = await prisma.call.update({
    where: { id: call.id },
    data: { status: 'CONNECTED', connectedAt: new Date(), answeredByUserId: req.user!.id },
  });

  const io = (req as any).app.get('io');
  io.to(`account_${req.user!.accountId}`).emit('call_answered_by', {
    waCallId: call.waCallId,
    byUserId: req.user!.id,
    byUserName: (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name,
  });

  res.json({ ok: true, callId: updated.id });
});

// POST /api/calls/:waCallId/reject
router.post('/:waCallId/reject', async (req: AuthRequest, res: Response) => {
  const call = await findOwnCallOrFail(req.params.waCallId, req.user!.accountId, res);
  if (!call) return;
  const result = await rejectCall(call.whatsappConfig, call.waCallId);
  if (!result.ok) return res.status(502).json({ error: result.json?.error?.message || 'Falha ao recusar a ligação' });

  await prisma.call.update({ where: { id: call.id }, data: { status: 'REJECTED', endedAt: new Date(), endReason: 'rejected_by_agent' } });
  const io = (req as any).app.get('io');
  io.to(`account_${req.user!.accountId}`).emit('call_ended', { waCallId: call.waCallId, status: 'REJECTED', endReason: 'rejected_by_agent' });
  if (call.leadId) io.to(`lead:${call.leadId}`).emit('call_ended', { waCallId: call.waCallId, status: 'REJECTED', endReason: 'rejected_by_agent' });

  res.json({ ok: true });
});

// POST /api/calls/:waCallId/terminate
router.post('/:waCallId/terminate', async (req: AuthRequest, res: Response) => {
  const call = await findOwnCallOrFail(req.params.waCallId, req.user!.accountId, res);
  if (!call) return;
  const result = await terminateCall(call.whatsappConfig, call.waCallId);
  if (!result.ok) return res.status(502).json({ error: result.json?.error?.message || 'Falha ao encerrar a ligação' });

  const updated = await prisma.call.update({
    where: { id: call.id },
    data: { status: 'ENDED', endedAt: new Date(), endReason: 'terminated_by_agent' },
  });
  const io = (req as any).app.get('io');
  io.to(`account_${req.user!.accountId}`).emit('call_ended', { waCallId: call.waCallId, status: updated.status, endReason: updated.endReason });
  if (call.leadId) io.to(`lead:${call.leadId}`).emit('call_ended', { waCallId: call.waCallId, status: updated.status, endReason: updated.endReason });

  res.json({ ok: true });
});

// GET /api/calls/history?leadId=
router.get('/history', async (req: AuthRequest, res: Response) => {
  const leadId = req.query.leadId as string | undefined;
  if (!leadId) return res.status(400).json({ error: 'leadId é obrigatório' });

  const calls = await prisma.call.findMany({
    where: { leadId, accountId: req.user!.accountId },
    orderBy: { startedAt: 'desc' },
    include: { answeredBy: { select: { id: true, name: true } } },
  });
  res.json(calls);
});

// GET /api/calls — histórico da CONTA inteira (aba própria "Chamadas" no
// menu, separada de dentro de cada conversa). Mesma listagem de sempre,
// só sem o filtro por lead — últimas 200, mais recente primeiro.
router.get('/', async (req: AuthRequest, res: Response) => {
  const calls = await prisma.call.findMany({
    where: { accountId: req.user!.accountId },
    orderBy: { startedAt: 'desc' },
    take: 200,
    include: {
      answeredBy: { select: { id: true, name: true } },
      lead: { select: { id: true, name: true } },
    },
  });
  res.json(calls);
});

export default router;
