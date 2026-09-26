import crypto from 'crypto';
import net from 'net';
import { Readable } from 'stream';
import { PrismaClient, EmailAccount, EmailMessage, Prisma } from '@prisma/client';
import { ImapFlow, FetchMessageObject, MessageStructureObject } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import { sealSecret, openSecret } from '../lib/secret-box';
import { companySignatureHtml, companySignatureText } from './email.service';

/**
 * Caixa de e-mail dentro do CRM (pedido do Fabio, 2026-09-24/25): a caixa da
 * empresa (comercial@, credenciais do ambiente SMTP_*) + a caixa pessoal de
 * cada colaborador. Lê por IMAP (poll a cada minuto, index.ts), envia por
 * SMTP e grava o enviado na pasta Enviados do servidor (APPEND), pra ficar
 * igual ao webmail. E-mail de/para um contato conhecido (Contact.email)
 * também entra na conversa do card como mensagem de canal EMAIL — é assim
 * que o follow-up por e-mail volta pro CRM.
 *
 * Anexos não são baixados na sincronização (só a lista); o download busca
 * direto no IMAP na hora — nada de arquivo em disco (incidentes de agosto).
 */

const prisma = new PrismaClient();

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
export type Folder = 'INBOX' | 'SENT' | 'DRAFTS' | 'SPAM' | 'TRASH';
export const FOLDERS: Folder[] = ['INBOX', 'SENT', 'DRAFTS', 'SPAM', 'TRASH'];
type Addr = { name?: string; address?: string };
type FolderState = { uidValidity: string; lastUid: number };

const INITIAL_DAYS = 30;
const INITIAL_LIMIT = 150;
const TEXT_LIMIT = 200_000;
// Anexo no envio: o provedor (Titan) aceita ~25 MB por e-mail já codificado
// (base64 infla ~33%), então 15 MB de arquivo cabe com folga.
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const HTML_LIMIT = 600_000;

// ─── Credenciais / conexão ────────────────────────────────────────────────

function passwordFor(acc: EmailAccount): string {
  if (acc.passwordEnc) return openSecret(acc.passwordEnc);
  const envPass = process.env.SMTP_PASS;
  if (!acc.userId && envPass && acc.username.toLowerCase() === (process.env.SMTP_USER || '').toLowerCase()) return envPass;
  throw new Error('Senha da caixa não configurada');
}

function imapClient(cfg: { host: string; port: number; user: string; pass: string }) {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 993,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000,
  } as any);
}

function smtpTransport(cfg: { host: string; port: number; user: string; pass: string }) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

async function withImap<T>(acc: EmailAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = imapClient({ host: acc.imapHost, port: acc.imapPort, user: acc.username, pass: passwordFor(acc) });
  client.on('error', (err: Error) => console.warn(`[E-mail] IMAP ${acc.address}:`, err?.message));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

const SPECIAL_USE: Record<Folder, string> = { INBOX: '\\Inbox', SENT: '\\Sent', DRAFTS: '\\Drafts', SPAM: '\\Junk', TRASH: '\\Trash' };
const FOLDER_NAMES: Record<Folder, RegExp> = {
  INBOX: /^inbox$/i,
  SENT: /^(sent|enviad|itens enviados|sent items|sent messages)/i,
  DRAFTS: /^(drafts?|rascunho)/i,
  SPAM: /^(spam|junk|lixo eletr)/i,
  TRASH: /^(trash|lixeira|deleted|itens exclu)/i,
};

/** Caminho da pasta no servidor (pela marca special-use, ou pelo nome). */
async function folderPath(client: ImapFlow, folder: Folder, boxes?: Awaited<ReturnType<ImapFlow['list']>>): Promise<string | null> {
  if (folder === 'INBOX') return 'INBOX';
  const list = boxes || await client.list();
  return list.find((b) => b.specialUse === SPECIAL_USE[folder])?.path
    || list.find((b) => FOLDER_NAMES[folder].test(b.name))?.path
    || null;
}

const sentPath = (client: ImapFlow) => folderPath(client, 'SENT');

/** Caixa da empresa: criada sozinha a partir do SMTP_* do ambiente (a
 *  senha nunca vai pro banco). IMAP deduzido do SMTP (smtp.x → imap.x) ou
 *  IMAP_HOST/IMAP_PORT se definidos. */
export async function ensureCompanyMailbox(accountId: string): Promise<void> {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, IMAP_HOST, IMAP_PORT } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return;
  const address = SMTP_USER.trim().toLowerCase();
  const exists = await prisma.emailAccount.findUnique({ where: { accountId_address: { accountId, address } } });
  if (exists) return;
  await prisma.emailAccount.create({
    data: {
      accountId, userId: null, address, displayName: 'Comercial',
      imapHost: IMAP_HOST || SMTP_HOST.replace(/^smtp\./i, 'imap.'),
      imapPort: parseInt(IMAP_PORT || '993', 10),
      smtpHost: SMTP_HOST, smtpPort: parseInt(SMTP_PORT || '587', 10),
      username: SMTP_USER,
    },
  }).catch(() => {}); // corrida entre dois pedidos: o outro já criou
}

/** Assinatura padrão (quando a caixa não tem uma própria). */
function defaultSignature(acc: { userId: string | null }, userName?: string | null): string {
  return acc.userId ? `${userName || ''}\nA & F Soluções Financeiras`.trim() : companySignatureText();
}

/** Site, e-mail e telefone da assinatura viram link clicável (pedido do
 *  Fabio). Mesma regra no preview do front (lib/signature-links.ts). */
const SIGNATURE_LINK_RE = /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|(https?:\/\/[^\s<]+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|br|io|app|site|online)(?:\.br)?(?:\/[^\s<]*)?)|(\(?\d{2}\)?\s?\d[\d.\s-]{7,}\d)/gi;
const LINK_STYLE = 'color:#3b82f6;text-decoration:none';

function linkifySignatureLine(line: string): string {
  // Linha que fala em WhatsApp: o número abre conversa no WhatsApp (wa.me)
  // em vez de ligar — o número da API Oficial não recebe ligação comum.
  const whatsapp = /whats\s*app|wpp|zap/i.test(line);
  return escapeHtml(line).replace(SIGNATURE_LINK_RE, (m, email, url, phone) => {
    if (email) return `<a href="mailto:${email}" style="${LINK_STYLE}">${email}</a>`;
    if (url) return `<a href="${/^https?:/i.test(url) ? url : `https://${url}`}" style="${LINK_STYLE}">${url}</a>`;
    if (phone) {
      const digits = phone.replace(/\D/g, '');
      const full = digits.length <= 11 ? `55${digits}` : digits;
      return `<a href="${whatsapp ? `https://wa.me/${full}` : `tel:+${full}`}" style="${LINK_STYLE}">${phone}</a>`;
    }
    return m;
  });
}

/** Assinatura em HTML: 1ª linha em destaque, as outras menores — mesmo
 *  visual da assinatura institucional que já existia. */
function signatureHtml(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const [first, ...rest] = lines;
  return `<div style="margin:28px 0 0;border-left:3px solid #3b82f6;padding-left:14px">
    <p style="font-size:13px;font-weight:700;color:#0d2545;margin:0 0 6px">${escapeHtml(first)}</p>
    ${rest.map((l) => `<p style="font-size:12px;color:#475569;margin:0 0 3px">${linkifySignatureLine(l)}</p>`).join('')}
  </div>`;
}

/** Caixas que o usuário enxerga: a da empresa + a dele. */
export async function listVisibleEmailAccounts(accountId: string, userId: string) {
  await ensureCompanyMailbox(accountId);
  const me = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const accounts = await prisma.emailAccount.findMany({
    where: { accountId, OR: [{ userId: null }, { userId }] },
    orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, userId: true, address: true, displayName: true, imapHost: true, imapPort: true, smtpHost: true, smtpPort: true, lastSyncAt: true, lastError: true, signature: true },
  });
  const unread = await prisma.emailMessage.groupBy({
    by: ['emailAccountId'],
    where: { emailAccountId: { in: accounts.map((a) => a.id) }, folder: 'INBOX', seen: false },
    _count: { _all: true },
  });
  return accounts.map((a) => ({
    ...a,
    shared: !a.userId,
    unread: unread.find((u) => u.emailAccountId === a.id)?._count._all || 0,
    defaultSignature: defaultSignature(a, me?.name),
  }));
}

/** Pessoal: só o dono edita. Empresa: só admin (vale pra todo mundo). */
export async function updateMailboxSignature(accountId: string, user: { id: string; role: string }, id: string, signature: string) {
  const acc = await prisma.emailAccount.findFirst({ where: { id, accountId, OR: [{ userId: null }, { userId: user.id }] } });
  if (!acc) throw new Error('Caixa não encontrada');
  if (!acc.userId && user.role !== 'ADMIN') throw new Error('Só o administrador muda a assinatura da caixa da empresa');
  const text = signature.replace(/\r/g, '').trim().slice(0, 1000);
  await prisma.emailAccount.update({ where: { id }, data: { signature: text || null } });
}

export async function getVisibleEmailAccount(accountId: string, userId: string, id: string) {
  return prisma.emailAccount.findFirst({ where: { id, accountId, OR: [{ userId: null }, { userId }] } });
}

/** Conecta (ou reconecta) a caixa pessoal do usuário — testa IMAP e SMTP
 *  antes de salvar, pra não guardar senha errada. */
export async function connectPersonalMailbox(params: {
  accountId: string; userId: string; address: string; password: string; displayName?: string | null;
  imapHost?: string | null; imapPort?: number | null; smtpHost?: string | null; smtpPort?: number | null;
}) {
  const address = params.address.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error('E-mail inválido');
  if (!params.password) throw new Error('Informe a senha do e-mail');
  const domain = address.split('@')[1];
  const imapHost = (params.imapHost || '').trim() || 'imap.titan.email';
  const smtpHost = (params.smtpHost || '').trim() || 'smtp.titan.email';
  const imapPort = params.imapPort || 993;
  const smtpPort = params.smtpPort || 587;

  const taken = await prisma.emailAccount.findUnique({ where: { accountId_address: { accountId: params.accountId, address } } });
  if (taken && taken.userId !== params.userId) {
    throw new Error(taken.userId ? 'Esse e-mail já está conectado por outra pessoa' : 'Essa é a caixa da empresa — ela já aparece pra todo mundo');
  }

  const imap = imapClient({ host: imapHost, port: imapPort, user: address, pass: params.password });
  try {
    await imap.connect();
    await imap.logout();
  } catch (err: any) {
    throw new Error(`Não consegui entrar no e-mail (IMAP ${imapHost}): ${err?.responseText || err?.message || 'erro'}. Confira a senha${domain.includes('gmail') ? ' — no Gmail precisa ser uma "senha de app"' : ''}.`);
  }
  try {
    await smtpTransport({ host: smtpHost, port: smtpPort, user: address, pass: params.password }).verify();
  } catch (err: any) {
    throw new Error(`Entrou pra ler, mas o envio falhou (SMTP ${smtpHost}:${smtpPort}): ${err?.message || 'erro'}`);
  }

  // Uma caixa pessoal por usuário: conectar outra substitui a anterior.
  await prisma.emailAccount.deleteMany({ where: { accountId: params.accountId, userId: params.userId, NOT: { address } } });
  const data = {
    displayName: params.displayName?.trim() || null, imapHost, imapPort, smtpHost, smtpPort,
    username: address, passwordEnc: sealSecret(params.password), lastError: null,
  };
  return taken
    ? prisma.emailAccount.update({ where: { id: taken.id }, data })
    : prisma.emailAccount.create({ data: { ...data, accountId: params.accountId, userId: params.userId, address } });
}

export async function disconnectPersonalMailbox(accountId: string, userId: string, id: string) {
  const { count } = await prisma.emailAccount.deleteMany({ where: { id, accountId, userId } });
  if (!count) throw new Error('Só dá pra desconectar a sua própria caixa');
}

// ─── Conteúdo ─────────────────────────────────────────────────────────────

function walkStructure(node: MessageStructureObject | undefined, out: { text?: string; html?: string; attachments: { part: string; filename: string; contentType: string; size: number }[] }) {
  if (!node) return out;
  if (node.childNodes?.length) {
    for (const child of node.childNodes) walkStructure(child, out);
    return out;
  }
  const part = node.part || '1';
  const type = (node.type || '').toLowerCase();
  const filename = node.dispositionParameters?.filename || node.parameters?.name;
  const isAttachment = node.disposition === 'attachment' || (!!filename && !type.startsWith('text/'));
  if (isAttachment) {
    out.attachments.push({ part, filename: filename || 'anexo', contentType: type, size: node.size || 0 });
  } else if (type === 'text/plain' && !out.text) {
    out.text = part;
  } else if (type === 'text/html' && !out.html) {
    out.html = part;
  }
  return out;
}

async function readStream(stream: Readable, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (total < limit) chunks.push(buf.subarray(0, limit - total));
    total += buf.length;
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Só a parte nova da resposta — corta o histórico citado ("Em ... escreveu:",
 *  "On ... wrote:", linhas com ">", "-----Original Message-----"). */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const joined = `${line} ${lines[i + 1] || ''}`;
    if (/^\s*>/.test(line)) break;
    if (/^-{2,}\s*(original message|mensagem original|forwarded message|mensagem encaminhada)/i.test(line.trim())) break;
    if (/^(em|on)\s.+(escreveu|wrote):?\s*$/i.test(line.trim()) || /^(em|on)\s.{10,200}(escreveu|wrote):/i.test(joined.trim())) break;
    if (/^de:\s.+@/i.test(line.trim()) && i > 0) break;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function parseReferences(headers?: Buffer): string | null {
  if (!headers) return null;
  const m = headers.toString('utf8').replace(/\r?\n[ \t]+/g, ' ').match(/^references:\s*(.+)$/im);
  return m ? m[1].trim().slice(0, 4000) : null;
}

const addrList = (list?: Addr[]) => (list || []).filter((a) => a.address).map((a) => ({ name: a.name || null, address: a.address!.toLowerCase() }));

// ─── Vínculo com o card ─────────────────────────────────────────────────────

async function findLeadFor(accountId: string, addresses: string[], inReplyTo: string | null, ownAddresses: Set<string>): Promise<string | null> {
  if (inReplyTo) {
    const parent = await prisma.emailMessage.findFirst({ where: { messageId: inReplyTo, leadId: { not: null }, emailAccount: { accountId } }, select: { leadId: true } });
    if (parent?.leadId) return parent.leadId;
  }
  for (const address of addresses) {
    if (!address || ownAddresses.has(address)) continue;
    const lead = await prisma.lead.findFirst({
      where: { accountId, isGroup: false, contact: { email: { equals: address, mode: 'insensitive' } } },
      orderBy: [{ archived: 'asc' }, { updatedAt: 'desc' }],
      select: { id: true },
    });
    if (lead) return lead.id;
    // Remetente que alguém já vinculou a um card na mão ("Vincular a um card").
    const remembered = await prisma.emailMessage.findFirst({
      where: { leadId: { not: null }, emailAccount: { accountId }, OR: [{ fromAddress: address }, { folder: 'SENT', toList: { array_contains: [{ address }] } }] },
      orderBy: { date: 'desc' },
      select: { leadId: true },
    });
    if (remembered?.leadId) return remembered.leadId;
  }
  return null;
}

async function addToConversation(params: {
  accountId: string; leadId: string; direction: 'INBOUND' | 'OUTBOUND'; subject: string | null; body: string;
  messageId: string | null; date: Date; sentByUserId?: string | null; notify: boolean; io: Io; fromLabel?: string;
}) {
  const { accountId, leadId, direction, messageId, io } = params;
  if (messageId) {
    const dup = await prisma.message.findFirst({ where: { leadId, channel: 'EMAIL', externalId: messageId }, select: { id: true } });
    if (dup) return;
  }
  const body = params.body.slice(0, 6000);
  const message = await prisma.message.create({
    data: {
      content: `📧 ${params.subject || '(sem assunto)'}\n\n${body}`,
      direction, channel: 'EMAIL', leadId, externalId: messageId || undefined, status: 'SENT',
      read: direction === 'OUTBOUND' || !params.notify, createdAt: params.date,
      sentByUserId: params.sentByUserId || undefined,
    },
    include: { sentBy: { select: { id: true, name: true } } },
  });
  if (!params.notify || !io) return;
  io.to(`lead:${leadId}`).emit('new_message', message);
  io.to(`account_${accountId}`).emit('new_notification', { leadId, message });
  if (direction === 'INBOUND') {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true } });
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `📧 ${lead?.name || params.fromLabel || 'E-mail'}`, body: params.subject || body.slice(0, 120), leadId }).catch(() => {});
  }
}

// ─── Sincronização ────────────────────────────────────────────────────────

async function storeFetched(acc: EmailAccount, client: ImapFlow, folder: Folder, msg: FetchMessageObject, opts: { initial: boolean; ownAddresses: Set<string>; io: Io }) {
  const env = msg.envelope || ({} as any);
  const messageId: string | null = env.messageId || null;

  // O que o próprio CRM gravou antes do servidor (enviado, rascunho, e-mail
  // movido sem o uid novo) já está no banco sem uid — só completa o uid.
  if (messageId) {
    const mine = await prisma.emailMessage.findFirst({ where: { emailAccountId: acc.id, folder, messageId, uid: null } });
    if (mine) {
      // Anexos enviados pelo CRM só ganham o "endereço" (part) pra download
      // depois que a cópia aparece em Enviados no servidor.
      const found = walkStructure(msg.bodyStructure, { attachments: [] }).attachments;
      await prisma.emailMessage.update({
        where: { id: mine.id },
        data: { uid: msg.uid, ...(found.length ? { attachments: found as unknown as Prisma.InputJsonValue } : {}) },
      }).catch(() => {});
      return;
    }
  }
  const already = await prisma.emailMessage.findUnique({ where: { emailAccountId_folder_uid: { emailAccountId: acc.id, folder, uid: msg.uid } }, select: { id: true } });
  if (already) return;

  const parts = walkStructure(msg.bodyStructure, { attachments: [] });
  let textBody: string | null = null;
  let htmlBody: string | null = null;
  try {
    if (parts.text) textBody = await readStream((await client.download(String(msg.uid), parts.text, { uid: true, maxBytes: TEXT_LIMIT })).content, TEXT_LIMIT);
    if (parts.html) htmlBody = await readStream((await client.download(String(msg.uid), parts.html, { uid: true, maxBytes: HTML_LIMIT })).content, HTML_LIMIT);
  } catch (err: any) {
    console.warn(`[E-mail] ${acc.address} uid ${msg.uid}: corpo não baixou:`, err?.message);
  }
  const plain = textBody || (htmlBody ? htmlToText(htmlBody) : '');
  const fresh = stripQuoted(plain) || plain;
  const attachedNote = parts.attachments.length ? `\n\n📎 ${parts.attachments.map((a) => a.filename).join(', ')}` : '';

  const from = addrList(env.from)[0] || null;
  const to = addrList(env.to);
  const cc = addrList(env.cc);
  const date = env.date ? new Date(env.date) : (msg.internalDate ? new Date(msg.internalDate as any) : new Date());
  // Só Entrada e Enviados vão pra conversa do card (spam/lixeira/rascunho não).
  const convo = folder === 'INBOX' || folder === 'SENT';
  const counterparts = folder === 'INBOX' ? (from ? [from.address] : []) : [...to, ...cc].map((a) => a.address);
  const leadId = convo ? await findLeadFor(acc.accountId, counterparts, env.inReplyTo || null, opts.ownAddresses) : null;

  await prisma.emailMessage.create({
    data: {
      emailAccountId: acc.id, folder, uid: msg.uid, messageId, inReplyTo: env.inReplyTo || null,
      references: parseReferences(msg.headers as Buffer | undefined),
      fromName: from?.name || null, fromAddress: from?.address || null,
      toList: to as unknown as Prisma.InputJsonValue, ccList: cc as unknown as Prisma.InputJsonValue,
      subject: env.subject || null, date,
      snippet: fresh.replace(/\s+/g, ' ').slice(0, 200) || null,
      textBody, htmlBody,
      attachments: parts.attachments as unknown as Prisma.InputJsonValue,
      seen: folder === 'SENT' || folder === 'DRAFTS' || (msg.flags ? msg.flags.has('\\Seen') : false),
      leadId,
    },
  }).catch((err) => { if (err?.code !== 'P2002') throw err; });

  if (leadId) {
    await addToConversation({
      accountId: acc.accountId, leadId, direction: folder === 'INBOX' ? 'INBOUND' : 'OUTBOUND',
      subject: env.subject || null, body: `${fresh}${attachedNote}`, messageId, date,
      notify: !opts.initial && folder === 'INBOX', io: opts.io, fromLabel: from?.name || from?.address,
    });
  }
}

async function syncFolder(acc: EmailAccount, client: ImapFlow, folder: Folder, path: string, state: Record<string, FolderState>, ownAddresses: Set<string>, io: Io) {
  const lock = await client.getMailboxLock(path);
  try {
    const box = client.mailbox;
    if (!box) return;
    const uidValidity = String(box.uidValidity);
    let st = state[folder];
    let range: string;
    let initial = false;
    if (!st || st.uidValidity !== uidValidity) {
      // Primeira vez (ou a pasta foi recriada no servidor): só o recente.
      initial = true;
      if (st) await prisma.emailMessage.deleteMany({ where: { emailAccountId: acc.id, folder, uid: { not: null } } });
      const since = new Date(Date.now() - INITIAL_DAYS * 24 * 60 * 60 * 1000);
      const found = await client.search({ since }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).slice(-INITIAL_LIMIT);
      st = { uidValidity, lastUid: Math.max(0, (box.uidNext || 1) - 1) };
      state[folder] = st;
      if (!uids.length) return;
      range = uids.join(',');
    } else {
      if ((box.uidNext || 0) - 1 <= st.lastUid) return; // nada novo
      range = `${st.lastUid + 1}:*`;
    }

    // Busca os cabeçalhos primeiro e só depois baixa os corpos — o imapflow
    // não deixa rodar outro comando no meio do fetch.
    const fetched: FetchMessageObject[] = [];
    for await (const msg of client.fetch(range, { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, size: true, headers: ['references'] }, { uid: true })) {
      if (!initial && msg.uid <= st.lastUid) continue; // "N:*" devolve o último mesmo sem novos
      fetched.push(msg);
    }
    fetched.sort((a, b) => a.uid - b.uid);
    for (const msg of fetched) {
      // Um e-mail com problema não pode travar a caixa (senão ele seria
      // tentado de novo pra sempre e nada depois dele entraria).
      await storeFetched(acc, client, folder, msg, { initial, ownAddresses, io })
        .catch((err) => console.warn(`[E-mail] ${acc.address} ${folder} uid ${msg.uid} ignorado:`, err?.message));
      if (msg.uid > st.lastUid) st.lastUid = msg.uid;
    }

    // Espelha o que saiu da pasta no servidor (apagado/movido no webmail ou
    // no celular). Se a busca falhar, não mexe em nada — melhor sobrar que sumir.
    const all = await client.search({ all: true }, { uid: true });
    if (Array.isArray(all) && (all.length > 0 || box.exists === 0)) {
      const present = new Set(all);
      const rows = await prisma.emailMessage.findMany({ where: { emailAccountId: acc.id, folder, uid: { not: null } }, select: { id: true, uid: true } });
      const gone = rows.filter((r) => !present.has(r.uid!)).map((r) => r.id);
      if (gone.length) await prisma.emailMessage.deleteMany({ where: { id: { in: gone } } });
    }
  } finally {
    lock.release();
  }
}

export async function syncEmailAccount(acc: EmailAccount, io: Io): Promise<void> {
  const state = { ...((acc.syncState as unknown as Record<string, FolderState>) || {}) };
  const own = await prisma.emailAccount.findMany({ where: { accountId: acc.accountId }, select: { address: true } });
  const ownAddresses = new Set(own.map((o) => o.address.toLowerCase()));
  try {
    await withImap(acc, async (client) => {
      const boxes = await client.list();
      for (const folder of FOLDERS) {
        const path = await folderPath(client, folder, boxes);
        if (path) await syncFolder(acc, client, folder, path, state, ownAddresses, io);
      }
    });
    await prisma.emailAccount.update({ where: { id: acc.id }, data: { syncState: state as unknown as Prisma.InputJsonValue, lastSyncAt: new Date(), lastError: null } });
  } catch (err: any) {
    const msg = String(err?.responseText || err?.message || err).slice(0, 300);
    await prisma.emailAccount.update({ where: { id: acc.id }, data: { syncState: state as unknown as Prisma.InputJsonValue, lastError: msg } }).catch(() => {});
    throw err;
  }
}

let syncRunning = false;
/** Poll de todas as caixas (index.ts, a cada minuto). Nunca sobrepõe rodadas. */
export async function syncAllEmailAccounts(io: Io): Promise<void> {
  if (syncRunning) return;
  syncRunning = true;
  try {
    const accounts = await prisma.account.findMany({ select: { id: true } });
    for (const a of accounts) await ensureCompanyMailbox(a.id);
    const boxes = await prisma.emailAccount.findMany();
    for (const acc of boxes) {
      await syncEmailAccount(acc, io).catch((err) => console.warn(`[E-mail] Sync ${acc.address}:`, err?.responseText || err?.message));
    }
    if (boxes.length && io) {
      for (const a of accounts) io.to(`account_${a.id}`).emit('email_synced', {});
    }
  } finally {
    syncRunning = false;
  }
}

// ─── Leitura / envio ─────────────────────────────────────────────────────────

export async function listEmailMessages(emailAccountId: string, folder: Folder, opts: { q?: string; before?: string; take?: number }) {
  const q = opts.q?.trim();
  return prisma.emailMessage.findMany({
    where: {
      emailAccountId, folder,
      ...(opts.before ? { date: { lt: new Date(opts.before) } } : {}),
      ...(q ? { OR: [
        { subject: { contains: q, mode: 'insensitive' } },
        { fromAddress: { contains: q, mode: 'insensitive' } },
        { fromName: { contains: q, mode: 'insensitive' } },
        { snippet: { contains: q, mode: 'insensitive' } },
      ] } : {}),
    },
    orderBy: { date: 'desc' },
    take: Math.min(opts.take || 50, 100),
    select: {
      id: true, folder: true, fromName: true, fromAddress: true, toList: true, subject: true, date: true,
      snippet: true, seen: true, attachments: true, leadId: true, lead: { select: { id: true, name: true } },
    },
  });
}

/** Abre o e-mail: devolve o corpo e marca como lido (no CRM e no servidor). */
export async function openEmailMessage(acc: EmailAccount, id: string) {
  const msg = await prisma.emailMessage.findFirst({ where: { id, emailAccountId: acc.id }, include: { lead: { select: { id: true, name: true } } } });
  if (!msg) return null;
  if (!msg.seen) {
    await prisma.emailMessage.update({ where: { id }, data: { seen: true } });
    if (msg.uid) {
      withImap(acc, async (client) => {
        const path = await folderPath(client, msg.folder as Folder);
        if (!path) return;
        const lock = await client.getMailboxLock(path);
        try { await client.messageFlagsAdd(String(msg.uid), ['\\Seen'], { uid: true }); } finally { lock.release(); }
      }).catch((err) => console.warn('[E-mail] Marcar lido no servidor:', err?.message));
    }
  }
  return { ...msg, seen: true };
}

/** Baixa um anexo direto do IMAP e entrega em stream (sem gravar em disco). */
export async function streamAttachment(acc: EmailAccount, msg: EmailMessage, part: string, onStream: (meta: { filename?: string; contentType?: string }, content: Readable) => Promise<void>) {
  if (!msg.uid) throw new Error('Esse e-mail ainda não sincronizou com o servidor — tente em 1 minuto');
  await withImap(acc, async (client) => {
    const path = await folderPath(client, msg.folder as Folder);
    if (!path) throw new Error('Pasta não encontrada no servidor');
    const lock = await client.getMailboxLock(path);
    try {
      const { meta, content } = await client.download(String(msg.uid), part, { uid: true });
      await onStream({ filename: meta.filename, contentType: meta.contentType }, content);
    } finally {
      lock.release();
    }
  });
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Envia pela caixa escolhida. Resposta (replyToId) mantém a conversa no
 *  mesmo fio (In-Reply-To/References) e herda o card do e-mail original. */
export async function sendEmailFrom(params: {
  acc: EmailAccount; userId: string | null; to: string[]; cc?: string[]; subject: string; body: string;
  replyToId?: string | null; leadId?: string | null; io: Io;
  /** Enviando um rascunho: ele sai da pasta Rascunhos depois do envio. */
  draftId?: string | null;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}) {
  const { acc, io } = params;
  const files = (params.attachments || []).filter((f) => f.content?.length);
  if (files.length > MAX_ATTACHMENTS) throw new Error(`No máximo ${MAX_ATTACHMENTS} anexos por e-mail`);
  const totalBytes = files.reduce((sum, f) => sum + f.content.length, 0);
  if (totalBytes > MAX_ATTACHMENT_BYTES) throw new Error(`Os anexos passam de ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MB — mande em mais de um e-mail ou use um link do Drive`);
  const to = params.to.map((a) => a.trim().toLowerCase()).filter(Boolean);
  const cc = (params.cc || []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  if (!to.length) throw new Error('Informe pelo menos um destinatário');
  const bad = [...to, ...cc].find((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a));
  if (bad) throw new Error(`E-mail inválido: ${bad}`);
  const subject = params.subject.trim() || '(sem assunto)';
  const body = params.body.replace(/\r/g, '');
  if (!body.trim()) throw new Error('Escreva a mensagem');

  const user = params.userId ? await prisma.user.findUnique({ where: { id: params.userId }, select: { name: true } }) : null;
  const parent = params.replyToId ? await prisma.emailMessage.findFirst({ where: { id: params.replyToId, emailAccountId: acc.id } }) : null;

  const domain = acc.address.split('@')[1] || 'af-crm.local';
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const paragraphs = body.split('\n').map((line) => line.trim() ? `<p style="margin:0 0 12px">${escapeHtml(line)}</p>` : '<br>').join('');
  const signature = acc.signature?.trim()
    ? signatureHtml(acc.signature)
    : acc.userId ? signatureHtml(defaultSignature(acc, user?.name)) : companySignatureHtml();
  // Resposta: cita o e-mail original embaixo, como qualquer cliente de e-mail.
  const parentText = parent ? (parent.textBody || (parent.htmlBody ? htmlToText(parent.htmlBody) : '')).slice(0, 5000) : '';
  const quoteHeader = parent ? `Em ${parent.date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}, ${parent.fromName || parent.fromAddress || ''} escreveu:` : '';
  const quoteHtml = parentText
    ? `<p style="margin:24px 0 6px;font-size:12px;color:#64748b">${escapeHtml(quoteHeader)}</p><blockquote style="margin:0;padding-left:12px;border-left:3px solid #cbd5e1;color:#64748b;white-space:pre-wrap">${escapeHtml(parentText)}</blockquote>`
    : '';
  const quoteText = parentText ? `\n\n${quoteHeader}\n${parentText.split('\n').map((l) => `> ${l}`).join('\n')}` : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1e293b">${paragraphs}${signature}${quoteHtml}</div>`;
  const fromName = acc.userId ? (user?.name || acc.displayName || '') : 'A&F Soluções Financeiras';

  const mail = {
    from: fromName ? `"${fromName.replace(/"/g, '')}" <${acc.address}>` : acc.address,
    to, cc: cc.length ? cc : undefined, subject, text: `${body}${quoteText}`, html, messageId,
    attachments: files.length ? files.map((f) => ({ filename: f.filename, content: f.content, contentType: f.contentType || undefined })) : undefined,
    ...(parent?.messageId ? {
      inReplyTo: parent.messageId,
      references: [parent.references, parent.messageId].filter(Boolean).join(' '),
    } : {}),
  };

  const pass = passwordFor(acc);
  if (smtpBlockedHost && acc.smtpHost.toLowerCase() === smtpBlockedHost) {
    throw new Error(`O servidor do CRM está sem saída pro envio de e-mail (${acc.smtpHost}, portas 587/465 bloqueadas pela hospedagem) — o e-mail não foi enviado.`);
  }
  try {
    await smtpTransport({ host: acc.smtpHost, port: acc.smtpPort, user: acc.username, pass }).sendMail(mail);
  } catch (err: any) {
    console.warn(`[E-mail] Envio falhou (${acc.address} via ${acc.smtpHost}:${acc.smtpPort}):`, err?.code, err?.message);
    if (err?.code === 'ETIMEDOUT' || err?.code === 'ECONNECTION' || /timeout/i.test(err?.message || '')) {
      throw new Error(`O servidor do CRM não conseguiu conectar no envio de e-mail (${acc.smtpHost}:${acc.smtpPort}) — a porta de envio pode estar bloqueada pela hospedagem.`);
    }
    throw err;
  }
  if (params.draftId) removeDraft(acc, params.draftId).catch((err) => console.warn('[E-mail] Apagar rascunho enviado:', err?.message));

  // Guarda uma cópia em Enviados no servidor (SMTP não guarda sozinho) —
  // em segundo plano: o e-mail já saiu, isso não pode travar a resposta.
  new MailComposer(mail as any).compile().build().then((raw: Buffer) => withImap(acc, async (client) => {
    const path = await sentPath(client);
    if (path) await client.append(path, raw, ['\\Seen']);
  })).catch((err: any) => console.warn(`[E-mail] Cópia em Enviados (${acc.address}):`, err?.message));

  const explicitLead = params.leadId
    ? await prisma.lead.findFirst({ where: { id: params.leadId, accountId: acc.accountId }, select: { id: true, contactId: true, contact: { select: { email: true } } } })
    : null;
  // Mandou pelo card de um cliente sem e-mail cadastrado: guarda o endereço
  // no contato, senão a resposta dele não teria como voltar pra conversa.
  if (explicitLead?.contactId && !explicitLead.contact?.email?.trim() && to.length === 1) {
    await prisma.contact.update({ where: { id: explicitLead.contactId }, data: { email: to[0] } }).catch(() => {});
  }
  const leadId = explicitLead?.id || parent?.leadId || await findLeadFor(acc.accountId, [...to, ...cc], null, new Set([acc.address]));
  const saved = await prisma.emailMessage.create({
    data: {
      emailAccountId: acc.id, folder: 'SENT', uid: null, messageId, inReplyTo: parent?.messageId || null,
      references: mail.references || null, fromName: fromName || null, fromAddress: acc.address,
      toList: to.map((address) => ({ name: null, address })) as unknown as Prisma.InputJsonValue,
      ccList: cc.map((address) => ({ name: null, address })) as unknown as Prisma.InputJsonValue,
      subject, date: new Date(), snippet: body.replace(/\s+/g, ' ').slice(0, 200), textBody: body, htmlBody: html,
      attachments: files.map((f) => ({ part: null, filename: f.filename, contentType: f.contentType, size: f.content.length })) as unknown as Prisma.InputJsonValue,
      seen: true, leadId,
    },
  });
  if (leadId) {
    const attachedNote = files.length ? `\n\n📎 ${files.map((f) => f.filename).join(', ')}` : '';
    await addToConversation({ accountId: acc.accountId, leadId, direction: 'OUTBOUND', subject, body: `${body}${attachedNote}`, messageId, date: saved.date, sentByUserId: params.userId, notify: true, io });
  }
  return saved;
}

// ─── Vincular a um card ───────────────────────────────────────────────────────

/** Busca de card pra vincular um e-mail (nome, e-mail ou telefone do contato). */
export async function searchLeadsForEmail(accountId: string, scopeDepartmentIds: string[], q: string) {
  const term = q.trim();
  if (term.length < 2) return [];
  const digits = term.replace(/\D/g, '');
  return prisma.lead.findMany({
    where: {
      accountId, isGroup: false,
      ...(scopeDepartmentIds.length ? { pipeline: { OR: [{ departmentId: null }, { departmentId: { in: scopeDepartmentIds } }] } } : {}),
      OR: [
        { name: { contains: term, mode: 'insensitive' } },
        { contact: { email: { contains: term, mode: 'insensitive' } } },
        ...(digits.length >= 4 ? [{ contact: { whatsappPhone: { contains: digits } } }, { contact: { phone: { contains: digits } } }] : []),
      ],
    },
    orderBy: [{ archived: 'asc' }, { updatedAt: 'desc' }],
    take: 20,
    select: {
      id: true, name: true, archived: true,
      contact: { select: { email: true, phone: true, whatsappPhone: true } },
      pipeline: { select: { name: true, department: { select: { name: true } } } },
      stage: { select: { name: true } },
    },
  });
}

function counterpartOf(msg: EmailMessage): string | null {
  if (msg.folder === 'INBOX') return msg.fromAddress?.toLowerCase() || null;
  const to = (msg.toList as unknown as Addr[] | null) || [];
  return to[0]?.address?.toLowerCase() || null;
}

/**
 * Vincula o e-mail (e os outros do mesmo remetente ainda sem card) a um card:
 * eles entram na conversa do card, o endereço vai pro contato se ele não
 * tinha e-mail, e os próximos e-mails desse remetente já caem lá sozinhos.
 * leadId null = desvincular só este e-mail (sai da conversa do card).
 */
export async function linkEmailToLead(acc: EmailAccount, msgId: string, leadId: string | null, io: Io) {
  const msg = await prisma.emailMessage.findFirst({ where: { id: msgId, emailAccountId: acc.id } });
  if (!msg) throw new Error('E-mail não encontrado');

  if (!leadId) {
    if (msg.leadId && msg.messageId) {
      await prisma.message.deleteMany({ where: { leadId: msg.leadId, channel: 'EMAIL', externalId: msg.messageId } });
      io?.to(`account_${acc.accountId}`).emit('new_notification', { leadId: msg.leadId }); // Inbox recarrega a conversa
    }
    await prisma.emailMessage.update({ where: { id: msg.id }, data: { leadId: null } });
    return { linked: 0 };
  }

  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId: acc.accountId }, select: { id: true, name: true, contactId: true, contact: { select: { email: true } } } });
  if (!lead) throw new Error('Card não encontrado');
  const address = counterpartOf(msg);

  const siblings = address
    ? await prisma.emailMessage.findMany({
        where: {
          leadId: null, emailAccount: { accountId: acc.accountId },
          OR: [{ fromAddress: address, folder: 'INBOX' }, { folder: 'SENT', toList: { array_contains: [{ address }] } }],
        },
        orderBy: { date: 'asc' },
      })
    : [];
  const toLink = [msg, ...siblings.filter((m) => m.id !== msg.id)].sort((a, b) => a.date.getTime() - b.date.getTime());

  for (const m of toLink) {
    await prisma.emailMessage.update({ where: { id: m.id }, data: { leadId: lead.id } });
    const plain = m.textBody || (m.htmlBody ? htmlToText(m.htmlBody) : '');
    const files = ((m.attachments as unknown as { filename: string }[] | null) || []).map((a) => a.filename);
    await addToConversation({
      accountId: acc.accountId, leadId: lead.id, direction: m.folder === 'INBOX' ? 'INBOUND' : 'OUTBOUND',
      subject: m.subject, body: `${stripQuoted(plain) || plain}${files.length ? `\n\n📎 ${files.join(', ')}` : ''}`,
      messageId: m.messageId, date: m.date, notify: false, io,
    });
  }

  if (address && lead.contactId && !lead.contact?.email?.trim()) {
    await prisma.contact.update({ where: { id: lead.contactId }, data: { email: address } }).catch(() => {});
  }
  io?.to(`account_${acc.accountId}`).emit('new_notification', { leadId: lead.id }); // Inbox recarrega a conversa
  return { linked: toLink.length, leadName: lead.name };
}

// ─── Follow-up automático por e-mail ──────────────────────────────────────────

const PRODUCT_SUBJECT: Record<string, string> = {
  'home equity': 'Seu crédito com garantia de imóvel',
  'financiamento habitacional': 'Seu financiamento imobiliário',
  'consórcio': 'Seu consórcio',
  'consorcio': 'Seu consórcio',
};

/**
 * Pedido do Fabio (2026-09-25): o follow-up automático do WhatsApp também vai
 * por e-mail quando o cliente tem e-mail no card. Sai pela caixa da empresa
 * (comercial@) — fica em Enviados e na conversa do card, e a resposta do
 * cliente volta pra lá. Texto = o mesmo do template do WhatsApp, sem a
 * formatação do WhatsApp (*negrito*, _itálico_). Nunca lança: é um extra.
 */
export async function sendFollowUpEmail(params: {
  accountId: string; leadId: string; to: string; text: string; subject?: string | null; io: Io;
}): Promise<boolean> {
  try {
    const lead = await prisma.lead.findFirst({
      where: { id: params.leadId, accountId: params.accountId },
      select: { pipeline: { select: { department: { select: { name: true } } } } },
    });
    const dept = (lead?.pipeline?.department?.name || '').toLowerCase();
    const subject = params.subject?.trim() || PRODUCT_SUBJECT[dept] || 'A&F Soluções Financeiras';
    const body = params.text
      .replace(/\*([^*\n]+)\*/g, '$1')
      .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2')
      .replace(/~([^~\n]+)~/g, '$1')
      .trim();
    if (!body) return false;

    await ensureCompanyMailbox(params.accountId);
    const acc = await prisma.emailAccount.findFirst({ where: { accountId: params.accountId, userId: null } });
    if (acc) {
      await sendEmailFrom({ acc, userId: null, to: [params.to], subject, body, leadId: params.leadId, io: params.io });
      return true;
    }
    const { sendOutboundEmail } = require('./message.service') as typeof import('./message.service');
    const r = await sendOutboundEmail({ accountId: params.accountId, leadId: params.leadId, subject, body, io: params.io || undefined });
    return r.success;
  } catch (err: any) {
    console.warn(`[E-mail] Follow-up por e-mail (lead ${params.leadId}) falhou:`, err?.message);
    return false;
  }
}

// ─── Mover / excluir / rascunhos ─────────────────────────────────────────────

/** Move entre pastas no servidor (lixeira, spam, de volta pra Entrada...). */
export async function moveEmail(acc: EmailAccount, msgId: string, target: Folder) {
  const msg = await prisma.emailMessage.findFirst({ where: { id: msgId, emailAccountId: acc.id } });
  if (!msg) throw new Error('E-mail não encontrado');
  if (msg.folder === target) return msg;
  if (!msg.uid) throw new Error('Esse e-mail ainda não sincronizou com o servidor — tente em 1 minuto');
  let newUid: number | null = null;
  await withImap(acc, async (client) => {
    const boxes = await client.list();
    const from = await folderPath(client, msg.folder as Folder, boxes);
    const to = await folderPath(client, target, boxes);
    if (!from || !to) throw new Error('Pasta não encontrada no servidor');
    const lock = await client.getMailboxLock(from);
    try {
      const res = await client.messageMove(String(msg.uid), to, { uid: true });
      if (!res) throw new Error('O servidor não moveu o e-mail');
      newUid = res.uidMap?.get(msg.uid!) ?? null;
    } finally {
      lock.release();
    }
  });
  return prisma.emailMessage.update({ where: { id: msg.id }, data: { folder: target, uid: newUid } });
}

/** Excluir de vez — só da Lixeira, do Spam ou um rascunho. */
export async function deleteEmailForever(acc: EmailAccount, msgId: string) {
  const msg = await prisma.emailMessage.findFirst({ where: { id: msgId, emailAccountId: acc.id } });
  if (!msg) throw new Error('E-mail não encontrado');
  if (!['TRASH', 'SPAM', 'DRAFTS'].includes(msg.folder)) throw new Error('Mande pra Lixeira antes de excluir de vez');
  if (msg.uid) {
    await withImap(acc, async (client) => {
      const path = await folderPath(client, msg.folder as Folder);
      if (!path) return;
      const lock = await client.getMailboxLock(path);
      try { await client.messageDelete(String(msg.uid), { uid: true }); } finally { lock.release(); }
    });
  }
  await prisma.emailMessage.delete({ where: { id: msg.id } });
}

async function removeDraft(acc: EmailAccount, draftId: string) {
  const draft = await prisma.emailMessage.findFirst({ where: { id: draftId, emailAccountId: acc.id, folder: 'DRAFTS' } });
  if (draft) await deleteEmailForever(acc, draft.id);
}

/** Salva (ou atualiza) um rascunho na pasta Rascunhos do servidor — aparece
 *  também no webmail. Atualizar = grava o novo e apaga o anterior. */
export async function saveDraft(params: {
  acc: EmailAccount; to: string[]; cc?: string[]; subject: string; body: string; draftId?: string | null; replyToId?: string | null;
}) {
  const { acc } = params;
  const to = params.to.map((a) => a.trim().toLowerCase()).filter(Boolean);
  const cc = (params.cc || []).map((a) => a.trim().toLowerCase()).filter(Boolean);
  const body = params.body.replace(/\r/g, '');
  const subject = params.subject.trim();
  if (!to.length && !subject && !body.trim()) throw new Error('Rascunho vazio');
  const domain = acc.address.split('@')[1] || 'af-crm.local';
  const messageId = `<${crypto.randomUUID()}@${domain}>`;
  const parent = params.replyToId ? await prisma.emailMessage.findFirst({ where: { id: params.replyToId, emailAccountId: acc.id } }) : null;
  const mail = {
    from: acc.address, to: to.length ? to : undefined, cc: cc.length ? cc : undefined, subject, text: body, messageId,
    ...(parent?.messageId ? { inReplyTo: parent.messageId, references: [parent.references, parent.messageId].filter(Boolean).join(' ') } : {}),
  };
  const raw: Buffer = await new MailComposer(mail as any).compile().build();
  let uid: number | null = null;
  await withImap(acc, async (client) => {
    const path = await folderPath(client, 'DRAFTS');
    if (!path) throw new Error('A caixa não tem pasta de Rascunhos no servidor');
    const res = await client.append(path, raw, ['\\Draft', '\\Seen']);
    uid = res ? res.uid ?? null : null;
  });
  const saved = await prisma.emailMessage.create({
    data: {
      emailAccountId: acc.id, folder: 'DRAFTS', uid, messageId, inReplyTo: parent?.messageId || null,
      references: (mail as any).references || null, fromName: null, fromAddress: acc.address,
      toList: to.map((address) => ({ name: null, address })) as unknown as Prisma.InputJsonValue,
      ccList: cc.map((address) => ({ name: null, address })) as unknown as Prisma.InputJsonValue,
      subject: subject || null, date: new Date(), snippet: body.replace(/\s+/g, ' ').slice(0, 200) || null,
      textBody: body, htmlBody: null, attachments: [] as unknown as Prisma.InputJsonValue, seen: true,
    },
  });
  if (params.draftId) await removeDraft(acc, params.draftId).catch((err) => console.warn('[E-mail] Apagar rascunho anterior:', err?.message));
  return saved;
}

// ─── Diagnóstico de rede (hospedagem) ─────────────────────────────────────────


/** Testa, de dentro do servidor, se as portas de e-mail saem pra internet —
 *  hospedagens bloqueiam SMTP (587/465) em alguns planos. Só loga. */
export async function probeMailEgress(): Promise<Record<string, string>> {
  const host = process.env.SMTP_HOST || 'smtp.titan.email';
  const imap = process.env.IMAP_HOST || host.replace(/^smtp\./i, 'imap.');
  const targets: [string, number][] = [[host, 587], [host, 465], [imap, 993]];
  const out: Record<string, string> = {};
  await Promise.all(targets.map(([h, port]) => new Promise<void>((resolve) => {
    const sock = net.connect({ host: h, port, timeout: 8000 });
    const done = (r: string) => { out[`${h}:${port}`] = r; sock.destroy(); resolve(); };
    sock.on('connect', () => done('abre'));
    sock.on('timeout', () => done('TIMEOUT (bloqueada?)'));
    sock.on('error', (e: any) => done(`erro ${e?.code || e?.message}`));
  })));
  console.log('[E-mail] Portas de e-mail saindo do servidor:', JSON.stringify(out));
  smtpBlockedHost = out[`${host}:587`] !== 'abre' && out[`${host}:465`] !== 'abre' ? host.toLowerCase() : null;
  return out;
}

/** Host SMTP cujas portas de envio o último teste achou fechadas (null = ok).
 *  Com isso o envio falha na hora, em vez de esperar ~45s de timeout — o
 *  follow-up automático não fica travado esperando. */
let smtpBlockedHost: string | null = null;
