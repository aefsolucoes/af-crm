import * as QRCode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

type ConnectionStatus = 'disconnected' | 'connecting' | 'qr_ready' | 'connected';

interface ConnectionState {
  sock: any;
  qr: string | null;
  status: ConnectionStatus;
}

const connections = new Map<string, ConnectionState>();
let globalIO: any = null;

export function setBaileysIO(io: any) {
  globalIO = io;
}

export function getQRStatus(accountId: string) {
  const conn = connections.get(accountId);
  return {
    status: (conn?.status || 'disconnected') as ConnectionStatus,
    qr: conn?.qr || null,
  };
}

export async function startQRConnection(accountId: string): Promise<void> {
  const existing = connections.get(accountId);
  if (existing?.status === 'connected' || existing?.status === 'connecting') return;

  connections.set(accountId, { sock: null, qr: null, status: 'connecting' });

  try {
    const {
      default: makeWASocket,
      DisconnectReason,
      useMultiFileAuthState,
      fetchLatestBaileysVersion,
    } = await import('@whiskeysockets/baileys') as any;

    const { default: pino } = await import('pino') as any;
    const { Boom } = await import('@hapi/boom') as any;

    const authDir = path.join(process.cwd(), '.baileys_auth', accountId);
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: ['AF CRM', 'Chrome', '120.0.0'],
      markOnlineOnConnect: false,
    });

    const conn = connections.get(accountId)!;
    conn.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      const c = connections.get(accountId);
      if (!c) return;

      if (qr) {
        const qrDataURL = await QRCode.toDataURL(qr);
        c.qr = qrDataURL;
        c.status = 'qr_ready';
        globalIO?.emit(`whatsapp_qr_${accountId}`, { qr: qrDataURL });
      }

      if (connection === 'close') {
        c.status = 'disconnected';
        c.qr = null;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        globalIO?.emit(`whatsapp_status_${accountId}`, { status: 'disconnected' });
        if (!loggedOut) {
          setTimeout(() => startQRConnection(accountId), 5000);
        } else {
          connections.delete(accountId);
          // Clean auth files on logout
          fs.rmSync(authDir, { recursive: true, force: true });
        }
      }

      if (connection === 'open') {
        c.status = 'connected';
        c.qr = null;
        globalIO?.emit(`whatsapp_status_${accountId}`, { status: 'connected' });
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        await processIncomingMessage(msg, accountId);
      }
    });

  } catch (err) {
    console.error('[Baileys] Error starting connection:', err);
    connections.delete(accountId);
  }
}

async function processIncomingMessage(msg: any, accountId: string) {
  try {
    const from = (msg.key.remoteJid as string)?.replace('@s.whatsapp.net', '') || '';
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      '';
    if (!text || !from) return;

    let contact = await prisma.contact.findFirst({
      where: {
        accountId,
        OR: [
          { whatsappPhone: from },
          { phone: { contains: from.slice(-8) } },
        ],
      },
      include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
    });

    if (!contact) {
      const name = msg.pushName || `+${from}`;
      contact = await prisma.contact.create({
        data: { name, whatsappPhone: from, phone: `+${from}`, accountId },
        include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
      });
    }

    let leadId: string;
    if ((contact as any).leads?.length > 0) {
      leadId = (contact as any).leads[0].id;
    } else {
      const pipeline = await prisma.pipeline.findFirst({
        where: { accountId },
        include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
      });
      const admin = await prisma.user.findFirst({ where: { accountId } });
      if (!pipeline?.stages.length || !admin) return;

      const lead = await prisma.lead.create({
        data: {
          name: contact.name,
          accountId,
          pipelineId: pipeline.id,
          stageId: pipeline.stages[0].id,
          userId: admin.id,
          contactId: contact.id,
          status: 'OPEN',
        },
      });
      leadId = lead.id;
    }

    const dup = await prisma.message.findFirst({ where: { externalId: msg.key.id } });
    if (dup) return;

    const message = await prisma.message.create({
      data: {
        content: text,
        direction: 'INBOUND',
        channel: 'WHATSAPP',
        leadId,
        read: false,
        externalId: msg.key.id,
        status: 'DELIVERED',
      },
    });

    globalIO?.to(`lead:${leadId}`).emit('new_message', message);
    globalIO?.emit('new_conversation', { leadId });
  } catch (err) {
    console.error('[Baileys] Error processing message:', err);
  }
}

export async function sendBaileysMessage(to: string, text: string, accountId: string): Promise<boolean> {
  const conn = connections.get(accountId);
  if (!conn?.sock || conn.status !== 'connected') return false;
  try {
    const phone = to.replace(/\D/g, '');
    await conn.sock.sendMessage(`${phone}@s.whatsapp.net`, { text });
    return true;
  } catch (err) {
    console.error('[Baileys] Send error:', err);
    return false;
  }
}

export async function disconnectQR(accountId: string) {
  const conn = connections.get(accountId);
  if (conn?.sock) {
    try { await conn.sock.logout(); } catch { /* ignore */ }
    connections.delete(accountId);
  }
}
