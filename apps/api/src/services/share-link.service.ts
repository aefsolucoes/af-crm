import { prisma } from '../lib/prisma';

/**
 * ARQUIVO MANDADO POR LINK DE COMPARTILHAMENTO (Fabio 03/11: a cliente mandou a certidão da matrícula pelo "Abra o documento compartilhado" do Adobe
 * e o arquivo nunca chegou à pasta). O CRM baixa o(s) arquivo(s) do link — Adobe Acrobat, Google Drive (arquivo ou pasta) e Dropbox —, anexa na PRÓPRIA
 * mensagem (aparece na conversa como anexo) e segue o caminho de um anexo comum: Drive → pasta do cliente (received-docs) → conferência de documentos.
 * Link que não dá pra baixar (privado, expirado, outro serviço) vira nota + push pra equipe salvar à mão.
 */

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 15;
const TIMEOUT_MS = 60_000;

type Arquivo = { fileName: string; mimeType: string; data: Buffer };
type Link = { url: string; servico: 'Adobe' | 'Google Drive' | 'Dropbox' };

export function shareLinksIn(text: string): Link[] {
  const urls = String(text || '').match(/https?:\/\/[^\s"'<>)\]]+/gi) || [];
  const out: Link[] = [];
  for (const raw of urls) {
    const url = raw.replace(/[.,;!?]+$/, '');
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }
    const servico: Link['servico'] | null =
      /(^|\.)acrobat\.adobe\.com$|(^|\.)documentcloud\.adobe\.com$|(^|\.)adobe\.ly$/.test(host) ? 'Adobe'
        : /(^|\.)drive\.google\.com$|(^|\.)docs\.google\.com$/.test(host) ? 'Google Drive'
          : /(^|\.)dropbox\.com$/.test(host) ? 'Dropbox' : null;
    if (servico && !out.some((l) => l.url === url)) out.push({ url, servico });
  }
  return out;
}

async function get(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

async function corpo(res: Response): Promise<Buffer> {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new Error(`arquivo grande demais (${Math.round(len / 1048576)} MB)`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`arquivo grande demais (${Math.round(buf.length / 1048576)} MB)`);
  return buf;
}

function nomeDoCabecalho(res: Response, padrao: string): string {
  const cd = res.headers.get('content-disposition') || '';
  const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1].trim()); } catch { /* segue */ } }
  const simples = cd.match(/filename="?([^";]+)"?/i);
  return simples ? simples[1].trim() : padrao;
}

/** Adobe Acrobat ("Abra o documento compartilhado"): o visualizador público baixa sem login pelo send-asr — a mesma chamada do botão "Download" da página. */
async function adobe(url: string): Promise<Arquivo[]> {
  let alvo = url;
  if (/adobe\.ly/i.test(alvo)) alvo = (await get(alvo, { redirect: 'follow' })).url; // link curto: o redirecionamento leva ao acrobat.adobe.com
  const urn = decodeURIComponent(alvo).match(/urn:aaid:sc:[A-Z]{2}:[0-9a-f-]{36}/i)?.[0];
  if (!urn) throw new Error('não achei o código do documento no link do Adobe');
  const boot = await get(`https://send-asr.acrobat.com/a/preview/${urn}/bootstrap?shareinfo`, { headers: { accept: 'application/json' } });
  if (!boot.ok) throw new Error(`o Adobe não abriu o link (HTTP ${boot.status})`);
  const info = (await boot.json()) as { parcel_data?: { id?: string; invitation?: string }; meta_list?: Array<{ id: string; name?: string; content_type?: string; object_type?: string; size?: number }> };
  const parcel = info.parcel_data?.id || urn;
  const convite = info.parcel_data?.invitation || urn;
  const arquivos = (info.meta_list || []).filter((m) => (m.object_type || 'file') === 'file').slice(0, MAX_FILES);
  if (!arquivos.length) throw new Error('o link do Adobe não tem arquivo (pode ter sido apagado ou o compartilhamento foi desligado)');
  const out: Arquivo[] = [];
  for (const m of arquivos) {
    if ((m.size || 0) > MAX_BYTES) throw new Error(`"${m.name}" é grande demais`);
    const form = new URLSearchParams({ invitation_id: convite, parcel_id: parcel, file_id: m.id, action_id: 'download', make_direct_storage_uri: 'true' });
    const r = await get('https://send-asr.acrobat.com/a/track', {
      method: 'POST', redirect: 'manual', body: form.toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-api-client-id': 'dc-prod-virgoweb' },
    });
    const destino = r.headers.get('location');
    if (!destino) throw new Error(`o Adobe não liberou o download de "${m.name}" (HTTP ${r.status})`);
    const f = await get(destino);
    if (!f.ok) throw new Error(`o Adobe recusou o download de "${m.name}" (HTTP ${f.status})`);
    out.push({ fileName: m.name || 'documento.pdf', mimeType: m.content_type || f.headers.get('content-type') || 'application/octet-stream', data: await corpo(f) });
  }
  return out;
}

/** Google Drive: pela conexão do Drive do CRM (link "qualquer pessoa com o link" abre por ela). Pasta → todos os arquivos dela; Documento Google → PDF. */
async function googleDrive(accountId: string, url: string): Promise<Arquivo[]> {
  const pasta = url.match(/\/folders\/([\w-]{15,})/)?.[1];
  const arquivo = url.match(/\/(?:file|document|spreadsheets|presentation)\/d\/([\w-]{15,})/)?.[1] || url.match(/[?&]id=([\w-]{15,})/)?.[1];
  if (!pasta && !arquivo) throw new Error('não achei o arquivo no link do Google Drive');
  const { getDrive } = require('./google.service') as typeof import('./google.service');
  const drive = await getDrive(accountId);
  const metas: Array<{ id: string; name: string; mimeType: string; size?: string | null }> = [];
  if (pasta) {
    const r = await drive.files.list({ q: `'${pasta}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`, fields: 'files(id,name,mimeType,size)', pageSize: MAX_FILES, supportsAllDrives: true, includeItemsFromAllDrives: true });
    metas.push(...((r.data.files || []) as any[]));
    if (!metas.length) throw new Error('a pasta do Google Drive está vazia ou não está compartilhada com "qualquer pessoa com o link"');
  } else {
    const r = await drive.files.get({ fileId: arquivo!, fields: 'id,name,mimeType,size', supportsAllDrives: true });
    metas.push(r.data as any);
  }
  const out: Arquivo[] = [];
  for (const m of metas.slice(0, MAX_FILES)) {
    if (Number(m.size || 0) > MAX_BYTES) throw new Error(`"${m.name}" é grande demais`);
    if (m.mimeType.startsWith('application/vnd.google-apps.')) {
      const r = await drive.files.export({ fileId: m.id, mimeType: 'application/pdf' }, { responseType: 'arraybuffer' });
      out.push({ fileName: `${m.name}.pdf`, mimeType: 'application/pdf', data: Buffer.from(r.data as ArrayBuffer) });
    } else {
      const r = await drive.files.get({ fileId: m.id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
      out.push({ fileName: m.name, mimeType: m.mimeType, data: Buffer.from(r.data as ArrayBuffer) });
    }
  }
  return out;
}

/** Dropbox: o mesmo link com dl=1 devolve o arquivo (pasta vem como .zip — fica de fora). */
async function dropbox(url: string): Promise<Arquivo[]> {
  const u = new URL(url);
  u.searchParams.set('dl', '1');
  const r = await get(u.toString(), { redirect: 'follow' });
  if (!r.ok) throw new Error(`o Dropbox recusou o link (HTTP ${r.status})`);
  const tipo = r.headers.get('content-type') || 'application/octet-stream';
  if (/text\/html/i.test(tipo)) throw new Error('o Dropbox pediu login (link privado)');
  const nome = nomeDoCabecalho(r, decodeURIComponent(u.pathname.split('/').pop() || 'arquivo'));
  if (/zip/i.test(tipo) || /\.zip$/i.test(nome)) throw new Error('é uma pasta do Dropbox (vem compactada) — salve os arquivos à mão');
  return [{ fileName: nome, mimeType: tipo.split(';')[0], data: await corpo(r) }];
}

/**
 * Baixa os arquivos dos links de compartilhamento da mensagem e anexa NELA. Não repete: arquivo com o mesmo nome já anexado à mensagem fica de fora
 * (pode chamar de novo sem duplicar). Devolve quantos arquivos entraram.
 */
export async function importShareLinks(p: { accountId: string; leadId: string; messageId: string; text: string; io?: any }): Promise<number> {
  const links = shareLinksIn(p.text);
  if (!links.length) return 0;
  const ja = new Set((await prisma.messageAttachment.findMany({ where: { messageId: p.messageId }, select: { fileName: true } })).map((a) => a.fileName));
  const lead = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { name: true } });
  const novos: Array<{ id: string; fileName: string }> = [];
  const falhas: string[] = [];
  for (const link of links) {
    try {
      const arquivos = link.servico === 'Adobe' ? await adobe(link.url) : link.servico === 'Google Drive' ? await googleDrive(p.accountId, link.url) : await dropbox(link.url);
      for (const a of arquivos) {
        if (ja.has(a.fileName)) continue;
        const att = await prisma.messageAttachment.create({ data: { messageId: p.messageId, leadId: p.leadId, fileName: a.fileName, mimeType: a.mimeType, data: a.data }, select: { id: true, fileName: true } });
        ja.add(a.fileName);
        novos.push(att);
      }
    } catch (e: any) {
      falhas.push(`${link.servico}: ${e?.message || 'erro'}`);
      console.warn(`[Link compartilhado] ${lead?.name || p.leadId}: ${link.servico} falhou —`, e?.message);
    }
  }
  const { autoUploadAttachmentToDrive } = require('./google.service') as typeof import('./google.service');
  for (const att of novos) await autoUploadAttachmentToDrive(p.accountId, p.leadId, att.id).catch((err: any) => console.error('[Link compartilhado] Drive:', err?.message));
  if (novos.length) {
    await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `📎 O cliente mandou ${novos.length > 1 ? 'arquivos' : 'um arquivo'} por link de compartilhamento — o CRM baixou e anexou na mensagem (vai pra pasta do cliente): ${novos.map((a) => a.fileName).join(', ')}` } }).catch(() => {});
    const { scheduleDocsCheck } = require('./docs-checker.service') as typeof import('./docs-checker.service');
    await scheduleDocsCheck(p.accountId, p.leadId, p.io).catch(() => {});
    if (p.io) p.io.to(`lead:${p.leadId}`).emit('message_attachments_added', { leadId: p.leadId, messageId: p.messageId });
  }
  if (falhas.length) {
    await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', content: `⚠️ O cliente mandou um link de compartilhamento que o CRM NÃO conseguiu baixar (${falhas.join(' | ')}). Abra o link na conversa e salve o arquivo na pasta do cliente.` } }).catch(() => {});
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(p.accountId, { title: `📎 ${lead?.name || 'Cliente'}: link de arquivo`, body: 'Não consegui baixar o arquivo do link — salve à mão na pasta', leadId: p.leadId }).catch(() => {});
  }
  return novos.length;
}

/** Varre as mensagens recebidas do card (últimos `dias`) e importa os links que ainda não viraram anexo. */
export async function importShareLinksForLead(accountId: string, leadId: string, io?: any, dias = 60): Promise<{ mensagens: number; arquivos: number }> {
  const msgs = await prisma.message.findMany({
    where: { leadId, direction: 'INBOUND', deleted: false, createdAt: { gte: new Date(Date.now() - dias * 86_400_000) }, OR: [{ content: { contains: 'http' } }, { channel: 'EMAIL' }] },
    select: { id: true, content: true, channel: true, externalId: true },
  });
  let mensagens = 0, arquivos = 0;
  for (const m of msgs) {
    const texto = m.channel === 'EMAIL' ? await textoDoEmail(m.externalId, m.content) : m.content;
    if (!shareLinksIn(texto).length) continue;
    mensagens++;
    arquivos += await importShareLinks({ accountId, leadId, messageId: m.id, text: texto, io });
  }
  return { mensagens, arquivos };
}

/** Texto do e-mail com os endereços dos links do HTML ("Abrir documento" só tem o link no href). */
export async function textoDoEmail(messageId: string | null, conteudo: string): Promise<string> {
  if (!messageId) return conteudo;
  const row = await prisma.emailMessage.findFirst({ where: { messageId }, select: { textBody: true, htmlBody: true } });
  const hrefs = (row?.htmlBody || '').match(/href\s*=\s*["']([^"']+)["']/gi)?.map((h) => h.replace(/^href\s*=\s*["']|["']$/gi, '').replace(/&amp;/g, '&')) || [];
  return [conteudo, row?.textBody || '', ...hrefs].join('\n');
}
