'use client';
import { useState, useEffect, useCallback } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { AlertTriangle, Check, GitMerge, Loader2, Crown } from 'lucide-react';

interface DupLead {
  id: string;
  name: string;
  phone?: string | null;
  pipeline?: string | null;
  stage?: string | null;
  value?: number | null;
  messages: number;
  createdAt: string;
}
interface DupGroup {
  leads: DupLead[];
}

interface DuplicatesModalProps {
  open: boolean;
  onClose: () => void;
  onMerged: () => void;
}

export function DuplicatesModal({ open, onClose, onMerged }: DuplicatesModalProps) {
  const [groups, setGroups] = useState<DupGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [keepById, setKeepById] = useState<Record<number, string>>({});
  const [mergingIdx, setMergingIdx] = useState<number | null>(null);
  const [mergingAll, setMergingAll] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api.get('/api/leads/duplicate-groups')
      .then(({ data }) => {
        const gs: DupGroup[] = data.groups || [];
        setGroups(gs);
        // por padrão mantém o primeiro (melhor candidato) de cada grupo
        const keep: Record<number, string> = {};
        gs.forEach((g, i) => { keep[i] = g.leads[0]?.id; });
        setKeepById(keep);
      })
      .catch(() => toast('Erro ao buscar duplicados', 'error'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  /** Junta um grupo: move todos os outros para o lead escolhido (keep). */
  async function mergeGroup(groupIdx: number): Promise<boolean> {
    const group = groups[groupIdx];
    const keepId = keepById[groupIdx] || group.leads[0].id;
    const sources = group.leads.filter((l) => l.id !== keepId);
    try {
      for (const s of sources) {
        await api.post(`/api/leads/${keepId}/merge`, { sourceId: s.id });
      }
      return true;
    } catch {
      return false;
    }
  }

  async function handleMergeOne(groupIdx: number) {
    setMergingIdx(groupIdx);
    const ok = await mergeGroup(groupIdx);
    setMergingIdx(null);
    if (ok) {
      toast('Grupo unificado!');
      onMerged();
      load();
    } else {
      toast('Erro ao unificar o grupo', 'error');
    }
  }

  async function handleMergeAll() {
    if (!confirm(`Juntar automaticamente todos os ${groups.length} grupos de duplicados? O lead com mais histórico é mantido em cada grupo.`)) return;
    setMergingAll(true);
    let done = 0;
    for (let i = 0; i < groups.length; i++) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await mergeGroup(i);
      if (ok) done++;
    }
    setMergingAll(false);
    toast(`${done} grupo(s) unificado(s)!`);
    onMerged();
    load();
  }

  return (
    <Modal open={open} onClose={onClose} title="Juntar leads duplicados">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
          <AlertTriangle size={15} className="text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-amber-700">
            <p>Ao juntar, as mensagens, tarefas e notas dos duplicados vão para o lead marcado com <Crown size={11} className="inline -mt-0.5 text-amber-600" /> (mantido). Os demais são excluídos. A ação não pode ser desfeita.</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 gap-2 text-slate-400 text-sm">
            <Loader2 size={16} className="animate-spin" /> Procurando duplicados...
          </div>
        ) : groups.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">
            <Check size={32} className="mx-auto mb-2 text-green-400" />
            Nenhum lead duplicado encontrado. 🎉
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-slate-500 font-medium">{groups.length} grupo(s) de duplicados encontrado(s)</p>
              <Button onClick={handleMergeAll} loading={mergingAll} className="text-xs py-1.5">
                <GitMerge size={13} /> Juntar todos automaticamente
              </Button>
            </div>

            <div className="space-y-3">
              {groups.map((group, gi) => {
                const keepId = keepById[gi] || group.leads[0]?.id;
                return (
                  <div key={gi} className="border border-af-border rounded-xl p-3">
                    <div className="space-y-1.5">
                      {group.leads.map((l) => {
                        const isKeep = l.id === keepId;
                        return (
                          <label
                            key={l.id}
                            className={`flex items-center gap-2.5 p-2 rounded-lg cursor-pointer transition-colors ${
                              isKeep ? 'bg-af-light/50 border border-af-mid/40' : 'hover:bg-slate-50 border border-transparent'
                            }`}
                          >
                            <input
                              type="radio"
                              name={`keep-${gi}`}
                              checked={isKeep}
                              onChange={() => setKeepById((p) => ({ ...p, [gi]: l.id }))}
                              className="accent-af-mid"
                            />
                            <Avatar name={l.name} size="sm" />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-sm font-medium text-slate-800 truncate">{l.name}</span>
                                {isKeep && <Crown size={12} className="text-amber-500 flex-shrink-0" />}
                              </div>
                              <p className="text-xs text-slate-400 truncate">
                                {l.pipeline ? `${l.pipeline} → ${l.stage}` : l.stage} · {l.messages} msg{l.phone ? ` · ${l.phone}` : ''}
                              </p>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                    <Button
                      onClick={() => handleMergeOne(gi)}
                      loading={mergingIdx === gi}
                      variant="secondary"
                      className="w-full mt-2 text-xs py-1.5"
                    >
                      <GitMerge size={13} /> Juntar estes {group.leads.length} em 1
                    </Button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
