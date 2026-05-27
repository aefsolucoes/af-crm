import * as QRCode from 'qrcode';
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

// PostgreSQL-backed auth state for Baileys (persists across restarts)
async function usePrismaAuthState(accountId: string) {
  async function readData() {
    const row = await prisma.baileysSession.findUnique({ where: { accountId } });
    return (row?.data as any) || {};
  }

  async function writeData(data: any) {
    await prisma.baileysSession.upsert({
      where: { accountId },
      create: { accountId, data },
      update: { data },
    });
  }

  const data = await readData();

  const state: any = {
    creds: data.creds || {},
    keys: {
      get: async (type: string, ids: string[]) => {
        const result: any = {};
        for (const id of ids) {
          result[id] = data.keys?.[type]?.[id];
        }
        return result;
      },
      set: async (newData: any) => {
        if (!data.keys) data.keys = {};
        for (const category of Object.keys(newData)) {
          if (!data.keys[category]) data.keys[category] = {};
          Object.assign(data.keys[category], newData[category]);
        }
        await writeData(data);
      },
    },
  };

  const saveCreds = async () => {
    data.creds = state.creds;
    await writeData(data);
  };

  return { state, saveCreds };
}

export async function startQRConnection(accountId: string): Promise<void> {
  const existing = connections.get(accountId);
  if (existing?.status === 'connected' || existing?.status === 'connecting') return;

  connections.set(accountId, { sock: null, qr: null, status: 'connecting' });
  globalIO?.emit(`whatsapp_status_${accountId}`, { status: 'connecting' });

  try {
    const {
      default: makeWASocket,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
      makeInMemoryStore,
    } = await import('@whiskeysockets/baileys') as any;

    const { state, saveCreds } = await usePrismaAuthState(accountId);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore
          ? makeCacheableSignalKeyStore(state.keys, { level: 'silent' } as any)
          : state.keys,
      },
      printQRInTerminal: false,
      logger: { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({ level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({}) }) },
      browser: ['AF CRM', 'Chrome', '120.0.0'],
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
    });

    const conn = connections.get(accountId)!;
    conn.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      const c = connections.get(accountId);
      if (!c) return;

      if (qr) {
        try {
          const qrDataURL = await QRCode.toDataURL(qr);
          c.qr = qrDataURL;
          c.status = 'qr_ready';
          globalIO?.emit(`whatsapp_qr_${accountId}`, { qr: qrDataURL });
        } catch (err) {
          console.error('[Baileys] QR gen error:', err);
        }
      }

      if (connection === 'close') {
        c.status = 'disconnected';
        c.qr = null;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        globalIO?.emit(`whatsapp_status_${accountId}`, { status: 'disconnected' });

        if (!loggedOut) {
          console.log('[Baileys] Reconectando em 5s...');
          setTimeout(() => startQRConnection(accountId), 5000);
        } else {
          connections.delete(accountId);
          await prisma.baileysSession.deleteMany({ where: { accountId } });
        }
      }

      if (connection === 'open') {
        c.status = 'connected';
        c.qr = null;
        globalIO?.emit(`whatsapp_status_${accountId}`, { status: 'connected' });
        console.log('[Baileys] WhatsApp conectado!');
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
    console.error('[Baileys] Erro ao iniciar:', err);
    connections.delete(accountId);
    globalIO?.emit(`whatsapp_status_${accountId}`, { status: 'disconnected' });
    throw err;
  }
}

async function processIncomingMessage(msg: any, accountId: string) {
  try {
    const from = (msg.key.remoteJid as string)?.replace('@s.whatsapp.net', '') || '';
    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.imageMessage?.caption || '';
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
    } else if (!contact.whatsappPhone) {
      await prisma.contact.update({ where: { id: contact.id }, data: { whatsappPhone: from } });
    }

    let leadId: string;
    const leads = (contact as any).leads || [];
    if (leads.length > 0) {
      leadId = leads[0].id;
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
    console.error('[Baileys] Erro ao processar mensagem:', err);
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
    console.error('[Baileys] Erro ao enviar:', err);
    return false;
  }
}

export async function disconnectQR(accountId: string) {
  const conn = connections.get(accountId);
  if (conn?.sock) {
    try { await conn.sock.logout(); } catch { /* ignore */ }
    connections.delete(accountId);
  }
  await prisma.baileysSession.deleteMany({ where: { accountId } });
}

// Restore active sessions on server startup
export async function restoreActiveSessions() {
  const sessions = await prisma.baileysSession.findMany();
  for (const session of sessions) {
    console.log(`[Baileys] Restaurando sessão para conta ${session.accountId}`);
    startQRConnection(session.accountId).catch(console.error);
  }
}
