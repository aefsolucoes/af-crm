import { create } from 'zustand';

/** Setor aberto no Funil de Vendas (nome, ex.: "Home Equity" ou "Caixa de
 *  Entrada") — o Funil grava aqui pro menu lateral destacar o subitem certo. */
interface FunilSectorState {
  department: string;
  setDepartment: (name: string) => void;
}

export const useFunilSectorStore = create<FunilSectorState>((set) => ({
  department: '',
  setDepartment: (department) => set({ department }),
}));
