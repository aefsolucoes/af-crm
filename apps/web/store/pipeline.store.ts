import { create } from 'zustand';
import { Lead } from '@/types';

interface PipelineState {
  leads: Lead[];
  setLeads: (leads: Lead[]) => void;
  moveLeadOptimistic: (leadId: string, newStageId: string) => void;
}

export const usePipelineStore = create<PipelineState>((set) => ({
  leads: [],
  setLeads: (leads) => set({ leads }),
  moveLeadOptimistic: (leadId, newStageId) =>
    set((state) => ({
      leads: state.leads.map((l) => (l.id === leadId ? { ...l, stageId: newStageId } : l)),
    })),
}));
