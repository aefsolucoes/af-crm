import axios from 'axios';
import { loginUrlWithNext } from './login-redirect';

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
        const { data } = await axios.post(`${process.env.NEXT_PUBLIC_API_URL || ''}/api/auth/refresh`, { refreshToken });
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
  baseURL: process.env.NEXT_PUBLIC_API_URL || '',
  withCredentials: false,
});

api.interceptors.request.use((config) => {
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
