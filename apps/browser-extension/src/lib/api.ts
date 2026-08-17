// Autenticação da extensão — reaproveita 100% o login do CRM web (mesmas
// rotas /api/auth/*), sem nenhum mecanismo novo de API key. Tokens ficam em
// chrome.storage.local (equivalente ao localStorage do CRM web, mas
// acessível pelo service worker, que não tem DOM/localStorage).
import { API_URL } from './config';

export interface StoredUser {
  id: string;
  name: string;
  email: string;
  role: string;
  accountId: string;
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
}

const KEYS = {
  accessToken: 'af_access_token',
  refreshToken: 'af_refresh_token',
  user: 'af_user',
} as const;

export async function getStoredAuth(): Promise<(Tokens & { user: StoredUser }) | null> {
  const data = await chrome.storage.local.get([KEYS.accessToken, KEYS.refreshToken, KEYS.user]);
  const accessToken = data[KEYS.accessToken];
  const refreshToken = data[KEYS.refreshToken];
  const user = data[KEYS.user];
  if (!accessToken || !refreshToken || !user) return null;
  return { accessToken, refreshToken, user };
}

async function storeAuth(tokens: Tokens, user: StoredUser) {
  await chrome.storage.local.set({
    [KEYS.accessToken]: tokens.accessToken,
    [KEYS.refreshToken]: tokens.refreshToken,
    [KEYS.user]: user,
  });
}

export async function clearAuth() {
  await chrome.storage.local.remove([KEYS.accessToken, KEYS.refreshToken, KEYS.user]);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || `Erro ${res.status}`);
  return data as T;
}

/** 1ª etapa: e-mail + senha. Pode já entregar os tokens (se e-mail não
 *  configurado no CRM) ou pedir a 2ª etapa (código de 6 dígitos). */
export async function login(email: string, password: string): Promise<
  | { requiresCode: true; email: string }
  | { requiresCode: false; user: StoredUser }
> {
  const result = await postJson<
    { requiresCode: true; email: string } | { accessToken: string; refreshToken: string; user: StoredUser }
  >('/api/auth/login', { email, password });
  if ('requiresCode' in result) return result;
  await storeAuth({ accessToken: result.accessToken, refreshToken: result.refreshToken }, result.user);
  return { requiresCode: false, user: result.user };
}

/** 2ª etapa: código recebido por e-mail. */
export async function verifyCode(email: string, code: string): Promise<StoredUser> {
  const result = await postJson<{ accessToken: string; refreshToken: string; user: StoredUser }>(
    '/api/auth/verify-code',
    { email, code }
  );
  await storeAuth({ accessToken: result.accessToken, refreshToken: result.refreshToken }, result.user);
  return result.user;
}

/** Renova o access token (1h) usando o refresh token (7d) guardado. Devolve
 *  o novo access token, ou null se o refresh também expirou/é inválido —
 *  nesse caso é preciso logar de novo. */
export async function refreshAccessToken(): Promise<string | null> {
  const auth = await getStoredAuth();
  if (!auth) return null;
  try {
    const { accessToken } = await postJson<{ accessToken: string }>('/api/auth/refresh', {
      refreshToken: auth.refreshToken,
    });
    await chrome.storage.local.set({ [KEYS.accessToken]: accessToken });
    return accessToken;
  } catch {
    await clearAuth();
    return null;
  }
}
