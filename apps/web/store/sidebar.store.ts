import { create } from 'zustand';

const STORAGE_KEY = 'af_sidebar_collapsed';

interface SidebarState {
  collapsed: boolean;
  toggle: () => void;
  init: () => void;
}

export const useSidebarStore = create<SidebarState>((set, get) => ({
  collapsed: false,
  toggle: () => {
    const next = !get().collapsed;
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
    set({ collapsed: next });
  },
  init: () => {
    if (typeof window === 'undefined') return;
    const saved = localStorage.getItem(STORAGE_KEY) === '1';
    set({ collapsed: saved });
  },
}));
