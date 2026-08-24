import { create } from 'zustand';
import { User } from '@/types';
import { useThemeStore } from './theme.store';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  setAuth: (user: User, accessToken: string, refreshToken: string) => void;
  logout: () => void;
  init: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  refreshToken: null,
  setAuth: (user, accessToken, refreshToken) => {
    localStorage.setItem('af_access_token', accessToken);
    localStorage.setItem('af_refresh_token', refreshToken);
    localStorage.setItem('af_user', JSON.stringify(user));
    set({ user, accessToken, refreshToken });
    useThemeStore.getState().loadForUser(user);
  },
  logout: () => {
    localStorage.removeItem('af_access_token');
    localStorage.removeItem('af_refresh_token');
    localStorage.removeItem('af_user');
    set({ user: null, accessToken: null, refreshToken: null });
    useThemeStore.getState().loadForUser(null);
    // Defesa em profundidade pro PWA: o Service Worker (public/sw.js) já
    // nunca cacheia /api/*, mas isso fecha o cenário "conta A loga, conta B
    // loga no mesmo aparelho" sem depender só da disciplina do fetch
    // handler. Não desregistra o SW — ele não guarda dado de conta nenhuma,
    // só o app-shell, útil pra quem logar em seguida no mesmo aparelho.
    if (typeof window !== 'undefined' && 'caches' in window) {
      caches.keys().then((names) => names.forEach((n) => caches.delete(n))).catch(() => {});
    }
  },
  init: () => {
    if (typeof window === 'undefined') return;
    const token = localStorage.getItem('af_access_token');
    const refresh = localStorage.getItem('af_refresh_token');
    const userStr = localStorage.getItem('af_user');
    if (token && userStr) {
      const user = JSON.parse(userStr);
      set({ accessToken: token, refreshToken: refresh, user });
      useThemeStore.getState().loadForUser(user);
    }
  },
}));
