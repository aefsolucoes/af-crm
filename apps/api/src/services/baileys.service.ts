import * as QRCode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type ConnectionStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

interface ConnectionState {
  sock: any;
  qr: string | null;
  status: ConnectionStatus;
  accountId: string;
}

// Conexões keyed por numberId (WhatsAppNumber.id) — multi-sessão por conta
const connections = new Map<string, ConnectionState>();
let globalIO: any = null;

export function setBaileysIO(io: any) {
  globalIO = io;
}

export function getQRStatus(numberId: string) {
  const conn = connections.get(numberId);
  return {
    status: (conn?.status || 'disconnected') as ConnectionStatus,
    qr: conn?.qr || null,
  };
}

/** true se um número específico está conectado */
export function isNumberConnected(numberId: string): boolean {
  return connections.get(numberId)?.status === 'connected';
}

/** Retorna os numberIds conectados de uma conta */
export function getConnectedNumberIds(accountId: string): string[] {
  const ids: string[] = [];
  for (const [numberId, conn] of connections.entries()) {
    if (conn.accountId === accountId && conn.status === 'connected') ids.push(numberId);
  }
  return ids;
}

function getAuthDir(numberId: string): string {
  const dir = path.join(os.tmpdir(), 'af_baileys', numberId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Restaura os arquivos de sessão do Postgres (WhatsAppNumber.session) para o filesystem
async function restoreSessionFiles(numberId: string): Promise<string> {
  const dir = getAuthDir(numberId);
  const row = await prisma.whatsAppNumber.findUnique({ where: { id: numberId } });
  const data = row?.session;
  if (data && typeof data === 'object') {
    const files = data as Record<string, string>;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      if (typeof content === 'string') {
        fs.writeFileSync(path.join(dir, name), content, 'utf-8');
      }
    }
    console.log(`[Baileys] Sessão ${numberId} restaurada (${Object.keys(files).length} arquivos)`);
  } else {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[Baileys] Nenhuma sessão salva para ${numberId} — diretório limpo`);
  }
  return dir;
}

// Salva os arquivos de sessão do filesystem no Postgres (WhatsAppNumber.session)
async function saveSessionFiles(numberId: string, authDir: string) {
  try {
    if (!fs.existsSync(authDir)) return;
    const files: Record<string, string> = {};
    for (const file of fs.readdirSync(authDir)) {
      const filePath = path.join(authDir, file);
      if (fs.statSync(filePath).isFile()) {
        files[file] = fs.readFileSync(filePath, 'utf-8');
      }
    }
    await prisma.whatsAppNumber.update({ where: { id: numberId }, data: { session: files as any } });
  } catch (err) {
    console.error('[Baileys] Erro ao salvar sessão:', err);
  }
}

export async function startQRConnection(numberId: string, accountId: string): Promise<void> {
  const existing = connections.get(numberId);
  if (existing?.status === 'connected' || existing?.status === 'connecting') return;

  connections.set(numberId, { sock: null, qr: null, status: 'connecting', accountId });
  globalIO?.emit(`whatsapp_status_${numberId}`, { numberId, status: 'connecting' });

  try {
    const baileys = await import('@whiskeysockets/baileys') as any;
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;

    if (typeof makeWASocket !== 'function') {
      throw new Error(`makeWASocket não é uma função. Keys: ${Object.keys(baileys).join(', ')}`);
    }

    const authDir = await restoreSessionFiles(numberId);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    let version: number[];
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      version = [2, 3000, 1035194821];
    }
    console.log('[Baileys] Usando versão WA:', version);

    const silentLogger = {
      level: 'silent',
      trace: () => {}, debug: () => {}, info: () => {},
      warn: () => {}, error: () => {}, fatal: () => {},
      child: () => silentLogger,
    };

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: silentLogger,
      browser: Browsers?.macOS('Safari') ?? ['AF CRM', 'Safari', '17.0'],
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 10_000,
      retryRequestDelayMs: 2000,
      qrTimeout: 60_000,
    });

    const conn = connections.get(numberId)!;
    conn.sock = sock;

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      await saveSessionFiles(numberId, authDir);
    });

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      const c = connections.get(numberId);
      if (!c) return;

      if (qr) {
        try {
          const qrDataURL = await QRCode.toDataURL(qr);
          c.qr = qrDataURL;
          c.status = 'qr_ready';
          globalIO?.emit(`whatsapp_qr_${numberId}`, { numberId, qr: qrDataURL });
          console.log(`[Baileys] QR Code gerado para ${numberId}`);
        } catch (err) {
          console.error('[Baileys] Erro ao gerar QR:', err);
        }
      }

      if (connection === 'close') {
        c.qr = null;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        const authFailed = loggedOut || statusCode === 401 || statusCode === 403;
        const restartRequired = statusCode === 515 || statusCode === DisconnectReason.restartRequired;
        console.log(`[Baileys] ${numberId} fechada. statusCode=${statusCode} loggedOut=${loggedOut} restartRequired=${restartRequired}`);

        if (authFailed) {
          c.status = 'disconnected';
          globalIO?.emit(`whatsapp_status_${numberId}`, { numberId, status: 'disconnected' });
          connections.delete(numberId);
          await prisma.whatsAppNumber.update({ where: { id: numberId }, data: { session: undefined as any } }).catch(() => {});
          fs.rmSync(authDir, { recursive: true, force: true });
          console.log('[Baileys] Sessão inválida removida.');
        } else if (restartRequired) {
          c.status = 'connecting';
          globalIO?.emit(`whatsapp_status_${numberId}`, { numberId, status: 'connecting' });
          await saveSessionFiles(numberId, authDir);
          connections.delete(numberId);
          console.log('[Baileys] Pareamento concluído — reconectando...');
          setTimeout(() => startQRConnection(numberId, accountId), 1000);
        } else {
          c.status = 'connecting';
          globalIO?.emit(`whatsapp_status_${numberId}`, { numberId, status: 'connecting' });
          connections.delete(numberId);
          console.log('[Baileys] Reconectando em 5s...');
          setTimeout(() => startQRConnection(numberId, accountId), 5000);
        }
      }

      if (connection === 'open') {
        c.status = 'connected';
        c.qr = null;
        await saveSessionFiles(numberId, authDir);
        // Captura o número real conectado (ex: 5561999999999)
        const rawJid = (sock.user?.id as string | undefined) || '';
        const phone = rawJid.split(':')[0].split('@')[0] || null;
        if (phone) {
          await prisma.whatsAppNumber.update({ where: { id: numberId }, data: { phone } }).catch(() => {});
        }
        globalIO?.emit(`whatsapp_status_${numberId}`, { numberId, status: 'connected', phone });
        console.log(`[Baileys] ${numberId} conectado! phone=${phone}`);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        // Documento/imagem → captura o arquivo; senão trata como texto
        if (hasMedia(msg)) {
          await processIncomingMedia(msg, accountId, numberId, sock).catch(err =>
            console.error('[Baileys] Erro ao capturar mídia:', err));
        } else {
          await processIncomingMessage(msg, accountId, numberId);
        }
      }
    });

    sock.ev.on('messaging-history.set', async ({ messages }: any) => {
      if (!Array.isArray(messages) || messages.length === 0) return;
      console.log(`[Baileys] Histórico recebido (${numberId}): ${messages.length} mensagens`);
      importHistoryMessages(messages, accountId, numberId).catch(err =>
        console.error('[Baileys] Erro ao importar histórico:', err));
    });

  } catch (err) {
    console.error('[Baileys] Erro ao iniciar:', err);
    connections.delete(numberId);
    globalIO?.emit(`whatsapp_status_${numberId}`, { numberId, status: 'disconnected' });
    throw err;
  }
}

/**
 * Normaliza um destino para um JID válido do WhatsApp.
 * - Já é um JID (@s.whatsapp.net, @lid, @g.us): usa como está.
 * - É um número de telefone puro: vira <numero>@s.whatsapp.net.
 */
function toWhatsAppJid(to: string): string {
  const t = (to || '').trim();
  if (t.includes('@')) return t;               // @lid, @g.us ou @s.whatsapp.net
  const digits = t.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

/** Extrai o texto de uma mensagem do WhatsApp (só mensagens de texto/legenda) */
function extractText(msg: any): string {
  return msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption || '';
}

/**
 * Encontra/cria contato+lead para um número de WhatsApp; retorna o leadId.
 * Vincula a conversa ao número (whatsappNumberId) que recebeu a mensagem,
 * para que as respostas saiam sempre pelo mesmo número.
 */
async function getOrCreateLeadForPhone(from: string, pushName: string | undefined, accountId: string, numberId: string): Promise<string | null> {
  let contact = await prisma.contact.findFirst({
    where: { accountId, OR: [{ whatsappPhone: from }, { phone: { contains: from.slice(-8) } }] },
    include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
  });

  if (!contact) {
    contact = await prisma.contact.create({
      data: { name: pushName || `+${from}`, whatsappPhone: from, phone: `+${from}`, accountId },
      include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
    });
  } else if (!contact.whatsappPhone) {
    await prisma.contact.update({ where: { id: contact.id }, data: { whatsappPhone: from } });
  }

  const leads = (contact as any).leads || [];
  if (leads.length > 0) {
    const lead = leads[0];
    // Garante que a conversa aponte para o número que recebeu (se ainda não tiver)
    if (!lead.whatsappNumberId) {
      await prisma.lead.update({ where: { id: lead.id }, data: { whatsappNumberId: numberId } }).catch(() => {});
    }
    return lead.id;
  }

  const pipeline = await prisma.pipeline.findFirst({
    where: { accountId },
    include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
  });
  const admin = await prisma.user.findFirst({ where: { accountId } });
  if (!pipeline?.stages.length || !admin) return null;

  const d = from.startsWith('55') ? from.slice(2) : from;
  const telDisplay = d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
    : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
    : `+${from}`;

  const lead = await prisma.lead.create({
    data: {
      name: contact.name,
      accountId,
      pipelineId: pipeline.id,
      stageId: pipeline.stages[0].id,
      userId: admin.id,
      contactId: contact.id,
      status: 'OPEN',
      whatsappNumberId: numberId,
      customFields: { participante_1: contact.name, telefone_1: telDisplay } as any,
    },
  });
  return lead.id;
}

async function processIncomingMessage(msg: any, accountId: string, numberId: string) {
  try {
    const from = (msg.key.remoteJid as string)?.replace('@s.whatsapp.net', '') || '';
    const text = extractText(msg);
    if (!text || !from) return;

    const leadId = await getOrCreateLeadForPhone(from, msg.pushName, accountId, numberId);
    if (!leadId) return;

    const dup = await prisma.message.findFirst({ where: { externalId: msg.key.id } });
    if (dup) return;

    const message = await prisma.message.create({
      data: { content: text, direction: 'INBOUND', channel: 'WHATSAPP', leadId, whatsappNumberId: numberId, read: false, externalId: msg.key.id, status: 'DELIVERED' },
    });

    globalIO?.to(`lead:${leadId}`).emit('new_message', message);
    globalIO?.emit('new_conversation', { leadId });
  } catch (err) {
    console.error('[Baileys] Erro ao processar mensagem:', err);
  }
}

/** true se a mensagem contém um documento ou imagem */
function hasMedia(msg: any): boolean {
  const m = msg.message || {};
  return !!(m.documentMessage || m.imageMessage
    || m.documentWithCaptionMessage?.message?.documentMessage);
}

/** Extrai os metadados e o node de mídia (documento ou imagem) */
function getMediaInfo(msg: any): { node: any; type: 'document' | 'image'; fileName: string; mimeType: string } | null {
  const m = msg.message || {};
  const doc = m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage;
  if (doc) {
    const mimeType = doc.mimetype || 'application/octet-stream';
    const fileName = doc.fileName || `documento-${Date.now()}`;
    return { node: doc, type: 'document', fileName, mimeType };
  }
  if (m.imageMessage) {
    const mimeType = m.imageMessage.mimetype || 'image/jpeg';
    const ext = mimeType.includes('png') ? 'png' : 'jpg';
    return { node: m.imageMessage, type: 'image', fileName: `foto-${Date.now()}.${ext}`, mimeType };
  }
  return null;
}

async function processIncomingMedia(msg: any, accountId: string, numberId: string, sock: any) {
  const from = (msg.key.remoteJid as string)?.replace('@s.whatsapp.net', '') || '';
  if (!from) return;

  const info = getMediaInfo(msg);
  if (!info) return;

  const dup = await prisma.message.findFirst({ where: { externalId: msg.key.id } });
  if (dup) return;

  const leadId = await getOrCreateLeadForPhone(from, msg.pushName, accountId, numberId);
  if (!leadId) return;

  // Baixa o arquivo
  const baileys = await import('@whiskeysockets/baileys') as any;
  const buffer: Buffer = await baileys.downloadMediaMessage(
    msg, 'buffer', {},
    { reuploadRequest: sock.updateMediaMessage },
  );

  const caption = extractText(msg); // legenda, se houver
  const content = `📎 ${info.fileName}${caption ? ` — ${caption}` : ''}`;

  const message = await prisma.message.create({
    data: {
      content, direction: 'INBOUND', channel: 'WHATSAPP', leadId,
      whatsappNumberId: numberId, read: false, externalId: msg.key.id, status: 'DELIVERED',
      attachments: {
        create: { leadId, fileName: info.fileName, mimeType: info.mimeType, data: buffer },
      },
    },
  });

  globalIO?.to(`lead:${leadId}`).emit('new_message', message);
  globalIO?.emit('new_conversation', { leadId });
  console.log(`[Baileys] Documento capturado: ${info.fileName} (${buffer.length} bytes) → lead ${leadId}`);
}

const HISTORY_IMPORT_LIMIT = 500;

async function importHistoryMessages(messages: any[], accountId: string, numberId: string) {
  const sorted = [...messages]
    .filter(m => {
      const jid = m?.key?.remoteJid as string | undefined;
      return jid && jid.endsWith('@s.whatsapp.net') && extractText(m);
    })
    .sort((a, b) => Number(b.messageTimestamp || 0) - Number(a.messageTimestamp || 0))
    .slice(0, HISTORY_IMPORT_LIMIT);

  let imported = 0;
  const leadIds = new Set<string>();

  for (const msg of sorted) {
    try {
      const from = (msg.key.remoteJid as string).replace('@s.whatsapp.net', '');
      const text = extractText(msg);
      const externalId = msg.key.id as string | undefined;
      if (!externalId) continue;

      const dup = await prisma.message.findFirst({ where: { externalId } });
      if (dup) continue;

      const leadId = await getOrCreateLeadForPhone(from, msg.key.fromMe ? undefined : msg.pushName, accountId, numberId);
      if (!leadId) continue;

      const ts = Number(msg.messageTimestamp || 0);
      await prisma.message.create({
        data: {
          content: text,
          direction: msg.key.fromMe ? 'OUTBOUND' : 'INBOUND',
          channel: 'WHATSAPP',
          leadId,
          whatsappNumberId: numberId,
          read: true,
          externalId,
          status: 'DELIVERED',
          ...(ts > 0 ? { createdAt: new Date(ts * 1000) } : {}),
        },
      });
      leadIds.add(leadId);
      imported++;
    } catch (err) {
      console.error('[Baileys] Erro ao importar mensagem do histórico:', err);
    }
  }

  console.log(`[Baileys] Histórico importado: ${imported} mensagens em ${leadIds.size} conversas`);
  if (imported > 0) globalIO?.emit('new_conversation', {});
}

/** Envia por um número específico (numberId). Retorna false se esse número não estiver conectado. */
export async function sendBaileysMessage(to: string, text: string, numberId: string): Promise<boolean> {
  const conn = connections.get(numberId);
  if (!conn?.sock || conn.status !== 'connected') return false;
  try {
    // Se já vier um JID completo (@lid, @g.us, @s.whatsapp.net), respeita-o.
    // O WhatsApp passou a entregar mensagens com endereçamento @lid; nesses
    // casos precisamos responder para o mesmo JID, não reconstruir como telefone.
    const jid = toWhatsAppJid(to);
    await conn.sock.sendMessage(jid, { text });
    return true;
  } catch (err) {
    console.error('[Baileys] Erro ao enviar:', err);
    return false;
  }
}

export async function disconnectQR(numberId: string) {
  const conn = connections.get(numberId);
  if (conn?.sock) {
    try { await conn.sock.logout(); } catch { /* ignore */ }
  }
  connections.delete(numberId);
  await prisma.whatsAppNumber.update({ where: { id: numberId }, data: { session: undefined as any, phone: null } }).catch(() => {});
  const authDir = getAuthDir(numberId);
  fs.rmSync(authDir, { recursive: true, force: true });
  console.log(`[Baileys] Sessão ${numberId} limpa (DB + filesystem)`);
}

export async function restoreActiveSessions() {
  // Migração preguiçosa: converte a sessão legada (BaileysSession, 1 por conta)
  // em um WhatsAppNumber "WhatsApp Principal", preservando a conexão existente.
  try {
    const legacy = await prisma.baileysSession.findMany();
    for (const s of legacy) {
      const hasNumber = await prisma.whatsAppNumber.findFirst({ where: { accountId: s.accountId } });
      if (!hasNumber) {
        await prisma.whatsAppNumber.create({
          data: { accountId: s.accountId, label: 'WhatsApp Principal', session: s.data as any },
        });
        console.log(`[Baileys] Migrada sessão legada da conta ${s.accountId} para WhatsAppNumber`);
      }
      // Remove a linha legada para não migrar de novo
      await prisma.baileysSession.delete({ where: { id: s.id } }).catch(() => {});
    }
  } catch (err) {
    console.error('[Baileys] Erro na migração de sessão legada:', err);
  }

  // Reconecta todos os números que têm sessão salva
  const numbers = await prisma.whatsAppNumber.findMany();
  for (const n of numbers) {
    if (!n.session || typeof n.session !== 'object') continue;
    console.log(`[Baileys] Restaurando número ${n.id} (${n.label})`);
    startQRConnection(n.id, n.accountId).catch(console.error);
  }
}
