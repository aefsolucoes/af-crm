import { create } from 'zustand';
import api from '@/lib/api';
import { User } from '@/types';

export type BackgroundTheme = 'white' | 'black' | 'blue';

const DEFAULT_OPACITY = 85;

function applyTheme(theme: BackgroundTheme) {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

function applyBgImage(url: string | null | undefined) {
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--app-bg-image', url ? `url("${url}")` : 'none');
  }
}

function applySurfaceOpacity(opacity: number) {
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--app-surface-alpha', String(opacity / 100));
  }
}

/** Atualiza os campos de tema dentro do usuário salvo em localStorage (af_user),
 *  para refletir imediatamente sem esperar a resposta do servidor. */
function patchCachedUser(patch: Partial<Pick<User, 'themeColor' | 'themeImage' | 'themeOpacity'>>) {
  if (typeof window === 'undefined') return;
  const raw = localStorage.getItem('af_user');
  if (!raw) return;
  try {
    const user = JSON.parse(raw);
    localStorage.setItem('af_user', JSON.stringify({ ...user, ...patch }));
  } catch { /* ignora */ }
}

interface ThemeState {
  theme: BackgroundTheme;
  bgImage: string | null;
  surfaceOpacity: number;
  setTheme: (theme: BackgroundTheme) => void;
  setBgImage: (url: string | null) => void;
  setSurfaceOpacity: (opacity: number) => void;
  /** Aplica e sincroniza o tema com o usuário atualmente logado (chamado no login e no boot do app). */
  loadForUser: (user: User | null) => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: 'white',
  bgImage: null,
  surfaceOpacity: DEFAULT_OPACITY,

  setTheme: (theme) => {
    applyTheme(theme);
    patchCachedUser({ themeColor: theme });
    set({ theme });
    api.patch('/api/users/me/theme', { themeColor: theme }).catch(() => {});
  },

  setBgImage: (url) => {
    applyBgImage(url);
    patchCachedUser({ themeImage: url });
    set({ bgImage: url });
    api.patch('/api/users/me/theme', { themeImage: url }).catch(() => {});
  },

  setSurfaceOpacity: (opacity) => {
    applySurfaceOpacity(opacity);
    patchCachedUser({ themeOpacity: opacity });
    set({ surfaceOpacity: opacity });
    api.patch('/api/users/me/theme', { themeOpacity: opacity }).catch(() => {});
  },

  loadForUser: (user) => {
    const theme = (user?.themeColor as BackgroundTheme) || 'white';
    const bgImage = user?.themeImage ?? null;
    const surfaceOpacity = user?.themeOpacity ?? DEFAULT_OPACITY;
    applyTheme(theme);
    applyBgImage(bgImage);
    applySurfaceOpacity(surfaceOpacity);
    set({ theme, bgImage, surfaceOpacity });
  },
}));
