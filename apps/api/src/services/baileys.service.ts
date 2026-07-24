import * as QRCode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Baileys 7.x é ESM puro. Como este projeto compila para CommonJS, o tsc
// converteria `import()` em `require()` — que quebra com pacotes ESM.
// Este helper preserva um import dinâmico REAL em runtime (o tsc não o reescreve).
const dynamicImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>;
function importBaileys(): Promise<any> {
  return dynamicImport('@whiskeysockets/baileys');
}

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

// IDs de mensagens enviadas PELO CRM — para ignorar o eco fromMe que o
// Baileys reemite em messages.upsert (senão a mensagem apareceria duplicada).
const selfSentIds = new Set<string>();

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

/** Retorna um socket conectado de uma conta (qualquer número), ou null. */
function getAnyConnectedSock(accountId: string): any {
  for (const conn of connections.values()) {
    if (conn.accountId === accountId && conn.status === 'connected' && conn.sock) return conn.sock;
  }
  return null;
}

/**
 * Atualiza o nome dos leads de grupo com o assunto real do grupo.
 * Percorre os contatos com JID @g.us e usa groupMetadata do número conectado.
 */
export async function refreshGroupNames(accountId: string): Promise<{ updated: number; total: number }> {
  const sock = getAnyConnectedSock(accountId);
  if (!sock) throw new Error('Nenhum WhatsApp conectado para consultar os grupos');

  const contacts = await prisma.contact.findMany({
    where: { accountId, whatsappPhone: { endsWith: '@g.us' } },
    include: { leads: true },
  });

  let updated = 0;
  for (const c of contacts) {
    const subject = await getGroupSubject(sock, c.whatsappPhone!);
    if (!subject) continue;
    if (c.name !== subject) {
      await prisma.contact.update({ where: { id: c.id }, data: { name: subject } }).catch(() => {});
    }
    for (const lead of c.leads) {
      const data: any = { isGroup: true };
      if (lead.name !== subject) data.name = subject;
      const cf = (lead.customFields as any) || {};
      if (cf.participante_1 !== subject) data.customFields = { ...cf, participante_1: subject };
      await prisma.lead.update({ where: { id: lead.id }, data }).catch(() => {});
      updated++;
    }
  }
  return { updated, total: contacts.length };
}

/**
 * Backfill em massa: resolve o telefone real dos contatos @lid usando o mapa
 * LID→número do Baileys 7. Preenche contact.phone e lead.customFields.telefone_1.
 */
export async function resolveLidPhones(accountId: string): Promise<{ updated: number; total: number }> {
  const sock = getAnyConnectedSock(accountId);
  if (!sock) throw new Error('Nenhum WhatsApp conectado');

  const contacts = await prisma.contact.findMany({
    where: { accountId, whatsappPhone: { endsWith: '@lid' }, OR: [{ phone: null }, { phone: '' }] },
    include: { leads: true },
  });

  let updated = 0;
  for (const c of contacts) {
    try {
      const pnJid = await sock.signalRepository?.lidMapping?.getPNForLID?.(c.whatsappPhone!);
      if (!pnJid) continue;
      const d = String(pnJid).split('@')[0].split(':')[0].replace(/\D/g, '');
      if (d.length < 8) continue;
      await prisma.contact.update({ where: { id: c.id }, data: { phone: `+${d}` } });
      const tel = formatPhoneDisplay(d);
      for (const lead of c.leads) {
        const cf = (lead.customFields as any) || {};
        if (!cf.telefone_1) {
          await prisma.lead.update({ where: { id: lead.id }, data: { customFields: { ...cf, telefone_1: tel } } }).catch(() => {});
        }
      }
      updated++;
    } catch { /* mapeamento indisponível para este contato */ }
  }
  return { updated, total: contacts.length };
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
    const baileys = await importBaileys();
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
      // 'notify' = mensagem nova recebida; 'append' = mensagem adicionada à
      // conversa (ex.: enviada por você em OUTRO aparelho/celular). Processamos
      // ambos para espelhar a conversa completa. A deduplicação por externalId
      // evita duplicar as que já estão no banco.
      if (type !== 'notify' && type !== 'append') return;
      for (const msg of messages) {
        if (!msg.message) continue;
        // Mensagens do próprio número (fromMe): se saíram do CRM, ignoramos o
        // eco (já estão no banco). Se saíram do celular, entram como OUTBOUND
        // para espelhar a conversa completa.
        if (msg.key.fromMe && selfSentIds.has(msg.key.id)) continue;
        // Documento/imagem → captura o arquivo; senão trata como texto
        if (hasMedia(msg)) {
          await processIncomingMedia(msg, accountId, numberId, sock).catch(err =>
            console.error('[Baileys] Erro ao capturar mídia:', err));
        } else {
          await processIncomingMessage(msg, accountId, numberId, sock);
        }
      }
    });

    // Recibos de entrega/leitura do WhatsApp → atualiza os tiques (1/2/2 azuis)
    sock.ev.on('messages.update', async (updates: any[]) => {
      for (const u of updates) {
        try {
          const waStatus = u.update?.status;
          const id = u.key?.id;
          if (waStatus == null || !id) continue;
          const mapped = mapWaStatus(waStatus);
          if (!mapped) continue;
          const msg = await prisma.message.findFirst({
            where: { externalId: id },
            select: { id: true, leadId: true, status: true },
          });
          if (!msg) continue;
          // só avança (SENT → DELIVERED → READ), nunca regride
          if (statusRank(mapped) <= statusRank(msg.status)) continue;
          await prisma.message.update({ where: { id: msg.id }, data: { status: mapped } });
          globalIO?.to(`lead:${msg.leadId}`).emit('message_status', { id: msg.id, status: mapped });
          globalIO?.to(`account_${accountId}`).emit('message_status', { id: msg.id, status: mapped });
        } catch { /* ignore item */ }
      }
    });

    // Quando o contato compartilha o número real (WhatsApp @lid → telefone),
    // atualiza o contato para exibir/rotear pelo número verdadeiro.
    sock.ev.on('chats.phoneNumberShare', async ({ lid, jid }: { lid?: string; jid?: string }) => {
      try {
        if (!lid || !jid) return;
        await backfillRealPhone(accountId, lid, jid);
      } catch (err) {
        console.error('[Baileys] Erro no phoneNumberShare:', err);
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

/** Mapeia o status numérico do WhatsApp para o nosso enum (tiques). */
function mapWaStatus(waStatus: number | string): 'SENT' | 'DELIVERED' | 'READ' | null {
  const n = typeof waStatus === 'string' ? parseInt(waStatus, 10) : waStatus;
  // Baileys: 2=SERVER_ACK (enviado), 3=DELIVERY_ACK (entregue), 4=READ, 5=PLAYED
  if (n >= 4) return 'READ';
  if (n === 3) return 'DELIVERED';
  if (n === 2) return 'SENT';
  return null;
}

/** Ordem dos status para só avançar (nunca regredir READ→DELIVERED). */
function statusRank(status?: string | null): number {
  switch (status) {
    case 'READ': return 3;
    case 'DELIVERED': return 2;
    case 'SENT': return 1;
    default: return 0;
  }
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
/** Formata um número de telefone brasileiro para exibição; vazio se não for número real. */
function formatPhoneDisplay(realPhone: string | null): string {
  if (!realPhone) return '';
  const d = realPhone.startsWith('55') ? realPhone.slice(2) : realPhone;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `+${realPhone}`;
}

async function getOrCreateLeadForPhone(
  from: string,
  pushName: string | undefined,
  accountId: string,
  numberId: string,
  sock?: any,
): Promise<string | null> {
  const isGroup = from.endsWith('@g.us');
  const isLid = from.endsWith('@lid');
  // Telefone real: direto do @s.whatsapp.net; para @lid, tenta resolver via
  // o mapa LID→número do Baileys 7 (getPNForLID).
  let realPhone = (!isGroup && !isLid) ? from.replace(/\D/g, '') : null;
  if (!realPhone && isLid && sock) {
    try {
      const pnJid = await sock.signalRepository?.lidMapping?.getPNForLID?.(from);
      if (pnJid) {
        const d = String(pnJid).split('@')[0].split(':')[0].replace(/\D/g, '');
        if (d.length >= 8) realPhone = d;
      }
    } catch { /* mapeamento ainda não disponível */ }
  }

  // Matching por telefone só quando temos um número real (evita colidir LID com telefone).
  const orMatch: any[] = [{ whatsappPhone: from }];
  if (realPhone && realPhone.length >= 8) orMatch.push({ phone: { contains: realPhone.slice(-8) } });

  let contact = await prisma.contact.findFirst({
    where: { accountId, OR: orMatch },
    include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
  });

  // Nome de exibição: para grupo, tenta o assunto do grupo; senão o pushName.
  let displayName = pushName || (realPhone ? `+${realPhone}` : from);
  if (isGroup) {
    displayName = await getGroupSubject(sock, from) || pushName || 'Grupo do WhatsApp';
  }

  if (!contact) {
    contact = await prisma.contact.create({
      data: {
        name: displayName,
        whatsappPhone: from,
        phone: realPhone ? `+${realPhone}` : null,
        accountId,
      },
      include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
    });
  } else if (!contact.whatsappPhone) {
    await prisma.contact.update({ where: { id: contact.id }, data: { whatsappPhone: from } });
  }

  // Backfill do telefone real quando acabamos de resolvê-lo (contato/lead antigos
  // criados via @lid ficavam sem número). Mantém o whatsappPhone (@lid) p/ roteamento.
  const telDisplayResolved = formatPhoneDisplay(realPhone);
  if (realPhone && !contact.phone) {
    await prisma.contact.update({ where: { id: contact.id }, data: { phone: `+${realPhone}` } }).catch(() => {});
  }

  const leads = (contact as any).leads || [];
  if (leads.length > 0) {
    const lead = leads[0];
    const data: any = {};
    if (!lead.whatsappNumberId) data.whatsappNumberId = numberId;
    const cf = (lead.customFields as any) || {};
    if (telDisplayResolved && !cf.telefone_1) data.customFields = { ...cf, telefone_1: telDisplayResolved };
    if (Object.keys(data).length) {
      await prisma.lead.update({ where: { id: lead.id }, data }).catch(() => {});
    }
    return lead.id;
  }

  // Novos leads do WhatsApp entram na "Caixa de Entrada" (leads ainda não
  // qualificados). Se esse funil não existir, cai no primeiro funil disponível.
  const pipeline =
    (await prisma.pipeline.findFirst({
      where: { accountId, name: { contains: 'Caixa', mode: 'insensitive' } },
      include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
    })) ||
    (await prisma.pipeline.findFirst({
      where: { accountId },
      include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
    }));
  const admin = await prisma.user.findFirst({ where: { accountId } });
  if (!pipeline?.stages.length || !admin) return null;

  // telefone_1 só é preenchido quando temos número real; grupo/@lid ficam em branco.
  const custom: any = { participante_1: contact.name };
  const telDisplay = formatPhoneDisplay(realPhone);
  if (telDisplay) custom.telefone_1 = telDisplay;

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
      isGroup,
      customFields: custom,
    },
  });
  return lead.id;
}

/**
 * Backfill do telefone real: o WhatsApp entrega mensagens por @lid (sem número).
 * Quando o contato compartilha o número (evento phoneNumberShare), atualizamos o
 * contato que estava salvo com o @lid para passar a usar/exibir o telefone real.
 */
async function backfillRealPhone(accountId: string, lidJid: string, pnJid: string) {
  const realPhone = pnJid.split('@')[0].split(':')[0].replace(/\D/g, '');
  if (!realPhone) return;

  const contact = await prisma.contact.findFirst({
    where: { accountId, whatsappPhone: lidJid },
    include: { leads: { orderBy: { updatedAt: 'desc' } } },
  });
  if (!contact) return;

  await prisma.contact.update({
    where: { id: contact.id },
    data: { whatsappPhone: pnJid, phone: `+${realPhone}` },
  });

  // Preenche o telefone de exibição nos leads desse contato (se ainda vazio)
  const telDisplay = formatPhoneDisplay(realPhone);
  for (const lead of (contact as any).leads || []) {
    const cf = (lead.customFields as any) || {};
    if (!cf.telefone_1) {
      await prisma.lead.update({
        where: { id: lead.id },
        data: { customFields: { ...cf, telefone_1: telDisplay } },
      }).catch(() => {});
    }
  }
  console.log(`[Baileys] Telefone real vinculado: ${lidJid} → ${realPhone}`);
}

/** Busca o assunto (nome) de um grupo do WhatsApp; retorna vazio em caso de erro. */
async function getGroupSubject(sock: any, groupJid: string): Promise<string> {
  if (!sock) return '';
  try {
    const meta = await sock.groupMetadata(groupJid);
    return meta?.subject || '';
  } catch {
    return '';
  }
}

async function processIncomingMessage(msg: any, accountId: string, numberId: string, sock?: any) {
  try {
    const fromMe = !!msg.key.fromMe;
    const from = (msg.key.remoteJid as string)?.replace('@s.whatsapp.net', '') || '';
    const text = extractText(msg);
    if (!text || !from) return;

    // fromMe: remoteJid é o destinatário; não usamos pushName para o nome.
    const leadId = await getOrCreateLeadForPhone(from, fromMe ? undefined : msg.pushName, accountId, numberId, sock);
    if (!leadId) return;

    const dup = await prisma.message.findFirst({ where: { externalId: msg.key.id } });
    if (dup) return;

    const message = await prisma.message.create({
      data: {
        content: text,
        direction: fromMe ? 'OUTBOUND' : 'INBOUND',
        channel: 'WHATSAPP',
        leadId,
        whatsappNumberId: numberId,
        read: fromMe ? true : false,
        externalId: msg.key.id,
        status: fromMe ? 'SENT' : 'DELIVERED',
      },
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
  const fromMe = !!msg.key.fromMe;
  const from = (msg.key.remoteJid as string)?.replace('@s.whatsapp.net', '') || '';
  if (!from) return;

  const info = getMediaInfo(msg);
  if (!info) return;

  const dup = await prisma.message.findFirst({ where: { externalId: msg.key.id } });
  if (dup) return;

  const leadId = await getOrCreateLeadForPhone(from, fromMe ? undefined : msg.pushName, accountId, numberId, sock);
  if (!leadId) return;

  // Tenta baixar o arquivo. Em documentos ENCAMINHADOS do celular, o download
  // pode falhar (chaves de mídia indisponíveis neste aparelho) — nesse caso
  // ainda salvamos a mensagem com o nome do arquivo, só sem os bytes.
  let buffer: Buffer | null = null;
  try {
    const baileys = await importBaileys();
    buffer = await baileys.downloadMediaMessage(
      msg, 'buffer', {},
      { reuploadRequest: sock.updateMediaMessage },
    );
  } catch (err) {
    console.error(`[Baileys] Falha ao baixar mídia (${info.fileName}):`, (err as any)?.message);
  }

  const caption = extractText(msg); // legenda, se houver
  const content = `📎 ${info.fileName}${caption ? ` — ${caption}` : ''}`;

  const message = await prisma.message.create({
    data: {
      content, direction: fromMe ? 'OUTBOUND' : 'INBOUND', channel: 'WHATSAPP', leadId,
      whatsappNumberId: numberId, read: fromMe ? true : false, externalId: msg.key.id,
      status: fromMe ? 'SENT' : 'DELIVERED',
      ...(buffer ? {
        attachments: {
          create: { leadId, fileName: info.fileName, mimeType: info.mimeType, data: buffer },
        },
      } : {}),
    },
  });

  globalIO?.to(`lead:${leadId}`).emit('new_message', message);
  globalIO?.emit('new_conversation', { leadId });
  console.log(`[Baileys] Mídia ${buffer ? 'capturada' : 'registrada (sem bytes)'}: ${info.fileName} → lead ${leadId}`);
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

/**
 * Envia por um número específico (numberId). Retorna o id da mensagem enviada
 * (para deduplicar o eco fromMe), ou null se não estiver conectado / falhar.
 */
export async function sendBaileysMessage(to: string, text: string, numberId: string): Promise<string | null> {
  const conn = connections.get(numberId);
  if (!conn?.sock || conn.status !== 'connected') return null;
  try {
    // Se já vier um JID completo (@lid, @g.us, @s.whatsapp.net), respeita-o.
    // O WhatsApp passou a entregar mensagens com endereçamento @lid; nesses
    // casos precisamos responder para o mesmo JID, não reconstruir como telefone.
    const jid = toWhatsAppJid(to);
    const sent = await conn.sock.sendMessage(jid, { text });
    const id = sent?.key?.id || null;
    if (id) {
      selfSentIds.add(id);
      setTimeout(() => selfSentIds.delete(id), 5 * 60 * 1000);
    }
    return id;
  } catch (err) {
    console.error('[Baileys] Erro ao enviar:', err);
    return null;
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
