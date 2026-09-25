import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import {
  listVisibleEmailAccounts, getVisibleEmailAccount, connectPersonalMailbox, disconnectPersonalMailbox,
  syncEmailAccount, listEmailMessages, openEmailMessage, streamAttachment, sendEmailFrom,
} from '../services/email-inbox.service';
import { PrismaClient } from '@prisma/client';

/** Caixa de e-mail do CRM — ver email-inbox.service.ts. Mesma permissão da
 *  Inbox: ver (inbox_view) e mandar (inbox_reply). */
const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);
router.use(requirePermission('inbox_view'));

const io = (req: AuthRequest) => (req as any).app.get('io');
const fail = (res: Response, err: any, fallback: string) => res.status(400).json({ error: err?.message || fallback });

router.get('/accounts', async (req: AuthRequest, res: Response) => {
  res.json(await listVisibleEmailAccounts(req.user!.accountId, req.user!.id));
});

router.post('/accounts', async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    const acc = await connectPersonalMailbox({
      accountId: req.user!.accountId, userId: req.user!.id,
      address: String(b.address || ''), password: String(b.password || ''), displayName: b.displayName,
      imapHost: b.imapHost, imapPort: b.imapPort ? Number(b.imapPort) : null,
      smtpHost: b.smtpHost, smtpPort: b.smtpPort ? Number(b.smtpPort) : null,
    });
    res.json({ id: acc.id, address: acc.address });
    syncEmailAccount(acc, io(req)).catch((err) => console.warn('[E-mail] 1ª sincronização:', err?.message));
  } catch (err) {
    fail(res, err, 'Não consegui conectar o e-mail');
  }
});

router.delete('/accounts/:id', async (req: AuthRequest, res: Response) => {
  try {
    await disconnectPersonalMailbox(req.user!.accountId, req.user!.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Não consegui desconectar');
  }
});

router.post('/accounts/:id/sync', async (req: AuthRequest, res: Response) => {
  const acc = await getVisibleEmailAccount(req.user!.accountId, req.user!.id, req.params.id);
  if (!acc) return res.status(404).json({ error: 'Caixa não encontrada' });
  try {
    await syncEmailAccount(acc, io(req));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(502).json({ error: `Falha ao buscar e-mails: ${err?.responseText || err?.message || 'erro'}` });
  }
});

router.get('/accounts/:id/messages', async (req: AuthRequest, res: Response) => {
  const acc = await getVisibleEmailAccount(req.user!.accountId, req.user!.id, req.params.id);
  if (!acc) return res.status(404).json({ error: 'Caixa não encontrada' });
  const folder = req.query.folder === 'SENT' ? 'SENT' : 'INBOX';
  res.json(await listEmailMessages(acc.id, folder, { q: req.query.q as string, before: req.query.before as string }));
});

router.get('/accounts/:id/messages/:msgId', async (req: AuthRequest, res: Response) => {
  const acc = await getVisibleEmailAccount(req.user!.accountId, req.user!.id, req.params.id);
  if (!acc) return res.status(404).json({ error: 'Caixa não encontrada' });
  const msg = await openEmailMessage(acc, req.params.msgId);
  if (!msg) return res.status(404).json({ error: 'E-mail não encontrado' });
  res.json(msg);
});

router.get('/accounts/:id/messages/:msgId/attachments/:part', async (req: AuthRequest, res: Response) => {
  const acc = await getVisibleEmailAccount(req.user!.accountId, req.user!.id, req.params.id);
  if (!acc) return res.status(404).json({ error: 'Caixa não encontrada' });
  const msg = await prisma.emailMessage.findFirst({ where: { id: req.params.msgId, emailAccountId: acc.id } });
  if (!msg) return res.status(404).json({ error: 'E-mail não encontrado' });
  const listed = (msg.attachments as any[] | null)?.find((a) => a.part === req.params.part);
  if (!listed) return res.status(404).json({ error: 'Anexo não encontrado' });
  try {
    await streamAttachment(acc, msg, req.params.part, async (meta, content) => {
      res.setHeader('Content-Type', listed.contentType || meta.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(listed.filename || meta.filename || 'anexo')}`);
      await new Promise<void>((resolve, reject) => {
        content.on('error', reject);
        res.on('finish', () => resolve());
        res.on('close', () => resolve());
        content.pipe(res);
      });
    });
  } catch (err: any) {
    if (!res.headersSent) res.status(502).json({ error: err?.message || 'Não consegui baixar o anexo' });
  }
});

router.post('/accounts/:id/send', requirePermission('inbox_reply'), async (req: AuthRequest, res: Response) => {
  const acc = await getVisibleEmailAccount(req.user!.accountId, req.user!.id, req.params.id);
  if (!acc) return res.status(404).json({ error: 'Caixa não encontrada' });
  const b = req.body || {};
  const list = (v: unknown) => (Array.isArray(v) ? v : String(v || '').split(/[,;]/)).map((x) => String(x).trim()).filter(Boolean);
  try {
    const saved = await sendEmailFrom({
      acc, userId: req.user!.id, to: list(b.to), cc: list(b.cc), subject: String(b.subject || ''), body: String(b.body || ''),
      replyToId: b.replyToId || null, leadId: b.leadId || null, io: io(req),
      attachments: (Array.isArray(b.attachments) ? b.attachments : []).map((a: any) => ({
        filename: String(a?.filename || 'anexo').slice(0, 200),
        contentType: String(a?.contentType || 'application/octet-stream'),
        content: Buffer.from(String(a?.dataBase64 || ''), 'base64'),
      })),
    });
    res.json(saved);
  } catch (err) {
    fail(res, err, 'Não consegui enviar o e-mail');
  }
});

export default router;
