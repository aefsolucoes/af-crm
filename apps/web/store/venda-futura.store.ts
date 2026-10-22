import { create } from 'zustand';

/** Pedido pra abrir a janela "Quando retomar o contato?" da Venda Futura (Fabio 22/10: poder marcar a data À MÃO ao mover um card pra Venda Futura). */
export interface VendaFuturaRequest {
  leadId: string;
  leadName: string;
  /** Data já marcada (AAAA-MM-DD), se houver. */
  current?: string | null;
  /** IA do card ligada? Desligada = no dia a equipe só recebe o aviso, a mensagem não vai sozinha. */
  aiOn?: boolean;
}

interface VendaFuturaState {
  request: VendaFuturaRequest | null;
  ask: (r: VendaFuturaRequest) => void;
  close: () => void;
}

export const useVendaFuturaStore = create<VendaFuturaState>((set) => ({
  request: null,
  ask: (request) => set({ request }),
  close: () => set({ request: null }),
}));

export const isVendaFuturaStage = (name?: string | null) => /venda futura/i.test(name || '');
export const askVendaFuturaDate = (r: VendaFuturaRequest) => useVendaFuturaStore.getState().ask(r);
