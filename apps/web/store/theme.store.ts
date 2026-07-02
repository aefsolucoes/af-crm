import { create } from 'zustand';

export type BackgroundTheme = 'white' | 'black' | 'blue';

const STORAGE_KEY = 'af_background_theme';
const IMAGE_STORAGE_KEY = 'af_background_image';
const OPACITY_STORAGE_KEY = 'af_surface_opacity';
const DEFAULT_OPACITY = 85;

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

function applySurfaceOpacity(opacity: number) {
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--app-surface-alpha', String(opacity / 100));
  }
}

interface ThemeState {
  theme: BackgroundTheme;
  bgImage: string | null;
  surfaceOpacity: number;
  setTheme: (theme: BackgroundTheme) => void;
  setBgImage: (url: string | null) => void;
  setSurfaceOpacity: (opacity: number) => void;
  init: () => void;
}

export const useThemeStore = create<ThemeState>((set) => ({
  theme: 'white',
  bgImage: null,
  surfaceOpacity: DEFAULT_OPACITY,
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
  setSurfaceOpacity: (opacity) => {
    localStorage.setItem(OPACITY_STORAGE_KEY, String(opacity));
    applySurfaceOpacity(opacity);
    set({ surfaceOpacity: opacity });
  },
  init: () => {
    if (typeof window === 'undefined') return;
    const saved = (localStorage.getItem(STORAGE_KEY) as BackgroundTheme) || 'white';
    const savedImage = localStorage.getItem(IMAGE_STORAGE_KEY);
    const savedOpacity = Number(localStorage.getItem(OPACITY_STORAGE_KEY)) || DEFAULT_OPACITY;
    applyTheme(saved);
    applyBgImage(savedImage);
    applySurfaceOpacity(savedOpacity);
    set({ theme: saved, bgImage: savedImage, surfaceOpacity: savedOpacity });
  },
}));
