import fs from 'fs';
import os from 'os';
import path from 'path';
import { prisma } from '../lib/prisma';

/**
 * WhatsApp por QR SÓ PRA RECEBER O CÓDIGO DA CAIXA (Fabio 12/11: "vamos conectar um QR, apenas para receber esse código para passar").
 * O simulador da CAIXA manda o código de verificação pelo WhatsApp (0800 104 0104) num formato que a API Oficial entrega como "unsupported" (erro 131051, sem o
 * texto) — por isso um número comum, conectado por QR (Baileys 7), recebe o código. Este serviço:
 *  - NÃO cria card, NÃO liga IA, NÃO passa pela Inbox e NÃO envia nada (Fabio: "não precisa ligar IA para esse número");
 *  - só guarda os códigos que chegam (`codigoQr`), e o número conectado vai no campo "Telefone celular" do simulador;
 *  - a sessão fica no banco (BaileysSession.data.caixaCodigo) pra não pedir QR de novo a cada deploy.
 * O canal de WhatsApp por QR do CRM saiu em 14/09 (b44bd4c); isto é outra coisa, mínima, sem tocar nas conversas.
 */

// Baileys 7 é ESM puro e o projeto compila pra CommonJS: import dinâmico REAL (o tsc não reescreve).
const dynamicImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

type Status = 'desconectado' | 'conectando' | 'qr' | 'conectado';
interface Conexao { sock: any; qr: string | null; status: Status; numero: string | null; tentativas: number }
const conexoes = new Map<string, Conexao>();
const codigos: { accountId: string; codigo: string; em: number }[] = [];

const pasta = (accountId: string) => path.join(os.tmpdir(), `caixa-codigo-qr-${accountId}`);
const silencioso: any = { level: 'silent', trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => silencioso };

async function restaurar(accountId: string): Promise<string> {
  const dir = pasta(accountId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const row = await prisma.baileysSession.findUnique({ where: { accountId } });
  const files = ((row?.data || {}) as any).caixaCodigo as Record<string, string> | undefined;
  if (files) for (const [nome, conteudo] of Object.entries(files)) if (typeof conteudo === 'string') fs.writeFileSync(path.join(dir, nome), conteudo, 'utf-8');
  return dir;
}
async function salvar(accountId: string, dir: string): Promise<void> {
  try {
    const files: Record<string, string> = {};
    for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isFile()) files[f] = fs.readFileSync(p, 'utf-8'); }
    const row = await prisma.baileysSession.findUnique({ where: { accountId } });
    const data = { ...((row?.data || {}) as any), caixaCodigo: files };
    await prisma.baileysSession.upsert({ where: { accountId }, create: { accountId, data }, update: { data } });
  } catch (e: any) { console.error('[QR código CAIXA] salvar sessão:', e?.message); }
}
async function apagarSessao(accountId: string): Promise<void> {
  const row = await prisma.baileysSession.findUnique({ where: { accountId } });
  if (!row) return;
  const data = { ...((row.data || {}) as any) };
  delete data.caixaCodigo;
  await prisma.baileysSession.update({ where: { accountId }, data: { data } }).catch(() => {});
}

/** "5561981721313:12@s.whatsapp.net" → "61981721313" (celular com o 9 — o WhatsApp às vezes guarda sem). */
function celularDoJid(jid: string): string | null {
  let d = String(jid || '').split(':')[0].split('@')[0].replace(/\D/g, '');
  if (d.startsWith('55')) d = d.slice(2);
  if (d.length === 10 && /[6-9]/.test(d[2])) d = `${d.slice(0, 2)}9${d.slice(2)}`;
  return d.length === 11 ? d : null;
}

/** Todo texto que existir na mensagem (código de verificação vem em template/botão, não em "conversation"). */
function textos(obj: any, out: string[] = [], fundo = 0): string[] {
  if (!obj || fundo > 8) return out;
  if (typeof obj === 'string') { out.push(obj); return out; }
  if (typeof obj === 'object') for (const v of Object.values(obj)) textos(v, out, fundo + 1);
  return out;
}
export function codigoDoTexto(t: string): string | null {
  if (!/c[óo]digo|code|verifica|caixa|token/i.test(t)) return null;
  return (t.match(/\b(\d{6})\b/) || t.match(/\b(\d{4,8})\b/) || [])[1] || null;
}

/** Avisa os administradores (push) — sessão caiu de vez e precisa de QR novo (Fabio 12/11: "e em caso de desconectar sozinho?"). Uma vez a cada 6 h. */
let avisadoEm = 0;
async function avisarDesconectado(accountId: string, motivo: string): Promise<void> {
  if (Date.now() - avisadoEm < 6 * 3600_000) return;
  avisadoEm = Date.now();
  try {
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    const admins = await prisma.user.findMany({ where: { accountId, role: 'ADMIN' }, select: { id: true } });
    await sendPushToAccount(accountId, { title: '📵 WhatsApp do código da CAIXA desconectou', body: `${motivo} — abra o CRM em /caixa-codigo e escaneie o QR de novo.`, url: '/caixa-codigo' }, admins.map((a) => a.id));
  } catch (e: any) { console.error('[QR código CAIXA] push:', e?.message); }
}

async function iniciar(accountId: string, opts: { doBanco?: boolean } = {}): Promise<void> {
  const atual = conexoes.get(accountId);
  if (atual && (atual.status === 'conectado' || atual.status === 'conectando' || atual.status === 'qr')) return;
  const c: Conexao = { sock: null, qr: null, status: 'conectando', numero: null, tentativas: (atual?.tentativas || 0) };
  conexoes.set(accountId, c);
  try {
    const b = await dynamicImport('@whiskeysockets/baileys');
    const makeWASocket = b.default?.default || b.default || b.makeWASocket;
    const { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, DisconnectReason } = b;
    // Reconexão no mesmo processo (ex.: 515 logo depois de escanear) usa a pasta como está — restaurar do banco aqui apagava as credenciais novas (12/11).
    const dir = opts.doBanco !== false || !fs.existsSync(pasta(accountId)) ? await restaurar(accountId) : pasta(accountId);
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    let version: number[] | undefined;
    try { version = (await fetchLatestBaileysVersion()).version; } catch { /* usa a padrão da lib */ }
    const sock = makeWASocket({
      ...(version ? { version } : {}), auth: state, logger: silencioso, printQRInTerminal: false,
      browser: Browsers?.macOS('Safari') ?? ['AF CRM', 'Safari', '17.0'], markOnlineOnConnect: false,
      syncFullHistory: false, shouldSyncHistoryMessage: () => false, generateHighQualityLinkPreview: false,
      connectTimeoutMs: 60_000, keepAliveIntervalMs: 20_000, qrTimeout: 60_000,
    });
    c.sock = sock;
    sock.ev.on('creds.update', async () => { await saveCreds(); await salvar(accountId, dir); });
    sock.ev.on('connection.update', async (u: any) => {
      if (u.connection) console.log(`[QR código CAIXA] conexão: ${u.connection}`);
      if (u.qr) {
        try { const QRCode = await import('qrcode'); c.qr = await QRCode.toDataURL(u.qr); c.status = 'qr'; } catch (e: any) { console.error('[QR código CAIXA] QR:', e?.message); }
      }
      if (u.connection === 'open') {
        c.status = 'conectado'; c.qr = null; c.tentativas = 0;
        c.numero = celularDoJid(sock.user?.id || '');
        console.log(`[QR código CAIXA] conectado (${c.numero ? `…${c.numero.slice(-4)}` : 'sem número'})`);
        await salvar(accountId, dir);
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        const saiu = code === DisconnectReason?.loggedOut || code === 401 || code === 403;
        c.status = 'desconectado'; c.qr = null; c.sock = null;
        console.log(`[QR código CAIXA] fechou (status ${code})${saiu ? ' — sessão encerrada no celular' : ''}`);
        if (saiu) { await apagarSessao(accountId); await avisarDesconectado(accountId, 'A sessão foi encerrada no celular'); return; }
        await salvar(accountId, dir);
        // Reconecta sempre: 5 s nas primeiras vezes, depois 1 min, depois 5 min (nunca desiste — o código da CAIXA depende disso).
        const espera = c.tentativas < 5 ? 5000 : c.tentativas < 20 ? 60_000 : 300_000;
        c.tentativas++;
        if (c.tentativas === 20) await avisarDesconectado(accountId, 'Não consigo reconectar há um tempo');
        setTimeout(() => iniciar(accountId, { doBanco: false }).catch(() => {}), espera);
      }
    });
    // Só LÊ: guarda o código e mais nada (sem card, sem IA, sem Inbox, sem resposta).
    sock.ev.on('messages.upsert', ({ messages, type }: any) => {
      for (const m of messages || []) {
        // Diagnóstico mínimo (sem conteúdo, sem número): ver se a mensagem da CAIXA chega e se dá pra ler.
        console.log(`[QR código CAIXA] mensagem (${type}) fromMe=${!!m?.key?.fromMe} stub=${m?.messageStubType ?? '-'} tipos=${Object.keys(m?.message || {}).join(',') || 'nenhum'}`);
        if (m?.key?.fromMe || !m?.message) continue;
        // A mensagem da CAIXA chega como "placeholderMessage" (o WhatsApp esconde o conteúdo dos aparelhos conectados — 12/11 16:31): pede ao celular
        // que reenvie o conteúdo (PDO placeholder resend); a resposta volta por este mesmo evento já com o texto.
        if (m.message.placeholderMessage) {
          console.log(`[QR código CAIXA] mensagem oculta (placeholder tipo ${m.message.placeholderMessage.type ?? '-'}) — pedindo ao celular`);
          const key = { remoteJid: m.key.remoteJid, fromMe: m.key.fromMe, id: m.key.id, participant: m.key.participant };
          Promise.resolve(sock.requestPlaceholderResend?.(key, { key: m.key, messageTimestamp: m.messageTimestamp, pushName: m.pushName, participant: m.participant }))
            .then((r: any) => console.log(`[QR código CAIXA] reenvio pedido ao celular (${r ? String(r).slice(0, 12) : 'sem id'})`))
            .catch((e: any) => console.error('[QR código CAIXA] reenvio:', e?.message));
          continue;
        }
        const codigo = codigoDoTexto(textos(m.message).join(' \n '));
        if (!codigo) continue;
        codigos.push({ accountId, codigo, em: Date.now() });
        while (codigos.length > 50) codigos.shift();
        console.log(`[QR código CAIXA] código recebido (${codigo.length} dígitos)`);
      }
    });
  } catch (e: any) {
    c.status = 'desconectado';
    console.error('[QR código CAIXA] não conectou:', e?.message);
  }
}

export async function conectarQr(accountId: string) { await iniciar(accountId, { doBanco: true }); return statusQr(accountId); }
export function statusQr(accountId: string): { status: Status; qr: string | null; numero: string | null } {
  const c = conexoes.get(accountId);
  return { status: c?.status || 'desconectado', qr: c?.qr || null, numero: c?.numero || null };
}
export async function desconectarQr(accountId: string): Promise<void> {
  const c = conexoes.get(accountId);
  try { await c?.sock?.logout?.(); } catch { /* já caiu */ }
  conexoes.delete(accountId);
  await apagarSessao(accountId);
}
/** Último código que chegou pelo QR depois de `desde`. */
export function codigoQr(accountId: string, desde: Date): { codigo: string; em: string } | null {
  const c = [...codigos].reverse().find((x) => x.accountId === accountId && x.em >= desde.getTime() - 30_000);
  return c ? { codigo: c.codigo, em: new Date(c.em).toISOString() } : null;
}
/** Número conectado (pro campo "Telefone celular" do simulador) — null sem conexão. */
export function numeroQr(accountId: string): string | null {
  const c = conexoes.get(accountId);
  return c?.status === 'conectado' ? c.numero : null;
}
/** No boot: reconecta quem já tinha escaneado o QR. */
export async function retomarQrNoBoot(): Promise<void> {
  const rows = await prisma.baileysSession.findMany({ select: { accountId: true, data: true } });
  for (const r of rows) if ((r.data as any)?.caixaCodigo) await iniciar(r.accountId, { doBanco: true }).catch(() => {});
}
