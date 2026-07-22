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
