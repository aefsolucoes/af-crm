import { create } from 'zustand';

export type BackgroundTheme = 'white' | 'black' | 'blue';

const STORAGE_KEY = 'af_background_theme';
const IMAGE_STORAGE_KEY = 'af_background_image';

function applyTheme(theme: BackgroundTheme) {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

function applyBgImage(url: string | null) {
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--app-bg-image', url ? `url("${url}")` : 'none');
  }
}

interface ThemeState {
  theme: BackgroundTheme;
  bgImage: string | null;
  setTheme: (theme: BackgroundTheme) => void;
  setBgImage: (url: string | null) => void;
  init: () => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: 'white',
  bgImage: null,
  setTheme: (theme) => {
    localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
  setBgImage: (url) => {
    if (url) localStorage.setItem(IMAGE_STORAGE_KEY, url);
    else localStorage.removeItem(IMAGE_STORAGE_KEY);
    applyBgImage(url);
    set({ bgImage: url });
  },
  init: () => {
    if (typeof window === 'undefined') return;
    const saved = (localStorage.getItem(STORAGE_KEY) as BackgroundTheme) || 'white';
    const savedImage = localStorage.getItem(IMAGE_STORAGE_KEY);
    applyTheme(saved);
    applyBgImage(savedImage);
    set({ theme: saved, bgImage: savedImage });
  },
}));
