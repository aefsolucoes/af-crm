import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import {
  preAcceptCall, acceptCall, rejectCall, terminateCall,
  connectCall, getCallPermissionState, sendCallPermissionRequest, pickRealPhone,
  createCallMessage, finalizeCallMessage,
} from '../services/whatsapp-calling.service';
import { getWhatsAppConfig, normalizeBrazilianWhatsAppPhone } from '../services/whatsapp.service';
import { startAiCall } from '../services/ai-call-bridge.service';

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
  await finalizeCallMessage(call.waCallId, 'REJECTED', 0, io, req.user!.accountId, call.leadId);

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

  const durationSec = call.connectedAt ? Math.max(0, Math.round((updated.endedAt!.getTime() - call.connectedAt.getTime()) / 1000)) : 0;
  await finalizeCallMessage(call.waCallId, updated.status, durationSec, io, req.user!.accountId, call.leadId);

  res.json({ ok: true });
});

/** Busca o lead com o telefone/setor já resolvidos — usado tanto pelo
 *  check de permissão quanto pelo disparo da ligação outbound, evita
 *  repetir a mesma query com o mesmo include duas vezes. */
async function findLeadWithPhone(leadId: string, accountId: string) {
  return prisma.lead.findFirst({
    where: { id: leadId, accountId },
    include: { contact: true, pipeline: { select: { departmentId: true } } },
  });
}

// GET /api/calls/permission-state?leadId= — consulta ao vivo se o cliente já
// autorizou receber ligação (fonte de verdade é a Meta, não cache local).
router.get('/permission-state', async (req: AuthRequest, res: Response) => {
  const leadId = req.query.leadId as string | undefined;
  if (!leadId) return res.status(400).json({ error: 'leadId é obrigatório' });

  const lead = await findLeadWithPhone(leadId, req.user!.accountId);
  const phoneRaw = pickRealPhone(lead?.contact);
  if (!phoneRaw) return res.status(400).json({ error: 'Lead sem telefone de WhatsApp' });

  const config = await getWhatsAppConfig(req.user!.accountId, lead!.pipeline?.departmentId || null);
  if (!config) return res.status(400).json({ error: 'WhatsApp não configurado' });

  const phone = normalizeBrazilianWhatsAppPhone(phoneRaw);
  const state = await getCallPermissionState(config, phone);
  // Manda o telefone junto -- o popup de confirmação ("Ligar pra Fulano
  // (61 98524-3606)?", estilo WhatsApp) usa isso pra mostrar pra quem vai
  // ligar antes de discar de verdade, sem precisar resolver o telefone de
  // novo no frontend.
  res.json({ permitted: state.permitted, canRequest: state.canRequest, phone });
});

// POST /api/calls/:waCallId/diag — diagnóstico da ligação mandado pelo
// navegador (recebendo áudio? atraso? som tocando?) — só loga, pra achar
// problema de áudio sem precisar do console do navegador do usuário.
router.post('/:waCallId/diag', async (req: AuthRequest, res: Response) => {
  console.log(`[Calling][diag] ${req.params.waCallId.slice(-12)} user=${req.user!.id.slice(-6)}:`, JSON.stringify(req.body || {}).slice(0, 1500));
  res.json({ ok: true });
});

// POST /api/calls/:waCallId/recording — áudio da ligação (gravado no
// navegador) pra transcrever e resumir; responde na hora e processa depois.
router.post('/:waCallId/recording', async (req: AuthRequest, res: Response) => {
  const audioBase64 = String(req.body?.audioBase64 || '');
  if (!audioBase64) return res.status(400).json({ error: 'audioBase64 é obrigatório' });
  res.status(202).json({ ok: true });
  const { processCallRecording } = require('../services/call-recording.service') as typeof import('../services/call-recording.service');
  processCallRecording({
    accountId: req.user!.accountId, waCallId: req.params.waCallId, userId: req.user!.id,
    audio: Buffer.from(audioBase64, 'base64'), mimeType: String(req.body?.mimeType || 'audio/webm'),
  }).catch((err) => console.error('[Gravação] falhou:', err?.message));
});

const leadIdSchema = z.object({ leadId: z.string().min(1) });

// POST /api/calls/permission-request — manda o template pra pedir permissão.
router.post('/permission-request', validate(leadIdSchema), async (req: AuthRequest, res: Response) => {
  const lead = await findLeadWithPhone(req.body.leadId, req.user!.accountId);
  if (!lead?.contactId) return res.status(400).json({ error: 'Lead sem contato vinculado' });

  const result = await sendCallPermissionRequest(req.user!.accountId, lead.pipeline?.departmentId || null, lead.contactId, lead.id, (req as any).app.get('io'));
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

const outboundSchema = z.object({ leadId: z.string().min(1), sdpOffer: z.string().min(1) });

// POST /api/calls/outbound — liga pro cliente (exige permissão já concedida).
router.post('/outbound', validate(outboundSchema), async (req: AuthRequest, res: Response) => {
  const lead = await findLeadWithPhone(req.body.leadId, req.user!.accountId);
  const phoneRaw = pickRealPhone(lead?.contact);
  if (!phoneRaw) return res.status(400).json({ error: 'Lead sem telefone de WhatsApp' });

  const departmentId = lead!.pipeline?.departmentId || null;
  const config = await getWhatsAppConfig(req.user!.accountId, departmentId);
  if (!config) return res.status(400).json({ error: 'WhatsApp não configurado' });
  const phone = normalizeBrazilianWhatsAppPhone(phoneRaw);

  const permState = await getCallPermissionState(config, phone);
  if (!permState.permitted) return res.json({ ok: false, needsPermission: true });

  const result = await connectCall(config, phone, req.body.sdpOffer);
  if (!result.ok) return res.status(502).json({ error: result.json?.error?.message || 'Falha ao iniciar a ligação' });

  const waCallId = result.json?.calls?.[0]?.id || result.json?.id;
  if (!waCallId) {
    console.error('[Calling] connect ok mas sem call_id reconhecível:', JSON.stringify(result.json));
    return res.status(502).json({ error: 'A Meta não retornou o identificador da ligação' });
  }

  const created = await prisma.call.create({
    data: {
      accountId: req.user!.accountId,
      whatsappConfigId: config.id,
      leadId: req.body.leadId,
      waCallId,
      direction: 'OUTBOUND',
      status: 'CONNECTING',
      fromPhone: config.phoneNumberId,
      toPhone: phone,
      answeredByUserId: req.user!.id,
    },
  });

  const io = (req as any).app.get('io');
  await createCallMessage(req.body.leadId, 'OUTBOUND', waCallId, io, req.user!.accountId);

  res.json({ ok: true, waCallId, callId: created.id });
});

// POST /api/calls/ai-outbound — a IA (ElevenLabs) liga pro cliente pelo
// WhatsApp do CRM. Só com permissão de ligação já concedida pelo cliente.
// Restrito a ADMIN enquanto está em piloto.
router.post('/ai-outbound', validate(leadIdSchema), async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só administradores podem usar a ligação da IA por enquanto' });
  const io = (req as any).app.get('io');
  const result = await startAiCall(req.user!.accountId, req.body.leadId, io);
  if (!result.ok) return res.status(result.needsPermission ? 200 : 400).json(result);
  res.json(result);
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
