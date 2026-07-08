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
