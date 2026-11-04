import axios from 'axios';
import { loginUrlWithNext } from './login-redirect';
import { apiBase, firstProbe, probeApiBase } from './api-base';

/** Renova o token de acesso com o refresh token (na API, mesmo baseURL das demais chamadas — antes ia para /api/auth/refresh relativo
 *  ao site e dava 404, derrubando a sessão após ~1h). Uma renovação por vez: chamadas simultâneas esperam a mesma. Usado também pelo
 *  socket, que é recusado pelo servidor quando o token venceu (Fabio 26/10: "as mensagens demoram para aparecer pra mim"). */
let refreshing: Promise<string | null> | null = null;
export function refreshAccessToken(): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (!refreshing) {
    refreshing = (async () => {
      const refreshToken = localStorage.getItem('af_refresh_token');
      if (!refreshToken) return null;
      try {
        if (firstProbe) await firstProbe;
        const { data } = await axios.post(`${apiBase()}/api/auth/refresh`, { refreshToken });
        if (!data?.accessToken) return null;
        localStorage.setItem('af_access_token', data.accessToken);
        if (data.refreshToken) localStorage.setItem('af_refresh_token', data.refreshToken);
        return data.accessToken as string;
      } catch { return null; }
    })().finally(() => { setTimeout(() => { refreshing = null; }, 0); });
  }
  return refreshing;
}

const api = axios.create({
  baseURL: apiBase(),
  withCredentials: false,
});

// Cada chamada sai pelo caminho que está respondendo agora (direto ou ponte — ver api-base.ts).
api.interceptors.request.use(async (config) => {
  if (firstProbe) await firstProbe;
  config.baseURL = apiBase();
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('af_access_token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    // Sem resposta nenhuma (caminho fora do ar): reconfere os caminhos; se trocou, repete a leitura pelo outro. Só GET/HEAD repetem
    // sozinhos — um POST pode ter chegado ao servidor antes da queda (ex.: mensagem ao cliente) e não pode sair duas vezes.
    if (original && !error.response && error.code !== 'ERR_CANCELED' && !original._baseRetry) {
      original._baseRetry = true;
      const before = original.baseURL;
      const now = await probeApiBase();
      if (now !== before && /^(get|head)$/i.test(original.method || 'get')) return api(original);
    }
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      try {
        const token = await refreshAccessToken();
        if (!token) throw new Error('no refresh');
        original.headers.Authorization = `Bearer ${token}`;
        return api(original);
      } catch {
        localStorage.removeItem('af_access_token');
        localStorage.removeItem('af_refresh_token');
        window.location.href = loginUrlWithNext();
      }
    }
    return Promise.reject(error);
  }
);

export default api;
