import { create } from 'zustand';

/** Aviso do CRM antes do pedido de localização do aparelho (Fabio 28/10): explica o que é, pra ninguém tocar em "Não Permitir" por susto. */
interface SendLocationNoticeState {
  open: boolean;
  resolve: (() => void) | null;
  ask: () => Promise<void>;
  done: () => void;
}

export const useSendLocationNoticeStore = create<SendLocationNoticeState>((set, get) => ({
  open: false,
  resolve: null,
  ask: () => new Promise<void>((resolve) => set({ open: true, resolve })),
  done: () => {
    get().resolve?.();
    set({ open: false, resolve: null });
  },
}));
