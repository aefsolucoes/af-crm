import { create } from 'zustand';

/** Texto que um painel do card (ex.: "Custas" da aba Financiamento) manda pro campo de mensagem da conversa aberta — a equipe revisa e envia. */
type Draft = { leadId: string; text: string; at: number };

export const useComposerDraft = create<{ draft: Draft | null; setDraft: (leadId: string, text: string) => void; clear: () => void }>((set) => ({
  draft: null,
  setDraft: (leadId, text) => set({ draft: { leadId, text, at: Date.now() } }),
  clear: () => set({ draft: null }),
}));
