import * as QRCode from 'qrcode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { PrismaClient } from '@prisma/client';
import { getOrCreateInboxPipeline } from './department.service';
import { generateAiAutoReply } from './ai-auto-reply.service';
import { normalizeClientName } from '../lib/text';
// maybeSalesBotStep/runAutomations/maybeMessageReceivedAutomations: require()
// tardio no ponto de uso (não aqui em cima) — salesbot.service.ts e
// automation.service.ts importam message.service.ts, que importa ESTE
// arquivo; um import estático nos dois sentidos criaria dependência
// circular. Mesmo motivo pelo qual maybeAutoReplyQR/maybeAiAutoReplyQR ficam
// duplicados aqui em vez de compartilhados com whatsapp.service.ts.

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

// Contatos para os quais já desativamos o "modo temporário" (mensagens que
// somem) há pouco — evita reenviar a alteração a cada mensagem. jid → timestamp.
const ephemeralDisabled = new Map<string, number>();

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

/** Confere se um telefone tem WhatsApp de verdade, usando onWhatsApp() de
 *  qualquer número QR conectado da conta (mesma checagem que sendBaileysMessage
 *  já faz antes de enviar). null = indeterminado — sem QR conectado no
 *  momento não dá pra checar (a API Oficial da Meta não expõe essa consulta). */
export async function checkHasWhatsApp(accountId: string, phone: string): Promise<boolean | null> {
  const sock = getAnyConnectedSock(accountId);
  if (!sock) return null;
  try {
    const jid = toWhatsAppJid(phone.replace(/\D/g, ''));
    const [hit] = (await sock.onWhatsApp(jid)) || [];
    return !!hit?.exists;
  } catch (err) {
    console.error('[Baileys] checkHasWhatsApp falhou:', err);
    return null;
  }
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

/** Integrantes de um grupo (para o painel da Inbox). Resolve nomes pelos contatos. */
export async function getGroupParticipants(accountId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, include: { contact: true } });
  const groupJid = lead?.contact?.whatsappPhone;
  if (!lead?.isGroup || !groupJid?.endsWith('@g.us')) return null;

  // Usa a sessão do número da conversa (se conectado); senão, qualquer conectado.
  const own = lead.whatsappNumberId ? connections.get(lead.whatsappNumberId) : null;
  const sock = (own?.status === 'connected' && own.sock) ? own.sock : getAnyConnectedSock(accountId);
  if (!sock) throw new Error('Nenhum WhatsApp conectado para consultar o grupo');

  const meta = await sock.groupMetadata(groupJid).catch(() => null);
  if (!meta) return null;

  // Nomes: uma consulta só nos contatos, casando pelos últimos 8 dígitos.
  const contacts = await prisma.contact.findMany({ where: { accountId }, select: { name: true, phone: true } });
  const nameByCore = new Map<string, string>();
  for (const c of contacts) {
    const d = (c.phone || '').replace(/\D/g, '');
    if (d.length >= 8) nameByCore.set(d.slice(-8), c.name);
  }

  const members = await Promise.all((meta.participants || []).map(async (p: any) => {
    const rawJid = String(p.id || '');
    let digits = rawJid.split('@')[0].split(':')[0].replace(/\D/g, '');
    // Baileys 7: participantes de grupo vêm como @lid (não é telefone).
    // Resolve para o número real via o mapa LID→número.
    if (rawJid.includes('@lid')) {
      try {
        const pnJid = await sock.signalRepository?.lidMapping?.getPNForLID?.(rawJid);
        const d = pnJid ? String(pnJid).split('@')[0].split(':')[0].replace(/\D/g, '') : '';
        if (d.length >= 8) digits = d;
      } catch { /* mapeamento indisponível */ }
    }
    return {
      phone: digits,
      name: nameByCore.get(digits.slice(-8)) || null,
      isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
    };
  }));
  members.sort((a: any, b: any) =>
    (Number(b.isAdmin) - Number(a.isAdmin)) || (a.name || a.phone).localeCompare(b.name || b.phone));
  return { subject: meta.subject || '', count: members.length, members };
}

/**
 * Backfill em massa: resolve o telefone real dos contatos @lid usando o mapa
 * LID→número do Baileys 7. Preenche contact.phone e lead.customFields.telefone_1.
 */
export async function resolveLidPhones(accountId: string): Promise<{ updated: number; total: number }> {
  const sock = getAnyConnectedSock(accountId);
  if (!sock) throw new Error('Nenhum WhatsApp conectado');

  // Contatos @lid sem telefone real: phone vazio OU com lixo (@lid/@g.us gravado).
  const contacts = await prisma.contact.findMany({
    where: {
      accountId,
      whatsappPhone: { endsWith: '@lid' },
      OR: [{ phone: null }, { phone: '' }, { phone: { contains: '@' } }],
    },
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
        if (!cf.telefone_1 || String(cf.telefone_1).includes('@')) {
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

        // Edição de mensagem: atualiza o conteúdo da mensagem original.
        const edit = getEditInfo(msg);
        if (edit) {
          await applyMessageEdit(edit.targetId, edit.newText).catch(err =>
            console.error('[Baileys] Erro ao editar mensagem:', err));
          continue;
        }

        // Cliente apagou (revoke) uma mensagem que ele mesmo mandou.
        const revoke = getRevokeInfo(msg);
        if (revoke) {
          await applyMessageRevoke(revoke.targetId).catch(err =>
            console.error('[Baileys] Erro ao processar apagar (revoke) recebido:', err));
          continue;
        }

        // Mensagens do próprio número (fromMe): se saíram do CRM, ignoramos o
        // eco (já estão no banco). Se saíram do celular, entram como OUTBOUND
        // para espelhar a conversa completa.
        if (msg.key.fromMe && selfSentIds.has(msg.key.id)) continue;
        // Conversa "de mim para mim mesmo" (chat Você) → conversa própria do número
        const selfChat = await isSelfChat(msg, sock);
        // Se o cliente estiver com "mensagens temporárias" ligado, desliga sozinho.
        maybeDisableDisappearing(sock, msg);
        // Documento/imagem → captura o arquivo; contato compartilhado → cria
        // o card de contato; senão trata como texto.
        if (hasMedia(msg)) {
          await processIncomingMedia(msg, accountId, numberId, sock, selfChat).catch(err =>
            console.error('[Baileys] Erro ao capturar mídia:', err));
        } else if (hasContactCard(msg)) {
          await processIncomingContactCard(msg, accountId, numberId, sock, selfChat);
        } else {
          await processIncomingMessage(msg, accountId, numberId, sock, selfChat);
        }
      }
    });

    // Reação (emoji) recebida numa mensagem — do cliente, ou eco de uma
    // reação minha mandada de outro aparelho. `reaction.key` é a mensagem
    // ALVO (a que recebeu a reação); a chave externa do evento identifica
    // quem reagiu (fromMe). Best-effort: se a lib mudar o formato, só essa
    // funcionalidade específica para de funcionar, o resto do fluxo segue.
    sock.ev.on('messages.reaction', async (events: any[]) => {
      for (const ev of events) {
        try {
          const targetId = ev.reaction?.key?.id || ev.key?.id;
          if (!targetId) continue;
          const emoji = ev.reaction?.text || '';
          const fromMe = ev.reaction?.key?.fromMe ?? ev.key?.fromMe ?? false;
          await applyMessageReaction(targetId, emoji, fromMe);
        } catch (err) {
          console.error('[Baileys] Erro ao processar reação recebida:', err);
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

/**
 * Desembrulha os "envelopes" comuns do WhatsApp (mensagem efêmera/temporária,
 * view-once, documento com legenda, mensagem editada) para chegar no conteúdo real.
 */
function unwrapMessage(m: any): any {
  if (!m || typeof m !== 'object') return m || {};
  if (m.ephemeralMessage?.message) return unwrapMessage(m.ephemeralMessage.message);
  if (m.viewOnceMessage?.message) return unwrapMessage(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2?.message) return unwrapMessage(m.viewOnceMessageV2.message);
  if (m.viewOnceMessageV2Extension?.message) return unwrapMessage(m.viewOnceMessageV2Extension.message);
  if (m.documentWithCaptionMessage?.message) return unwrapMessage(m.documentWithCaptionMessage.message);
  if (m.editedMessage?.message) return unwrapMessage(m.editedMessage.message);
  return m;
}

/** Extrai o texto de uma mensagem do WhatsApp (texto/legenda, incluindo respostas citadas). */
function extractText(msg: any): string {
  const m = unwrapMessage(msg.message);
  return m.conversation
    || m.extendedTextMessage?.text
    || m.imageMessage?.caption
    || m.videoMessage?.caption
    || m.documentMessage?.caption
    || m.buttonsResponseMessage?.selectedDisplayText
    || m.listResponseMessage?.title
    || m.templateButtonReplyMessage?.selectedDisplayText
    || '';
}

/** Se a mensagem for uma EDIÇÃO de outra, retorna { targetId, newText }. */
function getEditInfo(msg: any): { targetId: string; newText: string } | null {
  const proto = msg.message?.protocolMessage;
  // type 14 = MESSAGE_EDIT
  if (proto && proto.editedMessage && proto.key?.id) {
    const newText = extractText({ message: proto.editedMessage });
    return { targetId: proto.key.id, newText };
  }
  return null;
}

/** Mesmo padrão de getEditInfo, mas pra quando o CLIENTE apaga (revoke) uma
 *  mensagem que ele mesmo mandou — chega como protocolMessage tipo REVOKE
 *  (0), sem editedMessage (isso já é tratado por getEditInfo, roda antes no
 *  loop de messages.upsert). */
function getRevokeInfo(msg: any): { targetId: string } | null {
  const proto = msg.message?.protocolMessage;
  if (proto && proto.type === 0 && proto.key?.id && !proto.editedMessage) {
    return { targetId: proto.key.id };
  }
  return null;
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

/**
 * true se a mensagem é do próprio número para ele mesmo (chat "Você").
 * sock.user.lid nem sempre vem preenchido pelo Baileys — quando a mensagem
 * chega em formato @lid e a comparação direta falha, resolve o LID para o
 * telefone real (mesmo mecanismo usado para integrantes de grupo) antes de
 * desistir, para não perder mensagens do chat "Você" enviadas pelo celular.
 */
async function isSelfChat(msg: any, sock: any): Promise<boolean> {
  const rjid = msg?.key?.remoteJid || '';
  if (!rjid || rjid.endsWith('@g.us')) return false;
  const rNum = rjid.split('@')[0].split(':')[0];
  const selfPn = sock?.user?.id ? String(sock.user.id).split('@')[0].split(':')[0] : '';
  const selfLid = sock?.user?.lid ? String(sock.user.lid).split('@')[0].split(':')[0] : '';
  if (rNum && (rNum === selfPn || rNum === selfLid)) return true;

  if (rjid.endsWith('@lid') && selfPn) {
    try {
      const pnJid = await sock.signalRepository?.lidMapping?.getPNForLID?.(rjid);
      const resolved = pnJid ? String(pnJid).split('@')[0].split(':')[0] : '';
      if (resolved && resolved === selfPn) return true;
    } catch { /* mapeamento indisponível */ }
  }
  return false;
}

/** Funil de entrada + admin da conta (usado ao criar leads automaticamente). */
async function resolveInboxTarget(accountId: string, departmentId?: string | null) {
  const pipeline = await getOrCreateInboxPipeline(accountId, departmentId ?? null);
  const admin =
    (departmentId && await prisma.user.findFirst({ where: { accountId, departmentIds: { has: departmentId } } })) ||
    (await prisma.user.findFirst({ where: { accountId } }));
  return { pipeline, admin };
}

/**
 * Conversa "de mim para mim mesmo" de um número conectado (chat Você/anotações).
 * Fica SEPARADA dos contatos — chaveada por self:<numberId> — para não misturar
 * com um contato que por acaso tenha o mesmo telefone do número conectado.
 */
async function getOrCreateSelfLead(accountId: string, numberId: string): Promise<string | null> {
  const numberRec = await prisma.whatsAppNumber.findUnique({ where: { id: numberId } });
  const label = numberRec?.label || 'Meu número';
  const selfKey = `self:${numberId}`;
  const name = `📝 Você (${label})`;
  let contact = await prisma.contact.findFirst({
    where: { accountId, whatsappPhone: selfKey },
    include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
  });
  if (!contact) {
    contact = await prisma.contact.create({
      data: { name, whatsappPhone: selfKey, accountId },
      include: { leads: { take: 1, orderBy: { updatedAt: 'desc' } } },
    });
  }
  const leads = (contact as any).leads || [];
  if (leads.length > 0) {
    const lead = leads[0];
    if (!lead.whatsappNumberId) {
      await prisma.lead.update({ where: { id: lead.id }, data: { whatsappNumberId: numberId } }).catch(() => {});
    }
    return lead.id;
  }
  const { pipeline, admin } = await resolveInboxTarget(accountId, numberRec?.departmentId ?? null);
  if (!pipeline?.stages.length || !admin) return null;
  const lead = await prisma.lead.create({
    data: {
      name, accountId, pipelineId: pipeline.id, stageId: pipeline.stages[0].id,
      userId: admin.id, contactId: contact.id, status: 'OPEN',
      whatsappNumberId: numberId, customFields: { participante_1: name } as any,
    },
  });
  return lead.id;
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

  // Nome de exibição: para grupo, SÓ o assunto do grupo (nunca o nome de um
  // participante); se não der para buscar, um nome neutro (o botão "Atualizar
  // nomes dos grupos" corrige depois). Para 1:1, o pushName do contato.
  let displayName = normalizeClientName(pushName || (realPhone ? `+${realPhone}` : from));
  if (isGroup) {
    // Grupo: mantém o assunto do jeito que está no WhatsApp, sem forçar
    // maiúscula — não é "nome de cliente", é o título que o grupo já tem.
    displayName = await getGroupSubject(sock, from) || 'Grupo do WhatsApp';
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
  const contactPhoneBad = !contact.phone || contact.phone.includes('@');
  if (realPhone && contactPhoneBad) {
    await prisma.contact.update({ where: { id: contact.id }, data: { phone: `+${realPhone}` } }).catch(() => {});
  }

  // Conversa única por contato — o mesmo cliente pode falar pelos dois números
  // que continua no MESMO card, sem duplicar (cada mensagem grava o SEU número
  // em Message.whatsappNumberId, para o "via {número}"; lead.whatsappNumberId
  // só acompanha o último número usado, como sugestão padrão da tela).
  let lead = await prisma.lead.findFirst({
    where: { contactId: contact.id, accountId },
    orderBy: { updatedAt: 'desc' },
  });
  if (lead) {
    const data: any = {};
    if (lead.whatsappNumberId !== numberId) data.whatsappNumberId = numberId;
    const cf = (lead.customFields as any) || {};
    const telBad = !cf.telefone_1 || String(cf.telefone_1).includes('@');
    if (telDisplayResolved && telBad) data.customFields = { ...cf, telefone_1: telDisplayResolved };
    if (Object.keys(data).length) {
      await prisma.lead.update({ where: { id: lead.id }, data }).catch(() => {});
    }
    return lead.id;
  }

  // Novos leads do WhatsApp entram na "Caixa de Entrada" DO SETOR desse
  // número (cada número QR pode pertencer a um departamento diferente —
  // ex: Financiamento Habitacional vs Consórcio). Número sem setor definido
  // ainda cai na Caixa de Entrada "genérica" (compatibilidade).
  const thisNumber = await prisma.whatsAppNumber.findUnique({ where: { id: numberId }, select: { departmentId: true } });
  const targetDepartmentId = thisNumber?.departmentId ?? null;
  const pipeline = await getOrCreateInboxPipeline(accountId, targetDepartmentId);
  // Prefere um usuário do MESMO setor como responsável padrão do card; sem
  // ninguém do setor ainda, cai em qualquer usuário da conta (como antes).
  const admin =
    (targetDepartmentId && await prisma.user.findFirst({ where: { accountId, departmentIds: { has: targetDepartmentId } } })) ||
    (await prisma.user.findFirst({ where: { accountId } }));
  if (!pipeline?.stages.length || !admin) return null;

  // telefone_1 só é preenchido quando temos número real; grupo/@lid ficam em branco.
  const custom: any = { participante_1: contact.name };
  const telDisplay = formatPhoneDisplay(realPhone);
  if (telDisplay) custom.telefone_1 = telDisplay;

  const newLead = await prisma.lead.create({
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
  // Grupo não é um "lead" de venda de verdade — não dispara automação.
  if (!isGroup) {
    const { runAutomations } = require('./automation.service') as typeof import('./automation.service');
    runAutomations({ accountId, trigger: 'NEW_LEAD', leadId: newLead.id, io: globalIO }).catch(() => {});
  }
  return newLead.id;
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

/** Aplica a edição de uma mensagem já salva (busca pelo externalId original). */
async function applyMessageEdit(targetId: string, newText: string) {
  if (!newText) return;
  const existing = await prisma.message.findFirst({ where: { externalId: targetId }, select: { id: true, leadId: true } });
  if (!existing) return;
  const updated = await prisma.message.update({ where: { id: existing.id }, data: { content: newText } });
  globalIO?.to(`lead:${existing.leadId}`).emit('message_edited', { id: existing.id, content: newText });
  globalIO?.to(`lead:${existing.leadId}`).emit('new_message', updated);
}

/** Cliente apagou (revoke) uma mensagem que ele mesmo mandou — espelha como
 *  "apagar local" no CRM também (mesmo campo/evento que POST /:id/delete usa
 *  pro nosso próprio apagar, ver routes/messages.ts). */
async function applyMessageRevoke(targetId: string) {
  const existing = await prisma.message.findFirst({ where: { externalId: targetId }, select: { id: true, leadId: true, deleted: true } });
  if (!existing || existing.deleted) return;
  await prisma.message.update({ where: { id: existing.id }, data: { deleted: true, deletedAt: new Date() } });
  globalIO?.to(`lead:${existing.leadId}`).emit('message_deleted', { id: existing.id });
}

/** Reação recebida (do cliente, ou eco de uma reação minha mandada de outro
 *  aparelho) — acrescenta/substitui a entrada do reator no array de
 *  reactions da mensagem alvo. `fromMe` indica quem reagiu, não quem mandou
 *  a mensagem original. text vazio = reator removeu a própria reação. */
async function applyMessageReaction(targetId: string, emoji: string, fromMe: boolean) {
  const existing = await prisma.message.findFirst({ where: { externalId: targetId }, select: { id: true, leadId: true, reactions: true } });
  if (!existing) return;
  const current = (Array.isArray(existing.reactions) ? existing.reactions : []) as { emoji: string; fromMe: boolean; at: string }[];
  const withoutReactor = current.filter((r) => r.fromMe !== fromMe);
  const next = emoji ? [...withoutReactor, { emoji, fromMe, at: new Date().toISOString() }] : withoutReactor;
  await prisma.message.update({ where: { id: existing.id }, data: { reactions: next as any } });
  globalIO?.to(`lead:${existing.leadId}`).emit('message_reaction', { id: existing.id, reactions: next });
}

/**
 * "Modo temporário" (mensagens que somem): quando o CLIENTE está com essa opção
 * ligada, as mensagens dele chegam embrulhadas em `ephemeralMessage`. Nesses casos
 * desativamos automaticamente o modo temporário da conversa (para não perder o
 * histórico no atendimento). Só reagimos a mensagens do cliente, ignoramos grupos
 * e usamos um cooldown por contato para não reenviar a alteração toda hora.
 */
async function maybeDisableDisappearing(sock: any, msg: any) {
  try {
    if (!sock || msg.key?.fromMe) return;
    if (!msg.message?.ephemeralMessage) return;      // modo temporário desligado → nada a fazer
    const jid = msg.key?.remoteJid as string;
    if (!jid) return;
    if (jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return;
    const last = ephemeralDisabled.get(jid) || 0;
    if (Date.now() - last < 10 * 60 * 1000) return;  // já desativamos há < 10 min
    ephemeralDisabled.set(jid, Date.now());
    await sock.sendMessage(jid, { disappearingMessagesInChat: false });
    console.log('[Baileys] Modo temporário desativado automaticamente para', jid);
  } catch (err) {
    console.warn('[Baileys] Falha ao desativar modo temporário:', err);
  }
}

async function processIncomingMessage(msg: any, accountId: string, numberId: string, sock?: any, selfChat = false) {
  try {
    const fromMe = !!msg.key.fromMe;
    const from = (msg.key.remoteJid as string)?.replace('@s.whatsapp.net', '') || '';
    const text = extractText(msg);
    // Ignora Status/Stories (status@broadcast) — não é conversa nem grupo.
    if (!text || !from || from.endsWith('@broadcast')) return;

    // self-chat (Você) → conversa própria do número; senão, contato normal.
    const leadId = selfChat
      ? await getOrCreateSelfLead(accountId, numberId)
      : await getOrCreateLeadForPhone(from, fromMe ? undefined : msg.pushName, accountId, numberId, sock);
    if (!leadId) return;

    const dup = await prisma.message.findFirst({ where: { externalId: msg.key.id } });
    if (dup) return;

    // Em grupo, guarda quem enviou (o participante) para mostrar acima da mensagem.
    const isGroupMsg = (msg.key.remoteJid as string)?.endsWith('@g.us');
    const senderName = (!fromMe && isGroupMsg) ? (msg.pushName || null) : null;

    const message = await prisma.message.create({
      data: {
        content: text,
        direction: fromMe ? 'OUTBOUND' : 'INBOUND',
        channel: 'WHATSAPP',
        leadId,
        whatsappNumberId: numberId,
        senderName,
        read: fromMe ? true : false,
        externalId: msg.key.id,
        status: fromMe ? 'SENT' : 'DELIVERED',
      },
    });

    globalIO?.to(`lead:${leadId}`).emit('new_message', message);
    globalIO?.emit('new_conversation', { leadId });
    if (!fromMe) {
      const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
      sendPushToAccount(accountId, { title: senderName || msg.pushName || 'Nova mensagem', body: text, leadId }).catch(() => {});
    }

    // Gatilho automático (Templates → "Disparar automaticamente") e assistente
    // de IA (Inbox → botão de IA na conversa): só para mensagem de cliente de
    // verdade (não eco, não grupo, não self-chat). Template tem prioridade —
    // se disparou, não manda a resposta de IA em cima da mesma mensagem.
    if (!fromMe && !isGroupMsg && !selfChat) {
      // SalesBot tem prioridade sobre template/IA — mesma regra de
      // exclusividade que já existe entre os outros dois (só um responde
      // por mensagem).
      const { maybeSalesBotStep } = require('./salesbot.service') as typeof import('./salesbot.service');
      const botHandled = await maybeSalesBotStep(accountId, leadId, text, globalIO);
      if (!botHandled) {
        const templateDisparou = await maybeAutoReplyQR(accountId, leadId, text, from, numberId);
        if (!templateDisparou) {
          // Automações de "mensagem recebida" entram na mesma exclusividade
          // — só a IA responde por cima se nenhuma automação já respondeu.
          const { maybeMessageReceivedAutomations } = require('./automation.service') as typeof import('./automation.service');
          const automationHandled = await maybeMessageReceivedAutomations(accountId, leadId, text, globalIO);
          if (!automationHandled) {
            await maybeAiAutoReplyQR(accountId, leadId, text, from, numberId);
          }
        }
      }
    }
  } catch (err) {
    console.error('[Baileys] Erro ao processar mensagem:', err);
  }
}

/** Verifica se algum template com gatilho automático ativo bate com o início
 *  da mensagem recebida e, se achar, envia o corpo dele como resposta pelo
 *  mesmo número (QR) que recebeu. Implementado aqui (não em message.service)
 *  de propósito, para não criar import circular neste arquivo crítico.
 *  Retorna true se disparou (pra não sobrepor com a resposta de IA). */
async function maybeAutoReplyQR(accountId: string, leadId: string, incomingText: string, phone: string, numberId: string): Promise<boolean> {
  try {
    const norm = incomingText.trim().toLowerCase();
    if (!norm) return false;
    // Só considera gatilhos do MESMO setor deste número (ou "compartilhados",
    // sem setor) — evita um gatilho de outro departamento disparar aqui.
    const thisNumber = await prisma.whatsAppNumber.findUnique({ where: { id: numberId }, select: { departmentId: true } });
    const templates = await prisma.messageTemplate.findMany({
      where: {
        accountId,
        triggerActive: true,
        ...(thisNumber?.departmentId ? { OR: [{ departmentId: thisNumber.departmentId }, { departmentId: null }] } : {}),
      },
    });
    const match = templates.find((t: any) => t.triggerText && norm.startsWith(String(t.triggerText).trim().toLowerCase()));
    if (!match) return false;

    // Não repete se esse template já foi mandado pra esse lead (evita duplicar
    // com eventos repetidos do WhatsApp ou o cliente reenviando a saudação).
    const alreadySent = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND', content: match.body } });
    if (alreadySent) return false;

    const outcome = await sendBaileysMessage(phone, match.body, numberId);
    if ('failed' in outcome) {
      console.error(`[Baileys] Gatilho automático "${match.name}" falhou ao enviar:`, outcome.failed);
      return false;
    }
    const sent = await prisma.message.create({
      data: {
        content: match.body, direction: 'OUTBOUND', channel: 'WHATSAPP', leadId,
        whatsappNumberId: numberId, read: true, externalId: outcome.id, status: 'SENT',
      },
    });
    globalIO?.to(`lead:${leadId}`).emit('new_message', sent);
    console.log(`[Baileys] Gatilho automático "${match.name}" disparado para lead ${leadId}`);
    return true;
  } catch (err) {
    console.error('[Baileys] Erro no gatilho automático:', err);
    return false;
  }
}

/** Assistente de IA respondendo o cliente sozinho (Inbox → botão de IA na
 *  conversa, Lead.aiAutoReplyActive) — só entra se o gatilho de template
 *  acima não disparou pra essa mensagem. Toda resposta enviada vira uma
 *  Note no card, pra equipe acompanhar/poder desligar se algo sair errado. */
async function maybeAiAutoReplyQR(accountId: string, leadId: string, incomingText: string, phone: string, numberId: string): Promise<void> {
  try {
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { aiAutoReplyActive: true } });
    if (!lead?.aiAutoReplyActive) return;

    const result = await generateAiAutoReply(accountId, leadId, incomingText);
    if (!result) return;
    const { reply, handoff } = result;

    const outcome = await sendBaileysMessage(phone, reply, numberId);
    if ('failed' in outcome) {
      console.error('[Baileys] Resposta de IA falhou ao enviar:', outcome.failed);
      return;
    }
    const sent = await prisma.message.create({
      data: {
        content: reply, direction: 'OUTBOUND', channel: 'WHATSAPP', leadId,
        whatsappNumberId: numberId, read: true, externalId: outcome.id, status: 'SENT',
      },
    });
    globalIO?.to(`lead:${leadId}`).emit('new_message', sent);
    await prisma.note.create({ data: { leadId, content: `Resposta automática da IA: "${reply}"`, type: 'COMMENT' } }).catch(() => {});
    console.log(`[Baileys] Resposta de IA enviada automaticamente para lead ${leadId}`);

    if (handoff) await handleAiHandoff(leadId);
  } catch (err) {
    console.error('[Baileys] Erro na resposta automática de IA:', err);
  }
}

/** Cliente pediu atendimento humano (ou saiu do escopo do setor) — desliga a
 *  IA nessa conversa sozinha e avisa o colaborador responsável (som + toast),
 *  igual ao aviso já usado pra "pergunta pendente" entre colaboradores.
 *  Compartilhado com whatsapp.service.ts via duplicação (não import) de
 *  propósito, pra não criar dependência circular nesse arquivo crítico. */
async function handleAiHandoff(leadId: string) {
  try {
    const lead = await prisma.lead.update({
      where: { id: leadId },
      data: { aiAutoReplyActive: false },
      select: { id: true, name: true, userId: true },
    });
    await prisma.note.create({ data: { leadId, content: 'Atendimento automático encerrado — cliente pediu atendimento humano (ou pergunta fora do escopo deste chat). Repassado para a equipe.', type: 'COMMENT' } }).catch(() => {});
    globalIO?.to(`lead:${leadId}`).emit('lead_ai_toggled', { leadId, active: false });
    if (lead.userId) globalIO?.to(`user_${lead.userId}`).emit('ai_handoff', { leadId, leadName: lead.name });
  } catch (err) {
    console.error('[Baileys] Erro ao processar handoff da IA:', err);
  }
}

/** true se a mensagem contém documento, imagem, áudio (nota de voz) ou vídeo */
function hasMedia(msg: any): boolean {
  const m = unwrapMessage(msg.message);
  return !!(m.documentMessage || m.imageMessage || m.audioMessage || m.videoMessage);
}

/** Extrai os metadados e o node de mídia (documento, imagem, áudio ou vídeo) */
function getMediaInfo(msg: any): { node: any; type: 'document' | 'image' | 'audio' | 'video'; fileName: string; mimeType: string } | null {
  const m = unwrapMessage(msg.message);
  const doc = m.documentMessage;
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
  if (m.audioMessage) {
    // Nota de voz (PTT) manda "audio/ogg; codecs=opus" — guarda só o mime base.
    const mimeType = (m.audioMessage.mimetype || 'audio/ogg').split(';')[0].trim();
    const ext = mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('ogg') ? 'ogg' : 'm4a';
    return { node: m.audioMessage, type: 'audio', fileName: `audio-${Date.now()}.${ext}`, mimeType };
  }
  if (m.videoMessage) {
    const mimeType = (m.videoMessage.mimetype || 'video/mp4').split(';')[0].trim();
    const ext = mimeType.includes('3gpp') ? '3gp' : 'mp4';
    return { node: m.videoMessage, type: 'video', fileName: `video-${Date.now()}.${ext}`, mimeType };
  }
  return null;
}

/** true se a mensagem for um CONTATO compartilhado (cartão/vCard) — WhatsApp
 *  manda como contactMessage (1 contato) ou contactsArrayMessage (vários). */
function hasContactCard(msg: any): boolean {
  const m = unwrapMessage(msg.message);
  return !!(m.contactMessage || m.contactsArrayMessage?.contacts?.length);
}

/** Extrai nome + telefone de um bloco vCard 3.0 (formato que o WhatsApp usa
 *  pra compartilhar contato). Pega o telefone do parâmetro "waid=" quando
 *  disponível (já vem limpo, sem formatação) — senão, dos dígitos da linha TEL. */
function parseVcard(vcard: string | undefined, fallbackName?: string): { name: string; phone: string | null } {
  const name = (vcard?.match(/^FN:(.*)$/m)?.[1] || fallbackName || '').trim() || 'Contato sem nome';
  const waid = vcard?.match(/waid=(\d+)/)?.[1];
  const telLine = vcard?.match(/^TEL[^:]*:(.*)$/m)?.[1];
  const telDigits = telLine?.replace(/\D/g, '');
  const phone = waid || (telDigits && telDigits.length >= 8 ? telDigits : null);
  return { name, phone: phone || null };
}

/** Extrai um contato (ou mais, se for contactsArrayMessage) da mensagem. */
function getContactCardInfo(msg: any): { name: string; phone: string | null }[] {
  const m = unwrapMessage(msg.message);
  if (m.contactMessage) {
    return [parseVcard(m.contactMessage.vcard, m.contactMessage.displayName)];
  }
  if (m.contactsArrayMessage?.contacts?.length) {
    return m.contactsArrayMessage.contacts.map((c: any) => parseVcard(c.vcard, c.displayName));
  }
  return [];
}

/** Contato(s) compartilhado(s) no chat — cria uma mensagem por contato, com
 *  nome/telefone extraídos do vCard, pra poder "Conversar" ou "Criar lead"
 *  direto da Inbox (sem digitar nada). Mesma resolução de lead/conversa que
 *  processIncomingMessage — o card fica na conversa ATUAL, não abre uma nova
 *  pro número compartilhado (isso é o que os botões da mensagem fazem). */
async function processIncomingContactCard(msg: any, accountId: string, numberId: string, sock: any, selfChat = false) {
  try {
    const fromMe = !!msg.key.fromMe;
    const from = (msg.key.remoteJid as string)?.replace('@s.whatsapp.net', '') || '';
    if (!from || from.endsWith('@broadcast')) return;

    const contacts = getContactCardInfo(msg);
    if (!contacts.length) return;

    const leadId = selfChat
      ? await getOrCreateSelfLead(accountId, numberId)
      : await getOrCreateLeadForPhone(from, fromMe ? undefined : msg.pushName, accountId, numberId, sock);
    if (!leadId) return;

    const dup = await prisma.message.findFirst({ where: { externalId: msg.key.id } });
    if (dup) return;

    const isGroupMsg = (msg.key.remoteJid as string)?.endsWith('@g.us');
    const senderName = (!fromMe && isGroupMsg) ? (msg.pushName || null) : null;

    // Mais de um contato no mesmo cartão: cria uma mensagem por contato (o
    // 1º usa o externalId real; os demais, um sufixo — senão colidem no
    // índice único e só o 1º seria salvo).
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      const message = await prisma.message.create({
        data: {
          content: `📇 Contato compartilhado: ${c.name}${c.phone ? ` — ${c.phone}` : ''}`,
          direction: fromMe ? 'OUTBOUND' : 'INBOUND',
          channel: 'WHATSAPP',
          leadId,
          whatsappNumberId: numberId,
          senderName,
          read: fromMe ? true : false,
          externalId: i === 0 ? msg.key.id : `${msg.key.id}-${i}`,
          status: fromMe ? 'SENT' : 'DELIVERED',
          sharedContactName: c.name,
          sharedContactPhone: c.phone,
        },
      });
      globalIO?.to(`lead:${leadId}`).emit('new_message', message);
    }
    globalIO?.emit('new_conversation', { leadId });
    if (!fromMe) {
      const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
      sendPushToAccount(accountId, { title: senderName || msg.pushName || 'Nova mensagem', body: '📇 Contato compartilhado', leadId }).catch(() => {});
    }
  } catch (err) {
    console.error('[Baileys] Erro ao processar contato compartilhado:', err);
  }
}

async function processIncomingMedia(msg: any, accountId: string, numberId: string, sock: any, selfChat = false) {
  const fromMe = !!msg.key.fromMe;
  const from = (msg.key.remoteJid as string)?.replace('@s.whatsapp.net', '') || '';
  // Ignora Status/Stories (status@broadcast) — não é conversa nem grupo.
  if (!from || from.endsWith('@broadcast')) return;

  const info = getMediaInfo(msg);
  if (!info) return;

  const dup = await prisma.message.findFirst({ where: { externalId: msg.key.id } });
  if (dup) return;

  const leadId = selfChat
    ? await getOrCreateSelfLead(accountId, numberId)
    : await getOrCreateLeadForPhone(from, fromMe ? undefined : msg.pushName, accountId, numberId, sock);
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
  const isGroupMsg = (msg.key.remoteJid as string)?.endsWith('@g.us');
  const senderName = (!fromMe && isGroupMsg) ? (msg.pushName || null) : null;

  const message = await prisma.message.create({
    data: {
      content, direction: fromMe ? 'OUTBOUND' : 'INBOUND', channel: 'WHATSAPP', leadId,
      whatsappNumberId: numberId, senderName, read: fromMe ? true : false, externalId: msg.key.id,
      status: fromMe ? 'SENT' : 'DELIVERED',
      ...(buffer ? {
        attachments: {
          create: { leadId, fileName: info.fileName, mimeType: info.mimeType, data: buffer },
        },
      } : {}),
    },
    include: { attachments: true },
  });

  globalIO?.to(`lead:${leadId}`).emit('new_message', message);
  globalIO?.emit('new_conversation', { leadId });
  if (!fromMe) {
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: senderName || msg.pushName || 'Nova mensagem', body: content, leadId }).catch(() => {});
  }
  console.log(`[Baileys] Mídia ${buffer ? 'capturada' : 'registrada (sem bytes)'}: ${info.fileName} → lead ${leadId}`);

  // Anexo sobe pro Drive na hora e os bytes saem do banco. Sem isso o Postgres
  // enchia (incidentes de 2026-08-05 e 2026-08-26 — disco 100%, CRM fora do ar).
  // Fire-and-forget: falha/Drive desconectado não pode atrapalhar o recebimento —
  // nesse caso os bytes ficam no banco mesmo, e o arquivamento periódico pega
  // depois. A rota do anexo já sabe servir do Drive quando `data` está vazio.
  for (const att of message.attachments || []) {
    const { autoUploadAttachmentToDrive } = require('./google.service') as typeof import('./google.service');
    autoUploadAttachmentToDrive(accountId, leadId, att.id).catch((err: any) =>
      console.error('[Drive] Auto-upload do anexo falhou:', err?.message));
  }
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
/**
 * Resultado de um envio: `id` quando enviou de fato; `failed` com o motivo
 * quando não enviou — para o chamador nunca reportar sucesso falso.
 * - not_connected: a sessão QR não está conectada.
 * - no_whatsapp: o número não tem conta no WhatsApp (ou formato inválido).
 * - error: exceção/resposta inesperada ao enviar.
 */
export type BaileysSendOutcome =
  | { id: string }
  | { failed: 'not_connected' | 'no_whatsapp' | 'error' };

export async function sendBaileysMessage(
  to: string,
  text: string,
  numberId: string,
  quoted?: { externalId: string; fromMe: boolean }
): Promise<BaileysSendOutcome> {
  const conn = connections.get(numberId);
  if (!conn?.sock || conn.status !== 'connected') return { failed: 'not_connected' };
  try {
    // Se já vier um JID completo (@lid, @g.us, @s.whatsapp.net), respeita-o.
    // O WhatsApp passou a entregar mensagens com endereçamento @lid; nesses
    // casos precisamos responder para o mesmo JID, não reconstruir como telefone.
    let jid = toWhatsAppJid(to);

    // Número de telefone (@s.whatsapp.net): confirmamos no servidor do WhatsApp
    // que a conta existe e usamos o JID canônico. Sem isso, um número novo/mal
    // formatado (ex.: 9º dígito) era "enviado" para um JID inexistente — o
    // servidor aceitava, devolvia um id e a mensagem nunca chegava, dando falsa
    // aparência de sucesso. @lid e grupos (@g.us) passam direto.
    if (jid.endsWith('@s.whatsapp.net')) {
      try {
        const [hit] = (await conn.sock.onWhatsApp(jid)) || [];
        if (!hit?.exists) return { failed: 'no_whatsapp' };
        if (hit.jid) jid = hit.jid; // JID canônico (corrige 9º dígito, etc.)
      } catch (checkErr) {
        // Falha transitória na verificação não deve bloquear o envio:
        // segue com o JID construído (comportamento anterior).
        console.warn('[Baileys] onWhatsApp falhou, enviando assim mesmo:', checkErr);
      }
    }

    // Citação (resposta com trecho da mensagem original, como no WhatsApp):
    // um stub mínimo já basta — o Baileys não precisa do conteúdo completo da
    // mensagem original para renderizar a citação, só da chave dela.
    const quotedMsg = quoted
      ? { key: { remoteJid: jid, id: quoted.externalId, fromMe: quoted.fromMe }, message: {} }
      : undefined;

    const sent = await conn.sock.sendMessage(jid, { text }, quotedMsg ? { quoted: quotedMsg } : undefined);
    const id = sent?.key?.id || null;
    if (!id) return { failed: 'error' };
    selfSentIds.add(id);
    setTimeout(() => selfSentIds.delete(id), 5 * 60 * 1000);
    return { id };
  } catch (err) {
    console.error('[Baileys] Erro ao enviar:', err);
    return { failed: 'error' };
  }
}

/**
 * Envia um documento/imagem por um número específico. Retorna o id da mensagem
 * enviada, ou null se não estiver conectado / falhar.
 */
export async function sendBaileysMedia(
  to: string,
  buffer: Buffer,
  fileName: string,
  mimeType: string,
  caption: string,
  numberId: string,
): Promise<string | null> {
  const conn = connections.get(numberId);
  if (!conn?.sock || conn.status !== 'connected') return null;
  try {
    const jid = toWhatsAppJid(to);
    const isImage = mimeType.startsWith('image/');
    const content: any = isImage
      ? { image: buffer, mimetype: mimeType, caption: caption || undefined }
      : { document: buffer, mimetype: mimeType, fileName, caption: caption || undefined };
    const sent = await conn.sock.sendMessage(jid, content);
    const id = sent?.key?.id || null;
    if (id) {
      selfSentIds.add(id);
      setTimeout(() => selfSentIds.delete(id), 5 * 60 * 1000);
    }
    return id;
  } catch (err) {
    console.error('[Baileys] Erro ao enviar mídia:', err);
    return null;
  }
}

/** Resultado de uma ação (apagar/reagir) — mais simples que BaileysSendOutcome
 *  porque não devolve id nenhum, só sucesso/erro. */
export type BaileysActionOutcome = { ok: true } | { ok: false; error: string };

/**
 * "Apagar pra todos" de verdade (revoke) — só funciona pra mensagem que EU
 * mandei (fromMe: true); o WhatsApp não deixa apagar mensagem de quem
 * recebeu, nem pelo app oficial. Melhor esforço: quem chama decide se o
 * apagar local do CRM segue mesmo se isso falhar.
 */
export async function sendBaileysDelete(to: string, externalId: string, fromMe: boolean, numberId: string): Promise<BaileysActionOutcome> {
  const conn = connections.get(numberId);
  if (!conn?.sock || conn.status !== 'connected') return { ok: false, error: 'not_connected' };
  try {
    const jid = toWhatsAppJid(to);
    const key = { remoteJid: jid, id: externalId, fromMe };
    await conn.sock.sendMessage(jid, { delete: key });
    return { ok: true };
  } catch (err: any) {
    console.error('[Baileys] Erro ao apagar (revoke):', err);
    return { ok: false, error: err?.message || 'error' };
  }
}

/** Reage com um emoji a uma mensagem (minha ou do contato) — text: '' remove
 *  a reação. Mesma reconstrução de key do sendBaileysDelete acima. */
export async function sendBaileysReaction(to: string, externalId: string, fromMe: boolean, emoji: string, numberId: string): Promise<BaileysActionOutcome> {
  const conn = connections.get(numberId);
  if (!conn?.sock || conn.status !== 'connected') return { ok: false, error: 'not_connected' };
  try {
    const jid = toWhatsAppJid(to);
    const key = { remoteJid: jid, id: externalId, fromMe };
    await conn.sock.sendMessage(jid, { react: { text: emoji, key } });
    return { ok: true };
  } catch (err: any) {
    console.error('[Baileys] Erro ao reagir:', err);
    return { ok: false, error: err?.message || 'error' };
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
