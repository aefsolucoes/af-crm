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

function getAuthDir(accountId: string): string {
  const dir = path.join(os.tmpdir(), 'af_baileys', accountId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Restore session files from PostgreSQL to temp filesystem
async function restoreSessionFiles(accountId: string): Promise<string> {
  const dir = getAuthDir(accountId);
  const row = await prisma.baileysSession.findUnique({ where: { accountId } });
  if (row?.data && typeof row.data === 'object') {
    const files = row.data as Record<string, string>;
    // Clear dir first to avoid mixing old and new files
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      if (typeof content === 'string') {
        fs.writeFileSync(path.join(dir, name), content, 'utf-8');
      }
    }
    console.log(`[Baileys] Sessão restaurada do DB (${Object.keys(files).length} arquivos)`);
  } else {
    // No DB session — wipe any leftover temp files to force fresh QR
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    console.log('[Baileys] Nenhuma sessão no DB — diretório limpo para QR novo');
  }
  return dir;
}

// Save session files from filesystem to PostgreSQL
async function saveSessionFiles(accountId: string, authDir: string) {
  try {
    if (!fs.existsSync(authDir)) return;
    const files: Record<string, string> = {};
    for (const file of fs.readdirSync(authDir)) {
      const filePath = path.join(authDir, file);
      if (fs.statSync(filePath).isFile()) {
        files[file] = fs.readFileSync(filePath, 'utf-8');
      }
    }
    await prisma.baileysSession.upsert({
      where: { accountId },
      create: { accountId, data: files },
      update: { data: files },
    });
  } catch (err) {
    console.error('[Baileys] Error saving session:', err);
  }
}

export async function startQRConnection(accountId: string): Promise<void> {
  const existing = connections.get(accountId);
  if (existing?.status === 'connected' || existing?.status === 'connecting') return;

  connections.set(accountId, { sock: null, qr: null, status: 'connecting' });
  globalIO?.emit(`whatsapp_status_${accountId}`, { status: 'connecting' });

  try {
    const baileys = await import('@whiskeysockets/baileys') as any;
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    const { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = baileys;

    if (typeof makeWASocket !== 'function') {
      throw new Error(`makeWASocket não é uma função. Keys: ${Object.keys(baileys).join(', ')}`);
    }

    // Restore session from DB to temp filesystem
    const authDir = await restoreSessionFiles(accountId);
    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Busca a versão mais recente do protocolo WA — versões fixas ficam
    // desatualizadas e o servidor passa a rejeitar a conexão com erro 405
    let version: number[];
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {
      version = [2, 3000, 1035194821]; // fallback (última versão conhecida que funcionou)
    }
    console.log('[Baileys] Usando versão WA:', version);

    const silentLogger = {
      level: 'silent',
      trace: () => {}, debug: () => {}, info: () => {},
      warn: () => {}, error: () => {}, fatal: () => {},
      child: () => silentLogger,
    };

    console.log('[Baileys] Criando socket...');
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
    console.log('[Baileys] Socket criado, aguardando eventos...');

    const conn = connections.get(accountId)!;
    conn.sock = sock;

    sock.ev.on('creds.update', async () => {
      await saveCreds();
      await saveSessionFiles(accountId, authDir);
    });

    sock.ev.on('connection.update', async (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      console.log('[Baileys] connection.update:', JSON.stringify({ connection, qr: !!qr, statusCode: (lastDisconnect?.error as any)?.output?.statusCode }));
      const c = connections.get(accountId);
      if (!c) return;

      if (qr) {
        try {
          const qrDataURL = await QRCode.toDataURL(qr);
          c.qr = qrDataURL;
          c.status = 'qr_ready';
          globalIO?.emit(`whatsapp_qr_${accountId}`, { qr: qrDataURL });
          console.log('[Baileys] QR Code gerado!');
        } catch (err) {
          console.error('[Baileys] Erro ao gerar QR:', err);
        }
      }

      if (connection === 'close') {
        c.status = 'disconnected';
        c.qr = null;
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        // Auth failure codes: 401 (Unauthorized), 403 (Forbidden)
        const authFailed = loggedOut || statusCode === 401 || statusCode === 403;
        // 515 (restartRequired) é NORMAL logo após parear o QR: o WhatsApp exige
        // reconectar usando as credenciais recém-salvas — a sessão deve ser mantida
        const restartRequired = statusCode === 515 || statusCode === DisconnectReason.restartRequired;
        globalIO?.emit(`whatsapp_status_${accountId}`, { status: 'disconnected' });
        console.log(`[Baileys] Conexão fechada. statusCode=${statusCode} loggedOut=${loggedOut} restartRequired=${restartRequired}`);

        if (authFailed) {
          // Clear invalid session so next connect generates fresh QR
          connections.delete(accountId);
          await prisma.baileysSession.deleteMany({ where: { accountId } });
          fs.rmSync(authDir, { recursive: true, force: true });
          console.log('[Baileys] Sessão inválida removida.');
        } else if (restartRequired) {
          // Salva a sessão pareada e reconecta imediatamente
          await saveSessionFiles(accountId, authDir);
          connections.delete(accountId);
          console.log('[Baileys] Pareamento concluído — reconectando com a sessão salva...');
          setTimeout(() => startQRConnection(accountId), 1000);
        } else {
          // Transient error — reconnect after delay
          connections.delete(accountId);
          console.log('[Baileys] Reconectando em 5s...');
          setTimeout(() => startQRConnection(accountId), 5000);
        }
      }

      if (connection === 'open') {
        c.status = 'connected';
        c.qr = null;
        await saveSessionFiles(accountId, authDir);
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

    // Histórico enviado pelo WhatsApp no pareamento — importa as conversas recentes
    sock.ev.on('messaging-history.set', async ({ messages }: any) => {
      if (!Array.isArray(messages) || messages.length === 0) return;
      console.log(`[Baileys] Histórico recebido: ${messages.length} mensagens — importando...`);
      importHistoryMessages(messages, accountId).catch(err =>
        console.error('[Baileys] Erro ao importar histórico:', err));
    });

  } catch (err) {
    console.error('[Baileys] Erro ao iniciar:', err);
    connections.delete(accountId);
    globalIO?.emit(`whatsapp_status_${accountId}`, { status: 'disconnected' });
    throw err;
  }
}

/** Extrai o texto de uma mensagem do WhatsApp (só mensagens de texto/legenda) */
function extractText(msg: any): string {
  return msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption || '';
}

/** Encontra/cria contato+lead para um número de WhatsApp; retorna o leadId */
async function getOrCreateLeadForPhone(from: string, pushName: string | undefined, accountId: string): Promise<string | null> {
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
  if (leads.length > 0) return leads[0].id;

  const pipeline = await prisma.pipeline.findFirst({
    where: { accountId },
    include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
  });
  const admin = await prisma.user.findFirst({ where: { accountId } });
  if (!pipeline?.stages.length || !admin) return null;
  const lead = await prisma.lead.create({
    data: { name: contact.name, accountId, pipelineId: pipeline.id, stageId: pipeline.stages[0].id, userId: admin.id, contactId: contact.id, status: 'OPEN' },
  });
  return lead.id;
}

async function processIncomingMessage(msg: any, accountId: string) {
  try {
    const from = (msg.key.remoteJid as string)?.replace('@s.whatsapp.net', '') || '';
    const text = extractText(msg);
    if (!text || !from) return;

    const leadId = await getOrCreateLeadForPhone(from, msg.pushName, accountId);
    if (!leadId) return;

    const dup = await prisma.message.findFirst({ where: { externalId: msg.key.id } });
    if (dup) return;

    const message = await prisma.message.create({
      data: { content: text, direction: 'INBOUND', channel: 'WHATSAPP', leadId, read: false, externalId: msg.key.id, status: 'DELIVERED' },
    });

    globalIO?.to(`lead:${leadId}`).emit('new_message', message);
    globalIO?.emit('new_conversation', { leadId });
  } catch (err) {
    console.error('[Baileys] Erro ao processar mensagem:', err);
  }
}

const HISTORY_IMPORT_LIMIT = 500;

/** Importa mensagens do histórico recebido no pareamento (apenas conversas 1:1 de texto) */
async function importHistoryMessages(messages: any[], accountId: string) {
  // Mais recentes primeiro, limitado para não sobrecarregar
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

      const leadId = await getOrCreateLeadForPhone(from, msg.key.fromMe ? undefined : msg.pushName, accountId);
      if (!leadId) continue;

      const ts = Number(msg.messageTimestamp || 0);
      await prisma.message.create({
        data: {
          content: text,
          direction: msg.key.fromMe ? 'OUTBOUND' : 'INBOUND',
          channel: 'WHATSAPP',
          leadId,
          read: true, // histórico antigo não deve contar como não-lido
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
  }
  connections.delete(accountId);
  await prisma.baileysSession.deleteMany({ where: { accountId } });
  // Also wipe temp filesystem so stale credentials don't prevent QR generation
  const authDir = getAuthDir(accountId);
  fs.rmSync(authDir, { recursive: true, force: true });
  console.log('[Baileys] Sessão limpa (DB + filesystem)');
}

export async function restoreActiveSessions() {
  const sessions = await prisma.baileysSession.findMany();
  for (const session of sessions) {
    console.log(`[Baileys] Restaurando sessão: ${session.accountId}`);
    startQRConnection(session.accountId).catch(console.error);
  }
}
