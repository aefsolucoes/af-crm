import { Router, Response, Request } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { startQRConnection, getQRStatus, disconnectQR, refreshGroupNames, resolveLidPhones, getGroupParticipants } from '../services/baileys.service';

const prisma = new PrismaClient();
const router = Router();

// Endpoint público de debug — sem auth
router.get('/debug', async (req: Request, res: Response) => {
  try {
    const baileys = await import('@whiskeysockets/baileys') as any;
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    res.json({
      makeWASocket_type: typeof makeWASocket,
      node_version: process.version,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.use(authMiddleware);

// ─── Lista de números da conta (multi-sessão) ───────────────────────────────

// GET /api/whatsapp-qr/numbers — lista números + status ao vivo
router.get('/numbers', async (req: AuthRequest, res: Response) => {
  const numbers = await prisma.whatsAppNumber.findMany({
    where: { accountId: req.user!.accountId },
    orderBy: { createdAt: 'asc' },
  });
  res.json(numbers.map(n => ({
    id: n.id,
    label: n.label,
    phone: n.phone,
    status: getQRStatus(n.id).status,
    departmentId: n.departmentId,
  })));
});

// POST /api/whatsapp-qr/numbers — cria um novo número (com apelido)
router.post('/numbers', async (req: AuthRequest, res: Response) => {
  const { label } = req.body as { label?: string };
  if (!label || !label.trim()) return res.status(400).json({ error: 'Apelido (label) é obrigatório' });
  const number = await prisma.whatsAppNumber.create({
    data: { accountId: req.user!.accountId, label: label.trim() },
  });
  res.status(201).json({ id: number.id, label: number.label, phone: null, status: 'disconnected' });
});

// PATCH /api/whatsapp-qr/numbers/:id — renomeia e/ou muda o setor
router.patch('/numbers/:id', async (req: AuthRequest, res: Response) => {
  const { label, departmentId } = req.body as { label?: string; departmentId?: string | null };
  const number = await prisma.whatsAppNumber.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
  if (!number) return res.status(404).json({ error: 'Número não encontrado' });

  const data: Record<string, unknown> = {};
  if (label !== undefined) {
    if (!label.trim()) return res.status(400).json({ error: 'Apelido (label) é obrigatório' });
    data.label = label.trim();
  }
  if (departmentId !== undefined) {
    if (departmentId) {
      const dept = await prisma.department.findFirst({ where: { id: departmentId, accountId: req.user!.accountId } });
      if (!dept) return res.status(400).json({ error: 'Departamento inválido' });
    }
    data.departmentId = departmentId || null;
  }

  const updated = await prisma.whatsAppNumber.update({ where: { id: number.id }, data });
  res.json({ id: updated.id, label: updated.label, departmentId: updated.departmentId });
});

// DELETE /api/whatsapp-qr/numbers/:id — desconecta e remove
router.delete('/numbers/:id', async (req: AuthRequest, res: Response) => {
  const number = await prisma.whatsAppNumber.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
  if (!number) return res.status(404).json({ error: 'Número não encontrado' });
  await disconnectQR(number.id).catch(() => {});
  // Desvincula conversas/mensagens antes de remover (mantém o histórico)
  await prisma.lead.updateMany({ where: { whatsappNumberId: number.id }, data: { whatsappNumberId: null } });
  await prisma.message.updateMany({ where: { whatsappNumberId: number.id }, data: { whatsappNumberId: null } });
  await prisma.whatsAppNumber.delete({ where: { id: number.id } });
  res.json({ success: true });
});

// GET /api/whatsapp-qr/numbers/:id/status — status + QR de um número
router.get('/numbers/:id/status', async (req: AuthRequest, res: Response) => {
  const number = await prisma.whatsAppNumber.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
  if (!number) return res.status(404).json({ error: 'Número não encontrado' });
  res.json({ ...getQRStatus(number.id), phone: number.phone });
});

// POST /api/whatsapp-qr/numbers/:id/connect — inicia conexão QR de um número
router.post('/numbers/:id/connect', async (req: AuthRequest, res: Response) => {
  const number = await prisma.whatsAppNumber.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
  if (!number) return res.status(404).json({ error: 'Número não encontrado' });

  const { status } = getQRStatus(number.id);
  if (status === 'connected') return res.json({ status: 'connected' });

  await disconnectQR(number.id).catch(() => {});
  startQRConnection(number.id, req.user!.accountId).catch(console.error);
  res.json({ status: 'connecting' });
});

// POST /api/whatsapp-qr/numbers/:id/disconnect — desconecta um número
router.post('/numbers/:id/disconnect', async (req: AuthRequest, res: Response) => {
  const number = await prisma.whatsAppNumber.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
  if (!number) return res.status(404).json({ error: 'Número não encontrado' });
  await disconnectQR(number.id);
  res.json({ status: 'disconnected' });
});

// Atualiza os nomes dos grupos (assunto real) a partir do WhatsApp conectado
router.post('/refresh-groups', async (req: AuthRequest, res: Response) => {
  try {
    const result = await refreshGroupNames(req.user!.accountId);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao atualizar grupos' });
  }
});

// Integrantes de um grupo (para o painel da Inbox)
router.get('/group/:leadId/members', async (req: AuthRequest, res: Response) => {
  try {
    const result = await getGroupParticipants(req.user!.accountId, req.params.leadId);
    if (!result) return res.status(404).json({ error: 'Conversa não é um grupo ou não foi encontrada' });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao buscar integrantes do grupo' });
  }
});

// Resolve os telefones reais dos contatos @lid (backfill via mapa LID→número)
router.post('/resolve-phones', async (req: AuthRequest, res: Response) => {
  try {
    const result = await resolveLidPhones(req.user!.accountId);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao resolver telefones' });
  }
});

export default router;
