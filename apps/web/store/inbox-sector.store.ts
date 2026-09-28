import { create } from 'zustand';

/** Aba de funil da Inbox escolhida no menu lateral ('all' | id do setor |
 *  'none' = Caixa de Entrada). A Inbox lê do endereço (?setor=) e grava aqui
 *  pro menu saber qual subitem destacar. */
interface InboxSectorState {
  sector: string;
  setSector: (sector: string) => void;
}

export const useInboxSectorStore = create<InboxSectorState>((set) => ({
  sector: 'all',
  setSector: (sector) => set({ sector }),
}));

export interface InboxSector { key: string; label: string; unread: number }
