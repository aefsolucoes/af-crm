import { google } from 'googleapis';
import { Readable } from 'stream';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid',
];

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Credenciais do Google não configuradas (GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI)');
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function isGoogleConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

/** URL de consentimento — o accountId vai no state para vincular no callback */
export function getAuthUrl(accountId: string): string {
  const oauth2 = getOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: 'offline',        // garante refresh_token
    prompt: 'consent',             // força emitir refresh_token
    scope: SCOPES,
    state: accountId,
  });
}

/** Troca o code por tokens e salva a conexão da conta */
export async function handleOAuthCallback(code: string, accountId: string): Promise<void> {
  const oauth2 = getOAuthClient();
  const { tokens } = await oauth2.getToken(code);
  oauth2.setCredentials(tokens);

  // Descobre o e-mail da conta conectada
  let email: string | null = null;
  try {
    const oauth2Api = google.oauth2({ version: 'v2', auth: oauth2 });
    const me = await oauth2Api.userinfo.get();
    email = me.data.email || null;
  } catch { /* opcional */ }

  const refreshToken = tokens.refresh_token;
  await prisma.googleConnection.upsert({
    where: { accountId },
    create: {
      accountId,
      email,
      refreshToken: refreshToken || '',
      accessToken: tokens.access_token || null,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    },
    update: {
      email,
      // só sobrescreve o refreshToken se veio um novo (o Google nem sempre reenvia)
      ...(refreshToken ? { refreshToken } : {}),
      accessToken: tokens.access_token || null,
      expiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    },
  });
}

/** Cliente Drive autenticado para a conta (com refresh automático de token) */
async function getDrive(accountId: string) {
  const conn = await prisma.googleConnection.findUnique({ where: { accountId } });
  if (!conn?.refreshToken) throw new Error('Google Drive não conectado para esta conta');

  const oauth2 = getOAuthClient();
  oauth2.setCredentials({
    refresh_token: conn.refreshToken,
    access_token: conn.accessToken || undefined,
    expiry_date: conn.expiresAt ? conn.expiresAt.getTime() : undefined,
  });

  // Persiste o access_token renovado quando o Google emitir um novo
  oauth2.on('tokens', async (tokens) => {
    await prisma.googleConnection.update({
      where: { accountId },
      data: {
        ...(tokens.access_token ? { accessToken: tokens.access_token } : {}),
        ...(tokens.expiry_date ? { expiresAt: new Date(tokens.expiry_date) } : {}),
        ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      },
    }).catch(() => {});
  });

  return google.drive({ version: 'v3', auth: oauth2 });
}

export async function getGoogleStatus(accountId: string) {
  const conn = await prisma.googleConnection.findUnique({ where: { accountId } });
  return {
    connected: !!conn?.refreshToken,
    email: conn?.email || null,
    rootFolderId: conn?.rootFolderId || null,
    rootFolderName: conn?.rootFolderName || null,
    configured: isGoogleConfigured(),
  };
}

export async function disconnectGoogle(accountId: string) {
  await prisma.googleConnection.deleteMany({ where: { accountId } });
}

export async function setRootFolder(accountId: string, folderId: string, folderName: string) {
  await prisma.googleConnection.update({
    where: { accountId },
    data: { rootFolderId: folderId, rootFolderName: folderName },
  });
}

/** Nome real de uma pasta do Drive a partir do ID (para colar um link direto, sem navegar). */
export async function getFolderName(accountId: string, folderId: string): Promise<string> {
  const drive = await getDrive(accountId);
  const res = await drive.files.get({ fileId: folderId, fields: 'id, name, mimeType', supportsAllDrives: true });
  if (res.data.mimeType !== 'application/vnd.google-apps.folder') {
    throw new Error('O link não aponta para uma pasta do Drive');
  }
  return res.data.name || 'Pasta sem nome';
}

/** Extrai o ID de uma pasta a partir de um link do Drive (ou aceita o ID puro). */
export function extractFolderId(input: string): string {
  const trimmed = input.trim();
  const match = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : trimmed;
}

// ─── Operações no Drive ─────────────────────────────────────────────────────

/** Lista pastas dentro de um parent (ou da raiz "root"/rootFolder se não informado) */
export async function listFolders(accountId: string, parentId?: string) {
  const drive = await getDrive(accountId);
  const parent = parentId || 'root';
  const res = await drive.files.list({
    q: `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    orderBy: 'name',
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files || []).map(f => ({ id: f.id!, name: f.name! }));
}

/** Acha uma subpasta pelo nome dentro de um parent; retorna id ou null */
export async function findFolder(accountId: string, name: string, parentId: string): Promise<string | null> {
  const drive = await getDrive(accountId);
  const safe = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name = '${safe}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id || null;
}

/**
 * Acha uma subpasta cujo nome CONTÉM o termo (não precisa ser exato) dentro de
 * um parent — usado como fallback quando o nome exato não bate (ex.: colaborador
 * diz "leads ativos" e a pasta real é "1. LEADS ATIVOS"). Retorna null se não
 * achar nenhuma, ou se achar mais de uma (ambíguo — quem chamou decide o que fazer).
 */
export async function findFolderLoose(accountId: string, name: string, parentId: string): Promise<{ id: string; name: string } | null> {
  const drive = await getDrive(accountId);
  const safe = name.trim().replace(/'/g, "\\'");
  if (!safe) return null;
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name contains '${safe}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    pageSize: 5,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const files = res.data.files || [];
  if (files.length !== 1) return null; // 0 ou ambíguo (2+) — não arrisca escolher errado
  return { id: files[0].id!, name: files[0].name! };
}

/** Cria uma pasta (ou retorna a existente de mesmo nome) dentro de um parent */
export async function createFolder(accountId: string, name: string, parentId: string): Promise<{ id: string; name: string; existed: boolean }> {
  const existing = await findFolder(accountId, name, parentId);
  if (existing) return { id: existing, name, existed: true };
  const drive = await getDrive(accountId);
  const res = await drive.files.create({
    requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    fields: 'id, name',
    supportsAllDrives: true,
  });
  return { id: res.data.id!, name: res.data.name!, existed: false };
}

/** Sobe um arquivo (buffer) para uma pasta */
export async function uploadFile(accountId: string, params: {
  name: string; mimeType: string; data: Buffer; parentId: string;
}): Promise<{ id: string; name: string; webViewLink: string | null }> {
  const drive = await getDrive(accountId);
  const res = await drive.files.create({
    requestBody: { name: params.name, parents: [params.parentId] },
    media: { mimeType: params.mimeType, body: Readable.from(params.data) },
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,
  });
  return { id: res.data.id!, name: res.data.name!, webViewLink: res.data.webViewLink || null };
}

/** Renomeia um arquivo/pasta */
export async function renameFile(accountId: string, fileId: string, newName: string) {
  const drive = await getDrive(accountId);
  await drive.files.update({ fileId, requestBody: { name: newName }, supportsAllDrives: true });
}

export function folderLink(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

// ─── Base de conhecimento (leitura de documentos da pasta) ──────────────────

/** Tipos de arquivo que sabemos ler para a base de conhecimento. */
export const KNOWLEDGE_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc (legado)
  'application/vnd.google-apps.document', // Google Docs
] as const;

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string | null;
}

/** Lista os arquivos (Word/PDF/Google Docs) dentro de uma pasta do Drive. */
export async function listKnowledgeFiles(accountId: string, folderId: string): Promise<DriveFileMeta[]> {
  const drive = await getDrive(accountId);
  const mimeQ = KNOWLEDGE_MIME_TYPES.map(m => `mimeType = '${m}'`).join(' or ');
  const res = await drive.files.list({
    q: `'${folderId}' in parents and (${mimeQ}) and trashed = false`,
    fields: 'files(id, name, mimeType, modifiedTime)',
    orderBy: 'name',
    pageSize: 500,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files || []).map(f => ({
    id: f.id!, name: f.name!, mimeType: f.mimeType!, modifiedTime: f.modifiedTime || null,
  }));
}

/** Baixa o conteúdo de um arquivo do Drive como Buffer (Google Docs são exportados como texto). */
export async function downloadDriveFile(accountId: string, fileId: string, mimeType: string): Promise<Buffer> {
  const drive = await getDrive(accountId);
  if (mimeType === 'application/vnd.google-apps.document') {
    const res = await drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'arraybuffer' },
    );
    return Buffer.from(res.data as ArrayBuffer);
  }
  const res = await drive.files.get(
    { fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'arraybuffer' },
  );
  return Buffer.from(res.data as ArrayBuffer);
}

/**
 * OCR de um PDF/imagem via Google Drive: copia o arquivo como Google Doc (o Drive
 * roda OCR na conversão), lê o texto e apaga a cópia temporária. Reaproveita a
 * conexão do Drive — sem serviço nem custo extra de OCR.
 */
export async function ocrDriveFileToText(accountId: string, fileId: string): Promise<string> {
  const drive = await getDrive(accountId);
  let tempDocId: string | undefined;
  try {
    const copy = await drive.files.copy({
      fileId,
      requestBody: { name: `__ocr_tmp_${Date.now()}`, mimeType: 'application/vnd.google-apps.document' },
      ocrLanguage: 'pt',
      supportsAllDrives: true,
    });
    tempDocId = copy.data.id || undefined;
    if (!tempDocId) return '';
    const exported = await drive.files.export(
      { fileId: tempDocId, mimeType: 'text/plain' },
      { responseType: 'arraybuffer' },
    );
    return Buffer.from(exported.data as ArrayBuffer).toString('utf-8').trim();
  } finally {
    if (tempDocId) await drive.files.delete({ fileId: tempDocId, supportsAllDrives: true }).catch(() => {});
  }
}

/**
 * Cria (ou reutiliza) a pasta do cliente dentro da pasta-raiz e sobe todos os
 * documentos capturados do lead que ainda não foram enviados. Retorna o link
 * da pasta e a lista de arquivos enviados.
 */
export async function organizeLeadDocsToDrive(params: {
  accountId: string;
  leadId: string;
  clientFolderName: string;
  /** sub-pasta dentro da raiz onde criar a pasta do cliente (ex: "LEADS ATIVOS"); opcional */
  destinationFolderName?: string;
}): Promise<{ folderId: string; folderName: string; folderUrl: string; parentFolderName: string; uploaded: string[]; alreadyThere: number; noRoot?: boolean }> {
  const { accountId, leadId, clientFolderName, destinationFolderName } = params;

  const conn = await prisma.googleConnection.findUnique({ where: { accountId } });
  if (!conn?.refreshToken) throw new Error('Google Drive não conectado');
  if (!conn.rootFolderId) return { folderId: '', folderName: '', folderUrl: '', parentFolderName: '', uploaded: [], alreadyThere: 0, noRoot: true };

  // define onde a pasta do cliente será criada: raiz ou uma sub-pasta (ex: "LEADS ATIVOS")
  let parentId = conn.rootFolderId;
  let parentFolderName = conn.rootFolderName || 'raiz';
  const dest = destinationFolderName?.trim();
  if (dest) {
    const destFolder = await createFolder(accountId, dest, conn.rootFolderId);
    parentId = destFolder.id;
    parentFolderName = destFolder.name;
  }

  // pasta do cliente dentro do destino
  const folder = await createFolder(accountId, clientFolderName.trim(), parentId);

  // anexos do lead ainda não enviados (com bytes)
  const attachments = await prisma.messageAttachment.findMany({
    where: { leadId, driveFileId: null, NOT: { data: null } },
    orderBy: { createdAt: 'asc' },
  });

  const uploaded: string[] = [];
  for (const att of attachments) {
    if (!att.data) continue;
    const up = await uploadFile(accountId, {
      name: att.fileName,
      mimeType: att.mimeType,
      data: Buffer.from(att.data),
      parentId: folder.id,
    });
    // marca como enviado e limpa os bytes do banco (economia de espaço)
    await prisma.messageAttachment.update({
      where: { id: att.id },
      data: { driveFileId: up.id, data: null },
    });
    uploaded.push(att.fileName);
  }

  const alreadyThere = await prisma.messageAttachment.count({ where: { leadId, NOT: { driveFileId: null } } });

  return {
    folderId: folder.id,
    folderName: folder.name,
    folderUrl: folderLink(folder.id),
    parentFolderName,
    uploaded,
    alreadyThere: alreadyThere - uploaded.length,
  };
}

/**
 * Sobe UM anexo (já salvo com bytes) direto para a pasta do cliente no Drive e
 * limpa os bytes do banco. Chamado em segundo plano assim que um anexo do
 * WhatsApp chega/é enviado — evita acumular peso no Postgres (foi a causa do
 * disco cheio em 2026-08-05). Se o Drive não estiver configurado (sem conexão
 * ou sem pasta-raiz), não faz nada — o anexo fica no banco como antes, e
 * alguém organiza manualmente depois (botão/assistente).
 */
/** Pasta técnica onde TODO anexo de WhatsApp é guardado (auto-upload e
 *  arquivamento periódico usam a mesma). Fica separada de propósito: a
 *  organização manual do usuário na pasta-raiz (ex.: "1. LEADS ATIVOS",
 *  "3. CONCLUIDOS") nunca deve ser poluída com uma pasta por cliente. */
const WHATSAPP_ARCHIVE_FOLDER = 'WhatsApp — arquivo automático';

export async function autoUploadAttachmentToDrive(accountId: string, leadId: string, attachmentId: string): Promise<void> {
  const conn = await prisma.googleConnection.findUnique({ where: { accountId } });
  if (!conn?.refreshToken || !conn.rootFolderId) return;

  const [att, lead] = await Promise.all([
    prisma.messageAttachment.findUnique({ where: { id: attachmentId } }),
    prisma.lead.findUnique({ where: { id: leadId }, select: { name: true } }),
  ]);
  if (!att || !att.data || att.driveFileId) return;

  // Dentro da pasta técnica, uma subpasta por cliente. Antes isso criava a
  // pasta do cliente DIRETO na raiz, misturando centenas de pastas com a
  // organização manual do usuário — nunca chegou a rodar em produção assim.
  const archiveRoot = await createFolder(accountId, WHATSAPP_ARCHIVE_FOLDER, conn.rootFolderId);
  const folder = await createFolder(accountId, (lead?.name || 'Sem nome').trim() || 'Sem nome', archiveRoot.id);
  const up = await uploadFile(accountId, {
    name: att.fileName,
    mimeType: att.mimeType,
    data: Buffer.from(att.data),
    parentId: folder.id,
  });
  await prisma.messageAttachment.update({
    where: { id: att.id },
    data: { driveFileId: up.id, data: null },
  });
}

/**
 * Limpeza única: sobe para o Drive todos os anexos antigos que ainda estão com
 * bytes guardados no banco (de antes do auto-upload existir), agrupados por
 * cliente. Usado para liberar espaço do Postgres de uma vez.
 */
export async function bulkArchiveOldAttachments(accountId: string): Promise<{ archived: number; errors: number; leads: number }> {
  const conn = await prisma.googleConnection.findUnique({ where: { accountId } });
  if (!conn?.refreshToken || !conn.rootFolderId) throw new Error('Conecte o Google Drive e escolha a pasta-raiz primeiro');

  const attachments = await prisma.messageAttachment.findMany({
    where: { driveFileId: null, NOT: { data: null } },
    orderBy: { createdAt: 'asc' },
  });
  const leadIds = [...new Set(attachments.map(a => a.leadId))];
  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true } });
  const leadNames = new Map(leads.map(l => [l.id, l.name]));

  const byLead = new Map<string, { name: string; items: typeof attachments }>();
  for (const att of attachments) {
    const name = leadNames.get(att.leadId);
    if (!name) continue; // lead pode ter sido excluído
    if (!byLead.has(att.leadId)) byLead.set(att.leadId, { name, items: [] as any });
    byLead.get(att.leadId)!.items.push(att);
  }

  let archived = 0;
  let errors = 0;
  for (const [, group] of byLead) {
    try {
      const folder = await createFolder(accountId, (group.name || 'Sem nome').trim() || 'Sem nome', conn.rootFolderId);
      for (const att of group.items) {
        if (!att.data) continue;
        try {
          const up = await uploadFile(accountId, {
            name: att.fileName, mimeType: att.mimeType, data: Buffer.from(att.data), parentId: folder.id,
          });
          await prisma.messageAttachment.update({ where: { id: att.id }, data: { driveFileId: up.id, data: null } });
          archived++;
        } catch {
          errors++;
        }
      }
    } catch {
      errors += group.items.length;
    }
  }

  return { archived, errors, leads: byLead.size };
}

/**
 * Arquivamento automático de anexos ANTIGOS (padrão: 30+ dias) — roda sozinho em
 * segundo plano para o Postgres não encher de novo (ver incidente 2026-08-05),
 * mas sem mexer nas pastas organizadas pelo usuário: tudo cai numa pasta técnica
 * própria ("WhatsApp — arquivo automático"), separada da estrutura de clientes.
 * Anexos recentes ficam no CRM (com miniatura) até o usuário organizar manualmente.
 */
export async function archiveOldAttachmentsAutomatic(accountId: string, olderThanDays = 2): Promise<{ archived: number; errors: number }> {
  const conn = await prisma.googleConnection.findUnique({ where: { accountId } });
  if (!conn?.refreshToken || !conn.rootFolderId) return { archived: 0, errors: 0 };

  // Janela curta (2 dias, era 30) porque agora o anexo sobe pro Drive JÁ na
  // chegada/envio. Se depois de 2 dias ainda tem bytes no banco, foi upload que
  // falhou (ou anexo de antes desta mudança) — é exatamente o que essa rede de
  // segurança tem que recolher, não algo pra segurar por um mês. Segurar 30 dias
  // foi o que deixou o disco encher duas vezes.
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  // Sem `data` aqui de propósito: carregar os bytes de 200 anexos de uma vez
  // estourava a memória do container (arquivo grande × 200) e o arquivamento
  // simplesmente não rodava — justo quando o disco mais precisava dele. Os bytes
  // são lidos um a um dentro do laço.
  const attachments = await prisma.messageAttachment.findMany({
    where: { driveFileId: null, NOT: { data: null }, createdAt: { lt: cutoff } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, leadId: true, fileName: true, mimeType: true },
    take: 200, // por execução — evita rodadas gigantes de uma vez
  });
  if (!attachments.length) return { archived: 0, errors: 0 };

  const leadIds = [...new Set(attachments.map(a => a.leadId))];
  const leads = await prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true } });
  const leadNames = new Map(leads.map(l => [l.id, l.name]));

  const techFolder = await createFolder(accountId, WHATSAPP_ARCHIVE_FOLDER, conn.rootFolderId);
  // Subpasta por cliente, MESMA estrutura do auto-upload (autoUploadAttachment
  // ToDrive) — os dois caminhos escrevem na mesma pasta técnica, então tinham
  // que concordar. Antes aqui era arquivo solto com o nome do cliente no
  // prefixo, e lá era subpasta: a pasta técnica ficava com os dois formatos
  // misturados. Cache por lead pra não repetir a busca de pasta no Drive a
  // cada anexo do mesmo cliente dentro da mesma rodada.
  const leadFolderIds = new Map<string, string>();
  async function folderForLead(leadId: string, leadName: string): Promise<string> {
    const cached = leadFolderIds.get(leadId);
    if (cached) return cached;
    const f = await createFolder(accountId, leadName, techFolder.id);
    leadFolderIds.set(leadId, f.id);
    return f.id;
  }

  let archived = 0;
  let errors = 0;
  for (const att of attachments) {
    try {
      const leadName = (leadNames.get(att.leadId) || 'Sem nome').trim() || 'Sem nome';
      // Lê os bytes só deste anexo, agora — mantém a memória constante por
      // rodada, independente do tamanho do lote.
      const withData = await prisma.messageAttachment.findUnique({
        where: { id: att.id },
        select: { data: true },
      });
      if (!withData?.data) continue; // já foi arquivado por outro caminho nesse meio-tempo
      const up = await uploadFile(accountId, {
        name: att.fileName,
        mimeType: att.mimeType,
        data: Buffer.from(withData.data),
        parentId: await folderForLead(att.leadId, leadName),
      });
      await prisma.messageAttachment.update({ where: { id: att.id }, data: { driveFileId: up.id, data: null } });
      archived++;
    } catch (err) {
      errors++;
      console.error('[Drive] Arquivamento automático falhou:', (err as any)?.message);
    }
  }

  return { archived, errors };
}

/** Roda o arquivamento automático (2+ dias) para TODAS as contas com Drive conectado. */
export async function archiveOldAttachmentsAllAccounts(): Promise<void> {
  const conns = await prisma.googleConnection.findMany({
    where: { rootFolderId: { not: null } },
    select: { accountId: true },
  });
  for (const conn of conns) {
    try {
      const result = await archiveOldAttachmentsAutomatic(conn.accountId);
      if (result.archived > 0 || result.errors > 0) {
        console.log(`[Drive] Arquivamento automático accountId=${conn.accountId}: ${result.archived} arquivados, ${result.errors} erros`);
      }
    } catch (err) {
      console.error(`[Drive] Arquivamento automático falhou para accountId=${conn.accountId}:`, (err as any)?.message);
    }
  }
}

// ─── Navegação/gestão geral do Drive (usado pelo assistente de chat) ────────

/**
 * Acha uma pasta pelo nome dentro da pasta-raiz configurada — direto na raiz,
 * ou dentro de UMA sub-pasta dela (ex: "LEADS ATIVOS"), que é onde
 * organizeLeadDocsToDrive costuma criar as pastas de cliente. Não cria nada,
 * só procura. Serve tanto para achar "a pasta do cliente Fulano" quanto
 * qualquer outra pasta pelo nome (ex: "LEADS ATIVOS" em si).
 */
export async function findFolderByNameUnderRoot(accountId: string, name: string): Promise<{ folderId: string; path: string } | null> {
  const conn = await prisma.googleConnection.findUnique({ where: { accountId } });
  if (!conn?.rootFolderId) return null;

  const trimmed = name.trim();
  if (!trimmed) return null;

  const direct = await findFolder(accountId, trimmed, conn.rootFolderId);
  if (direct) return { folderId: direct, path: conn.rootFolderName || 'raiz' };

  const subfolders = await listFolders(accountId, conn.rootFolderId);
  for (const sub of subfolders) {
    const found = await findFolder(accountId, trimmed, sub.id);
    if (found) return { folderId: found, path: sub.name };
  }

  // Nome exato não bateu em lugar nenhum — tenta um nome PARECIDO (ex.: o
  // colaborador diz "leads ativos" e a pasta real é "1. LEADS ATIVOS"),
  // primeiro na raiz, depois dentro de cada sub-pasta já listada acima.
  const looseDirect = await findFolderLoose(accountId, trimmed, conn.rootFolderId);
  if (looseDirect) return { folderId: looseDirect.id, path: conn.rootFolderName || 'raiz' };

  for (const sub of subfolders) {
    const found = await findFolderLoose(accountId, trimmed, sub.id);
    if (found) return { folderId: found.id, path: sub.name };
  }

  return null;
}

export interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  isFolder: boolean;
  modifiedTime?: string;
  link: string;
}

/** Lista TODO o conteúdo (arquivos e sub-pastas) de uma pasta do Drive, por ID. */
export async function listFolderContents(accountId: string, folderId: string): Promise<DriveItem[]> {
  const drive = await getDrive(accountId);
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, mimeType, modifiedTime)',
    orderBy: 'folder,name',
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return (res.data.files || []).map((f) => {
    const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
    return {
      id: f.id!,
      name: f.name!,
      mimeType: f.mimeType!,
      isFolder,
      modifiedTime: f.modifiedTime || undefined,
      link: isFolder ? folderLink(f.id!) : `https://drive.google.com/file/d/${f.id}/view`,
    };
  });
}

/** Busca um ARQUIVO (não pasta) pelo nome dentro de uma pasta e de todas as
 *  suas sub-pastas, até uma profundidade máxima — cobre o caso comum de o
 *  cliente ter uma subpasta temática (ex.: "ITBI", "COMPROVANTES") dentro da
 *  própria pasta, onde uma busca só no nível direto não encontraria nada.
 *  Retorna todos os arquivos cujo nome contém o termo, com o caminho (path)
 *  de sub-pastas percorrido, para o chamador poder desambiguar se achar mais de um. */
export async function findFilesInFolderTree(
  accountId: string,
  rootFolderId: string,
  nameQuery: string,
  maxDepth = 3
): Promise<{ id: string; name: string; mimeType: string; path: string }[]> {
  const drive = await getDrive(accountId);
  const query = nameQuery.trim().toLowerCase();
  const results: { id: string; name: string; mimeType: string; path: string }[] = [];

  async function walk(folderId: string, path: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType)',
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const files = res.data.files || [];
    for (const f of files) {
      const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
      if (isFolder) {
        await walk(f.id!, path ? `${path} > ${f.name}` : f.name!, depth + 1);
      } else if (query && f.name!.toLowerCase().includes(query)) {
        results.push({ id: f.id!, name: f.name!, mimeType: f.mimeType!, path });
      }
    }
  }

  await walk(rootFolderId, '', 0);
  return results;
}

/** Lista TODOS os arquivos (sem filtro de nome) dentro de uma pasta e de todas
 *  as suas sub-pastas, com o tamanho em bytes de cada um — usado para conferir
 *  o cadastro de um cliente contra tudo que tem na pasta dele no Drive, sem
 *  saber de antemão como os documentos foram nomeados/organizados. */
export async function listAllFilesInFolderTree(
  accountId: string,
  rootFolderId: string,
  maxDepth = 3
): Promise<{ id: string; name: string; mimeType: string; path: string; size: number }[]> {
  const drive = await getDrive(accountId);
  const results: { id: string; name: string; mimeType: string; path: string; size: number }[] = [];

  async function walk(folderId: string, path: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, size)',
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const files = res.data.files || [];
    for (const f of files) {
      const isFolder = f.mimeType === 'application/vnd.google-apps.folder';
      if (isFolder) {
        await walk(f.id!, path ? `${path} > ${f.name}` : f.name!, depth + 1);
      } else {
        results.push({ id: f.id!, name: f.name!, mimeType: f.mimeType!, path, size: Number(f.size) || 0 });
      }
    }
  }

  await walk(rootFolderId, '', 0);
  return results;
}

/** Busca VÁRIAS pastas (não arquivos) por nome EXATO em toda a árvore a partir
 *  de um folder raiz, numa ÚNICA varredura (com os irmãos de cada nível
 *  buscados em paralelo) — usado para auditar se as pastas de vários clientes
 *  estão no lugar certo, sem repetir uma varredura da árvore inteira por
 *  cliente (isso era lento demais: uma conta com anos de "CONCLUIDOS" tem
 *  centenas de sub-pastas, e antes cada lead pagava esse custo sozinho).
 *  Retorna um Map (nome em minúsculas → lista de {id, path}), só com os nomes
 *  que foram encontrados. Nome exato (não "contains") para não confundir
 *  pastas de clientes com nomes parecidos entre si. */
export async function findFoldersByNamesInTree(
  accountId: string,
  rootFolderId: string,
  names: string[],
  maxDepth = 4
): Promise<Map<string, { id: string; path: string }[]>> {
  const drive = await getDrive(accountId);
  const targets = new Set(names.map((n) => n.trim().toLowerCase()).filter(Boolean));
  const results = new Map<string, { id: string; path: string }[]>();

  async function walk(folderId: string, path: string, depth: number): Promise<void> {
    if (depth > maxDepth || targets.size === 0) return;
    const res = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const folders = res.data.files || [];
    const descidas: Promise<void>[] = [];
    for (const f of folders) {
      const folderPath = path ? `${path} > ${f.name}` : f.name!;
      const key = f.name!.trim().toLowerCase();
      if (targets.has(key)) {
        const arr = results.get(key) || [];
        arr.push({ id: f.id!, path: folderPath });
        results.set(key, arr);
        continue; // não desce dentro da pasta do próprio cliente encontrada
      }
      descidas.push(walk(f.id!, folderPath, depth + 1));
    }
    await Promise.all(descidas); // busca os irmãos deste nível em paralelo, não um de cada vez
  }

  await walk(rootFolderId, '', 0);
  return results;
}

/** Move um arquivo/pasta do Drive para outro pai (outra pasta), por ID. */
export async function moveDriveItem(accountId: string, itemId: string, newParentId: string): Promise<{ id: string; name: string }> {
  const drive = await getDrive(accountId);
  const current = await drive.files.get({ fileId: itemId, fields: 'parents', supportsAllDrives: true });
  const removeParents = (current.data.parents || []).join(',');
  const res = await drive.files.update({
    fileId: itemId,
    addParents: newParentId,
    ...(removeParents ? { removeParents } : {}),
    fields: 'id, name',
    supportsAllDrives: true,
  });
  return { id: res.data.id!, name: res.data.name! };
}

/** Move um arquivo/pasta do Drive para a lixeira (o CRM trata como irreversível,
 *  mesmo que o Google mantenha por ~30 dias — exige dupla confirmação no chat). */
export async function trashDriveItem(accountId: string, itemId: string): Promise<{ id: string; name: string }> {
  const drive = await getDrive(accountId);
  const res = await drive.files.update({
    fileId: itemId,
    requestBody: { trashed: true },
    fields: 'id, name',
    supportsAllDrives: true,
  });
  return { id: res.data.id!, name: res.data.name! };
}
