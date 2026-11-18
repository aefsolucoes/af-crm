import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import {
  listVisibleEmailAccounts, getVisibleEmailAccount, listSendableEmailAccounts, getSendableEmailAccount, connectPersonalMailbox, disconnectPersonalMailbox,
  syncEmailAccount, listEmailMessages, openEmailMessage, streamAttachment, sendEmailFrom,
  updateMailboxSignature, searchLeadsForEmail, linkEmailToLead, moveConversationEmail,
  moveEmail, deleteEmailForever, saveDraft, FOLDERS, Folder, conversationEmailAttachment,
  htmlToText, stripQuoted,
} from '../services/email-inbox.service';
import { getScopeDepartmentIds } from '../services/department.service';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';

/** Caixa de e-mail do CRM — ver email-inbox.service.ts. Mesma permissão da
 *  Inbox: ver (inbox_view) e mandar (inbox_reply). */
const router = Router();
router.use(authMiddleware);
router.use(requirePermission('inbox_view'));

const io = (req: AuthRequest) => (req as any).app.get('io');
const fail = (res: Response, err: any, fallback: string) => res.status(400).json({ error: err?.message || fallback });
const usuario = (req: AuthRequest) => ({ id: req.user!.id, role: req.user!.role });
const enderecos = (v: unknown) => (Array.isArray(v) ? (v as any[]) : []).map((a) => String(a?.address || '').trim().toLowerCase()).filter(Boolean);

/** Pode responder este e-mail? Está numa caixa pela qual a pessoa manda (admin: qualquer uma), ou é o e-mail da conversa do card que ela está respondendo. */
async function podeResponder(req: AuthRequest, msg: { emailAccountId: string; leadId: string | null }, leadId?: string | null) {
  if (await getSendableEmailAccount(req.user!.accountId, usuario(req), msg.emailAccountId)) return true;
  return !!leadId && msg.leadId === leadId && !!(await prisma.emailAccount.findFirst({ where: { id: msg.emailAccountId, accountId: req.user!.accountId }, select: { id: true } }));
}

router.get('/accounts', async (req: AuthRequest, res: Response) => {
  res.json(await listVisibleEmailAccounts(req.user!.accountId, req.user!.id));
});

// Caixas do "De" na janela de escrever/responder (Fabio 18/11: "responder e-mails por qualquer caixa de e-mail"): a da empresa + a própria; admin, todas.
router.get('/send-accounts', async (req: AuthRequest, res: Response) => {
  const caixas = await listSendableEmailAccounts(req.user!.accountId, usuario(req));
  res.json(caixas.map((c: any) => ({ id: c.id, address: c.address, displayName: c.displayName, shared: c.shared, ownerName: c.ownerName || null, signature: c.signature || c.defaultSignature, lastError: c.lastError || null })));
});

// "Responder e-mail" direto da conversa do cliente (Fabio 26/10): acha o e-mail original (pelo Message-ID que a conversa guarda) numa caixa que esta pessoa pode ver,
// pra o editor abrir já como RESPOSTA (mesmo fio, citação do original, mesma caixa).
router.get('/reply-target', async (req: AuthRequest, res: Response) => {
  const externalId = String(req.query.externalId || '');
  const leadId = String(req.query.leadId || '');
  if (!externalId) return res.status(400).json({ error: 'sem e-mail de origem' });
  // Responder por qualquer caixa (Fabio 18/11): o e-mail pode ter chegado em qualquer caixa ligada ao CRM. Vale a cópia numa caixa pela qual a pessoa
  // manda, ou em QUALQUER caixa quando é o e-mail da conversa deste card. O "De" já vem na caixa onde ele chegou (a do Para antes da do Cc);
  // se a pessoa não pode mandar por ela (caixa pessoal de outro usuário), vem a da empresa.
  const envio = await listSendableEmailAccounts(req.user!.accountId, usuario(req));
  const podeEnviar = new Set((envio as any[]).map((c) => c.id as string));
  const todas = await prisma.emailAccount.findMany({ where: { accountId: req.user!.accountId }, select: { id: true, address: true } });
  const enderecoDa = new Map(todas.map((c) => [c.id, c.address.toLowerCase()]));
  const copias = await prisma.emailMessage.findMany({
    where: {
      messageId: externalId, emailAccountId: { in: [...enderecoDa.keys()] },
      OR: [{ emailAccountId: { in: [...podeEnviar] }, ...(leadId ? { OR: [{ leadId }, { leadId: null }] } : {}) }, ...(leadId ? [{ leadId }] : [])],
    },
    orderBy: { date: 'desc' }, take: 10,
    select: { id: true, emailAccountId: true, fromAddress: true, fromName: true, subject: true, folder: true, toList: true, ccList: true },
  });
  const chegada = (c: (typeof copias)[number]) => {
    const caixa = enderecoDa.get(c.emailAccountId) || '';
    const pasta = c.folder === 'INBOX' || c.folder === 'SENT' ? 4 : 0;
    const dela = c.folder === 'SENT' ? (String(c.fromAddress || '').toLowerCase() === caixa ? 2 : 0) : (enderecos(c.toList).includes(caixa) ? 2 : enderecos(c.ccList).includes(caixa) ? 1 : 0);
    return pasta + dela;
  };
  const ordem = [...copias].sort((a, b) => chegada(b) - chegada(a) || Number(podeEnviar.has(b.emailAccountId)) - Number(podeEnviar.has(a.emailAccountId)));
  const msg = ordem[0];
  if (!msg) return res.status(404).json({ error: 'Não achei esse e-mail numa caixa ligada ao CRM — responda pela página E-mail.' });
  const mailboxId = podeEnviar.has(msg.emailAccountId) ? msg.emailAccountId
    : ordem.find((c) => podeEnviar.has(c.emailAccountId))?.emailAccountId || (envio as any[]).find((c) => c.shared)?.id || (envio as any[])[0]?.id || null;
  // E-mail que NÓS mandamos (Enviados): a resposta vai pro mesmo destinatário; o que o cliente mandou: responde pro remetente.
  const enviado = msg.folder === 'SENT';
  const to = enviado ? ((Array.isArray(msg.toList) ? (msg.toList as any[]) : []).map((t) => t?.address).filter(Boolean).join(', ')) : (msg.fromAddress || '');
  const subject = /^re:/i.test(String(msg.subject || '')) ? String(msg.subject) : `Re: ${msg.subject || ''}`.trim();
  res.json({ id: msg.id, mailboxId, chegouEm: enderecoDa.get(msg.emailAccountId) || null, to, subject });
});

/** Assunto sem "Re:/RES:/Fwd:/ENC:" na frente, pra achar o mesmo fio pelo assunto. */
const assuntoBase = (s: string | null | undefined) => String(s || '').replace(/^\s*((re|res|enc|fwd?|tr|aw|wg)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();

// Fio do e-mail na janela de responder (Fabio 18/11: "abra o restante dos e-mails, que dê a opção de colocar mais de um em cópia ... igual no Outlook"):
// - to/cc: o "Responder a todos" — quem mandou + Para + Cc do original, menos as nossas caixas (recebido); o que NÓS mandamos repete o Para/Cc.
// - messages: os e-mails do mesmo fio (Message-ID / In-Reply-To / References; com card, também o mesmo assunto no mesmo card), mais novo primeiro,
//   só das caixas que a pessoa vê. "text" é a parte nova de cada um; "full" o texto inteiro com o histórico citado (quando tem).
router.get('/thread/:id', async (req: AuthRequest, res: Response) => {
  // Caixas pelas quais a pessoa manda (admin: todas) + o e-mail da conversa do card respondido (?leadId), em qualquer caixa da conta.
  const caixas = await listSendableEmailAccounts(req.user!.accountId, usuario(req));
  const ids = (caixas as any[]).map((c) => c.id as string);
  const leadId = String(req.query.leadId || '');
  const parent = await prisma.emailMessage.findFirst({
    where: { id: req.params.id, emailAccount: { accountId: req.user!.accountId }, OR: [{ emailAccountId: { in: ids } }, ...(leadId ? [{ leadId }] : [])] },
  });
  if (!parent) return res.status(404).json({ error: 'E-mail não encontrado' });
  const doCard = leadId && parent.leadId === leadId ? leadId : null;
  const escopo = { OR: [{ emailAccountId: { in: ids } }, ...(doCard ? [{ leadId: doCard, emailAccount: { accountId: req.user!.accountId } }] : [])] };
  const nossas = new Set((await prisma.emailAccount.findMany({ where: { accountId: req.user!.accountId }, select: { address: true } })).map((a) => a.address.toLowerCase()));
  const unicos = (l: string[]) => [...new Set(l)];
  const remetente = String(parent.fromAddress || '').toLowerCase();
  const nosso = parent.folder === 'SENT' || nossas.has(remetente);
  const to = unicos((nosso ? enderecos(parent.toList) : [remetente, ...enderecos(parent.toList)]).filter((a) => a && !nossas.has(a)));
  const cc = unicos(enderecos(parent.ccList).filter((a) => !nossas.has(a) && !to.includes(a)));

  // Junta o fio pelos cabeçalhos (até 3 voltas: cada e-mail achado traz os ids dos dele).
  const conhecidos = new Set<string>();
  const anota = (m: { messageId: string | null; inReplyTo: string | null; references: string | null }) => {
    for (const x of [m.messageId, m.inReplyTo, ...String(m.references || '').split(/\s+/)]) if (x && x.trim()) conhecidos.add(x.trim());
  };
  anota(parent);
  const achados = new Map<string, typeof parent>([[parent.id, parent]]);
  for (let volta = 0; volta < 3; volta++) {
    const lista = [...conhecidos].slice(0, 300);
    if (!lista.length) break;
    const rows = await prisma.emailMessage.findMany({
      where: { AND: [escopo, { folder: { in: ['INBOX', 'SENT'] } }, { OR: [{ messageId: { in: lista } }, { inReplyTo: { in: lista } }] }] },
      orderBy: { date: 'desc' }, take: 80,
    });
    let novos = 0;
    for (const r of rows) if (!achados.has(r.id)) { achados.set(r.id, r); anota(r); novos++; }
    if (!novos) break;
  }
  // Mesmo assunto no mesmo card (e-mail que perdeu o cabeçalho do fio no caminho). Sem card não: "[Inter] Engajamento Automático" é o assunto de todo cliente.
  const base = assuntoBase(parent.subject);
  if (parent.leadId && base.length >= 4) {
    const mesmos = await prisma.emailMessage.findMany({
      where: { AND: [escopo, { folder: { in: ['INBOX', 'SENT'] }, leadId: parent.leadId, subject: { contains: base, mode: 'insensitive' } }] },
      orderBy: { date: 'desc' }, take: 60,
    });
    for (const r of mesmos) if (!achados.has(r.id) && assuntoBase(r.subject).toLowerCase() === base.toLowerCase()) achados.set(r.id, r);
  }

  // O mesmo e-mail pode estar em mais de uma caixa/pasta (Enviados de uma, Entrada da outra): fica um só.
  const vistos = new Set<string>();
  const rotulo = (v: unknown) => (Array.isArray(v) ? (v as any[]) : []).filter((a) => a?.address).map((a) => (a.name ? `${a.name} <${a.address}>` : String(a.address)));
  const messages = [...achados.values()]
    .sort((a, b) => (a.id === parent.id ? -1 : b.id === parent.id ? 1 : 0))
    .filter((m) => { const k = m.messageId || m.id; if (vistos.has(k)) return false; vistos.add(k); return true; })
    .sort((a, b) => b.date.getTime() - a.date.getTime())
    .slice(0, 40)
    .map((m) => {
      const inteiro = (m.textBody || (m.htmlBody ? htmlToText(m.htmlBody) : '')).replace(/\r/g, '').trim();
      const novo = stripQuoted(inteiro) || inteiro;
      return {
        id: m.id, folder: m.folder, date: m.date, fromName: m.fromName, fromAddress: m.fromAddress,
        to: rotulo(m.toList), cc: rotulo(m.ccList), subject: m.subject,
        text: novo.slice(0, 12000), full: inteiro.length > novo.length + 20 ? inteiro.slice(0, 30000) : null,
        attachments: (Array.isArray(m.attachments) ? (m.attachments as any[]) : []).map((a) => String(a?.filename || '')).filter(Boolean),
        respondendo: m.id === parent.id,
      };
    });
  res.json({ to, cc, messages });
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

router.put('/accounts/:id/signature', async (req: AuthRequest, res: Response) => {
  try {
    await updateMailboxSignature(req.user!.accountId, { id: req.user!.id, role: req.user!.role }, req.params.id, String(req.body?.signature ?? ''));
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Não consegui salvar a assinatura');
  }
});

// Busca de card pra "Vincular a um card" (nome, e-mail ou telefone).
router.get('/lead-search', async (req: AuthRequest, res: Response) => {
  const scope = await getScopeDepartmentIds(req.user!.accountId, req.user!.id, req.user!.role);
  res.json(await searchLeadsForEmail(req.user!.accountId, scope, String(req.query.q || '')));
});

router.post('/accounts/:id/messages/:msgId/link', async (req: AuthRequest, res: Response) => {
  const acc = await getVisibleEmailAccount(req.user!.accountId, req.user!.id, req.params.id);
  if (!acc) return res.status(404).json({ error: 'Caixa não encontrada' });
  try {
    res.json(await linkEmailToLead(acc, req.params.msgId, req.body?.leadId || null, io(req)));
  } catch (err) {
    fail(res, err, 'Não consegui vincular');
  }
});

// E-mail na conversa do card errado: o admin passa pro card certo ({ toLeadId }) ou tira da conversa ({ toLeadId: null }) — moveConversationEmail.
router.post('/conversation-message/:messageId/move', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só o administrador move e-mail entre cards' });
  try {
    res.json(await moveConversationEmail(req.user!.accountId, req.params.messageId, req.body?.toLeadId || null, io(req)));
  } catch (err) {
    fail(res, err, 'Não consegui mover o e-mail');
  }
});

router.post('/accounts/:id/messages/:msgId/move', async (req: AuthRequest, res: Response) => {
  const acc = await getVisibleEmailAccount(req.user!.accountId, req.user!.id, req.params.id);
  if (!acc) return res.status(404).json({ error: 'Caixa não encontrada' });
  const target = String(req.body?.folder || '');
  if (!(FOLDERS as string[]).includes(target) || target === 'DRAFTS') return res.status(400).json({ error: 'Pasta inválida' });
  try {
    res.json(await moveEmail(acc, req.params.msgId, target as Folder));
  } catch (err) {
    fail(res, err, 'Não consegui mover o e-mail');
  }
});

router.delete('/accounts/:id/messages/:msgId', async (req: AuthRequest, res: Response) => {
  const acc = await getVisibleEmailAccount(req.user!.accountId, req.user!.id, req.params.id);
  if (!acc) return res.status(404).json({ error: 'Caixa não encontrada' });
  try {
    await deleteEmailForever(acc, req.params.msgId);
    res.json({ ok: true });
  } catch (err) {
    fail(res, err, 'Não consegui excluir');
  }
});

router.post('/accounts/:id/drafts', async (req: AuthRequest, res: Response) => {
  const acc = await getSendableEmailAccount(req.user!.accountId, usuario(req), req.params.id);
  if (!acc) return res.status(404).json({ error: 'Caixa não encontrada' });
  const b = req.body || {};
  const list = (v: unknown) => (Array.isArray(v) ? v : String(v || '').split(/[,;]/)).map((x) => String(x).trim()).filter(Boolean);
  try {
    res.json(await saveDraft({ acc, to: list(b.to), cc: list(b.cc), subject: String(b.subject || ''), body: String(b.body || ''), draftId: b.draftId || null, replyToId: b.replyToId || null, userId: req.user!.id, leadId: b.leadId || null, admin: req.user!.role === 'ADMIN' }));
  } catch (err) {
    fail(res, err, 'Não consegui salvar o rascunho');
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
  const folder = (FOLDERS as string[]).includes(String(req.query.folder)) ? (req.query.folder as Folder) : 'INBOX';
  res.json(await listEmailMessages(acc.id, folder, { q: req.query.q as string, before: req.query.before as string }));
});

router.get('/accounts/:id/messages/:msgId', async (req: AuthRequest, res: Response) => {
  const acc = await getVisibleEmailAccount(req.user!.accountId, req.user!.id, req.params.id);
  if (!acc) return res.status(404).json({ error: 'Caixa não encontrada' });
  const msg = await openEmailMessage(acc, req.params.msgId);
  if (!msg) return res.status(404).json({ error: 'E-mail não encontrado' });
  res.json(msg);
});

// Anexo de um e-mail que está na CONVERSA do card (balão da Inbox) — :messageId é a mensagem da conversa, não o e-mail (Fabio 30/10).
router.get('/conversation-attachment/:messageId/:part', async (req: AuthRequest, res: Response) => {
  const found = await conversationEmailAttachment(req.user!.accountId, req.params.messageId, req.params.part).catch(() => null);
  if (!found) return res.status(404).json({ error: 'Anexo não encontrado' });
  try {
    await streamAttachment(found.acc, found.msg, req.params.part, async (meta, content) => {
      res.setHeader('Content-Type', found.listed?.contentType || meta.contentType || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(found.listed?.filename || meta.filename || 'anexo')}`);
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

// POST /api/email/suggest-reply — "Sugerir resposta" na janela de e-mail:
// só devolve um texto sugerido (a pessoa revisa e envia).
router.post('/suggest-reply', async (req: AuthRequest, res: Response) => {
  const { replyToId, leadId, subject, to, draft } = (req.body || {}) as { replyToId?: string; leadId?: string; subject?: string; to?: string; draft?: string };
  let replyTo: any = null;
  if (replyToId) {
    replyTo = await prisma.emailMessage.findUnique({
      where: { id: replyToId },
      select: { emailAccountId: true, fromName: true, fromAddress: true, subject: true, date: true, textBody: true, htmlBody: true, leadId: true },
    });
    if (!replyTo || !(await podeResponder(req, replyTo, leadId))) {
      return res.status(404).json({ error: 'E-mail não encontrado' });
    }
  }
  if (leadId && !(await prisma.lead.findFirst({ where: { id: leadId, accountId: req.user!.accountId }, select: { id: true } }))) {
    return res.status(404).json({ error: 'Card não encontrado' });
  }
  try {
    const { generateEmailReplySuggestion } = require('../services/ai-email-suggestion.service') as typeof import('../services/ai-email-suggestion.service');
    const suggestion = await generateEmailReplySuggestion({ accountId: req.user!.accountId, replyTo, leadId, subject, to, draft });
    if (!suggestion) return res.status(422).json({ error: 'Não consegui gerar uma sugestão agora — tente de novo.' });
    res.json({ suggestion });
  } catch (err: any) {
    console.error('[E-mail] Erro ao sugerir resposta:', err?.message);
    res.status(500).json({ error: 'Erro ao gerar sugestão' });
  }
});

/** Bytes de um arquivo que a conversa recebeu/mandou (MessageAttachment): no banco ou já arquivado no Drive. */
async function conversationFileBuffer(accountId: string, attachmentId: string): Promise<{ name: string; mimeType: string; buffer: Buffer } | null> {
  const { getAttachment } = await import('../services/message.service');
  const att = await getAttachment(attachmentId, accountId);
  if (!att) return null;
  if (att.data) return { name: att.fileName, mimeType: att.mimeType, buffer: Buffer.from(att.data as any) };
  if (!att.driveFileId) return null;
  const { downloadDriveFile } = await import('../services/google.service');
  return { name: att.fileName, mimeType: att.mimeType, buffer: await downloadDriveFile(accountId, att.driveFileId, att.mimeType) };
}

// POST /api/email/compose-ai — "Criar com IA" (Fabio 03/11, exemplo do gerente do BRB que pediu um e-mail pra plataforma): a IA lê a conversa inteira do card e os
// documentos que a pessoa deu pra ela LER (computador, conversa ou Drive do cliente — não vão anexados) e devolve para/assunto/corpo. A pessoa revisa e envia.
router.post('/compose-ai', async (req: AuthRequest, res: Response) => {
  const { replyToId, leadId, instruction, to, subject, draft, docs, conversationDate } = (req.body || {}) as { replyToId?: string; leadId?: string; instruction?: string; to?: string; subject?: string; draft?: string; docs?: any[]; conversationDate?: string };
  let replyTo: any = null;
  if (replyToId) {
    replyTo = await prisma.emailMessage.findUnique({
      where: { id: replyToId },
      select: { emailAccountId: true, fromName: true, fromAddress: true, subject: true, date: true, textBody: true, htmlBody: true, leadId: true },
    });
    if (!replyTo || !(await podeResponder(req, replyTo, leadId))) return res.status(404).json({ error: 'E-mail não encontrado' });
  }
  if (leadId && !(await prisma.lead.findFirst({ where: { id: leadId, accountId: req.user!.accountId }, select: { id: true } }))) return res.status(404).json({ error: 'Card não encontrado' });
  if (!leadId && !replyTo && !String(instruction || '').trim() && !(Array.isArray(docs) && docs.length)) return res.status(400).json({ error: 'Escreva o que o e-mail precisa dizer ou escolha um documento pra IA ler' });
  try {
    const lista = (Array.isArray(docs) ? docs : []).slice(0, 10);
    const { downloadDriveFileForVision } = await import('../services/google.service');
    const lidos: { name: string; mimeType: string; buffer: Buffer }[] = [];
    const pulados: string[] = [];
    for (const d of lista) {
      const name = String(d?.name || 'documento').slice(0, 200);
      try {
        let f: { name: string; mimeType: string; buffer: Buffer } | null = null;
        if (d?.attachmentId) f = await conversationFileBuffer(req.user!.accountId, String(d.attachmentId));
        else if (d?.driveFileId) { const r = await downloadDriveFileForVision(req.user!.accountId, String(d.driveFileId), String(d?.type || '')); f = { name, mimeType: r.mimeType, buffer: r.buffer }; }
        else if (d?.dataBase64) f = { name, mimeType: String(d?.type || ''), buffer: Buffer.from(String(d.dataBase64), 'base64') };
        const ok = f && (f.mimeType === 'application/pdf' || ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(f.mimeType));
        if (f && ok) lidos.push(f); else pulados.push(name);
      } catch { pulados.push(name); }
    }
    if (lidos.reduce((t, f) => t + f.buffer.length, 0) > 25 * 1024 * 1024) return res.status(400).json({ error: 'Os documentos pra IA ler passam de 25 MB — escolha menos arquivos' });
    const { generateEmailFromConversation } = require('../services/ai-email-suggestion.service') as typeof import('../services/ai-email-suggestion.service');
    const r = await generateEmailFromConversation({ accountId: req.user!.accountId, leadId, replyTo, instruction, to, subject, draft, docs: lidos, conversationDate });
    if (!r) return res.status(422).json({ error: 'Não consegui montar o e-mail agora — tente de novo.' });
    res.json({ ...r, pulados });
  } catch (err: any) {
    console.error('[E-mail] Erro ao criar com IA:', err?.message);
    res.status(500).json({ error: 'Erro ao montar o e-mail' });
  }
});

// Dias que têm conversa no card (pro "Criar com IA" escolher de qual conversa sai o e-mail — Fabio 03/11). Mais recentes primeiro, horário de Brasília.
router.get('/lead-conversation-days', async (req: AuthRequest, res: Response) => {
  const leadId = String(req.query.leadId || '');
  if (!leadId || !(await prisma.lead.findFirst({ where: { id: leadId, accountId: req.user!.accountId }, select: { id: true } }))) return res.status(404).json({ error: 'Cliente não encontrado' });
  const dias = await prisma.$queryRaw<{ dia: string; n: bigint }[]>`SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia, count(*) AS n FROM "Message" WHERE "leadId" = ${leadId} AND channel <> 'EMAIL' AND deleted = false GROUP BY 1 ORDER BY 1 DESC LIMIT 60`;
  res.json(dias.map((d) => ({ date: d.dia, count: Number(d.n) })));
});

// Arquivos que chegaram/saíram na conversa do card (pra IA ler ou pra anexar no e-mail).
router.get('/lead-conversation-files', async (req: AuthRequest, res: Response) => {
  const leadId = String(req.query.leadId || '');
  if (!leadId || !(await prisma.lead.findFirst({ where: { id: leadId, accountId: req.user!.accountId }, select: { id: true } }))) return res.status(404).json({ error: 'Cliente não encontrado' });
  const atts = await prisma.messageAttachment.findMany({
    where: { leadId, NOT: [{ mimeType: { startsWith: 'audio/' } }, { mimeType: { startsWith: 'video/' } }] },
    orderBy: { createdAt: 'desc' }, take: 80,
    select: { id: true, fileName: true, mimeType: true, createdAt: true, message: { select: { direction: true } } },
  });
  const { isStickerAttachment } = await import('../services/google.service');
  res.json(atts.filter((a) => !isStickerAttachment(a as any)).map((a) => ({ id: a.id, name: a.fileName, mimeType: a.mimeType, createdAt: a.createdAt, recebido: a.message?.direction === 'INBOUND' })));
});

// Arquivos da pasta do cliente no Drive (Fabio 27/10: "a resposta do e-mail deve ter opção de buscar documentos dentro da pasta do cliente no Drive").
// A pasta é a do card ("link_pasta_drive"); sem ela, procura uma pasta com o nome do cliente dentro da raiz do Drive.
router.get('/lead-drive-files', async (req: AuthRequest, res: Response) => {
  try {
    const leadId = String(req.query.leadId || '');
    const lead = leadId ? await prisma.lead.findFirst({ where: { id: leadId, accountId: req.user!.accountId }, select: { name: true, customFields: true } }) : null;
    if (!lead) return res.status(404).json({ error: 'Cliente não encontrado' });
    const { extractFolderId, listAllFilesInFolderTree, findFolderByNameUnderRoot, folderLink } = await import('../services/google.service');
    const cf = (lead.customFields || {}) as Record<string, any>;
    let folderId = String(cf.link_pasta_drive || '').trim() ? extractFolderId(String(cf.link_pasta_drive)) : '';
    if (!folderId) folderId = (await findFolderByNameUnderRoot(req.user!.accountId, String(cf.participante_1 || lead.name || '')).catch(() => null))?.folderId || '';
    if (!folderId) return res.json({ folderUrl: null, files: [] });
    const files = (await listAllFilesInFolderTree(req.user!.accountId, folderId, 3)).filter((f) => !f.mimeType.startsWith('application/vnd.google-apps.'));
    res.json({ folderUrl: folderLink(folderId), files: files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, path: f.path, size: f.size })) });
  } catch (err) {
    fail(res, err, 'Não consegui abrir a pasta do cliente no Drive');
  }
});

// Miniatura (gerada pelo Drive) e o arquivo inteiro, pra VER o documento antes de anexar (Fabio 27/10: "preciso visualizar o arquivo, nem que seja pequeno").
router.get('/drive-thumb/:fileId', async (req: AuthRequest, res: Response) => {
  try {
    const { getDrive } = await import('../services/google.service');
    const drive = await getDrive(req.user!.accountId);
    const meta = await drive.files.get({ fileId: req.params.fileId, fields: 'thumbnailLink', supportsAllDrives: true });
    const link = meta.data.thumbnailLink;
    if (!link) return res.status(404).end();
    const { token } = await ((drive as any).context._options.auth).getAccessToken();
    const r = await fetch(link.replace(/=s\d+$/, '=s240'), { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return res.status(404).end();
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.status(404).end();
  }
});
router.get('/drive-file/:fileId', async (req: AuthRequest, res: Response) => {
  try {
    const { getDrive, downloadDriveFile } = await import('../services/google.service');
    const drive = await getDrive(req.user!.accountId);
    const meta = await drive.files.get({ fileId: req.params.fileId, fields: 'name, mimeType, size', supportsAllDrives: true });
    if (Number(meta.data.size || 0) > 25 * 1024 * 1024) return res.status(413).json({ error: 'Arquivo grande demais pra visualizar aqui (mais de 25 MB) — abra no Drive' });
    const buf = await downloadDriveFile(req.user!.accountId, req.params.fileId, meta.data.mimeType || '');
    res.setHeader('Content-Type', meta.data.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(meta.data.name || 'arquivo')}"`);
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.send(buf);
  } catch (err) {
    fail(res, err, 'Não consegui abrir o arquivo do Drive');
  }
});

/** Endereço de banco/correspondente que recebe pedido de vistoria (Inter, Creditas, Santander/Credimorar, CAIXA, Itaú, BRB). */
const BANCO_EMAIL = /@([a-z0-9-]+\.)*(inter\.co|bancointer\.com\.br|creditas\.com(\.br)?|credimorar\.(com\.vc|me|com\.br|com)|santander\.com\.br|caixa\.gov\.br|itau(-unibanco)?\.com\.br|brb\.com\.br)$/i;
/** É pedido de vistoria? Assunto com "vistoria", ou o texto pede/agenda a vistoria — e vai pra um banco (e-mail ao cliente sobre a vistoria não conta). */
export function ehEmailDeVistoria(subject: string, body: string, destinos: string[]): boolean {
  if (!destinos.some((a) => BANCO_EMAIL.test(a))) return false;
  return /vistoria/i.test(subject) || /(solicit\w*|pedido de|agendar|agendamento d[aeo]|abrir|abertura d[aeo])\s+(a\s+|da\s+)?vistoria/i.test(body);
}

router.post('/accounts/:id/send', requirePermission('inbox_reply'), async (req: AuthRequest, res: Response) => {
  const acc = await getSendableEmailAccount(req.user!.accountId, usuario(req), req.params.id);
  if (!acc) return res.status(404).json({ error: 'Caixa não encontrada' });
  const b = req.body || {};
  const list = (v: unknown) => (Array.isArray(v) ? v : String(v || '').split(/[,;]/)).map((x) => String(x).trim()).filter(Boolean);
  try {
    // Anexo escolhido na pasta do cliente no Drive: vem só o id; o servidor baixa.
    const { downloadDriveFile } = await import('../services/google.service');
    // Arquivo da conversa do card (attachmentId): o servidor busca no banco ou no Drive (Fabio 03/11).
    const attachments = await Promise.all((Array.isArray(b.attachments) ? b.attachments : []).map(async (a: any) => ({
      filename: String(a?.filename || 'anexo').slice(0, 200),
      contentType: String(a?.contentType || 'application/octet-stream'),
      content: a?.attachmentId ? ((await conversationFileBuffer(req.user!.accountId, String(a.attachmentId)))?.buffer || Buffer.alloc(0))
        : a?.driveFileId ? await downloadDriveFile(req.user!.accountId, String(a.driveFileId), String(a?.contentType || '')) : Buffer.from(String(a?.dataBase64 || ''), 'base64'),
    })));
    if (attachments.some((a) => !a.content.length)) return res.status(400).json({ error: 'Não consegui buscar um dos arquivos da conversa — tire e anexe de novo' });
    if (attachments.reduce((t, a) => t + a.content.length, 0) > 20 * 1024 * 1024) return res.status(400).json({ error: 'Os anexos passam de 20 MB — mande em mais de um e-mail' });
    const saved = await sendEmailFrom({
      acc, userId: req.user!.id, to: list(b.to), cc: list(b.cc), bcc: list(b.bcc), subject: String(b.subject || ''), body: String(b.body || ''),
      replyToId: b.replyToId || null, leadId: b.leadId || null, io: io(req), draftId: b.draftId || null, admin: req.user!.role === 'ADMIN',
      attachments,
    });
    res.json(saved);
    // E-mail de VISTORIA escrito pela equipe e mandado ao banco pela caixa do CRM (modo manual, fora dos botões de vistoria): o card vai pra "Vistoria do Imóvel"
    // (Fabio 07/11: "sempre que solicitar a vistoria, a etapa do cliente deve ir para Vistoria do Imóvel"). Só pra frente; card já adiante fica onde está.
    const destinos = [...list(b.to), ...list(b.cc), ...list(b.bcc)].map((a) => a.toLowerCase());
    if (saved?.leadId && ehEmailDeVistoria(String(b.subject || ''), String(b.body || ''), destinos)) {
      const { moverParaVistoria } = require('../services/vistoria-inter.service') as typeof import('../services/vistoria-inter.service');
      moverParaVistoria(req.user!.accountId, saved.leadId, `e-mail de vistoria enviado a ${destinos.filter((a) => BANCO_EMAIL.test(a)).join(', ')}`, io(req) as any).catch(() => {});
    }
  } catch (err) {
    fail(res, err, 'Não consegui enviar o e-mail');
  }
});

export default router;
