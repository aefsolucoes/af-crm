'use client';
import { useState, useEffect } from 'react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { toast } from '@/components/ui/toast';
import api from '@/lib/api';
import { AlertTriangle, Check, GitMerge, Loader2 } from 'lucide-react';

interface Duplicate {
  id: string;
  name: string;
  stage?: string;
  pipeline?: string;
  user?: string;
  createdAt: string;
  score: number;
  reasons: string[];
  customFields?: Record<string, string>;
}

interface MergeModalProps {
  open: boolean;
  onClose: () => void;
  onMerged: () => void;
  leadId: string;
  leadName: string;
}

export function MergeModal({ open, onClose, onMerged, leadId, leadName }: MergeModalProps) {
  const [duplicates, setDuplicates] = useState<Duplicate[]>([]);
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.get(`/api/leads/${leadId}/duplicates`)
      .then(({ data }) => setDuplicates(data.duplicates || []))
      .catch(() => toast('Erro ao buscar duplicatas', 'error'))
      .finally(() => setLoading(false));
  }, [open, leadId]);

  async function handleMerge(sourceId: string) {
    setMerging(sourceId);
    try {
      await api.post(`/api/leads/${leadId}/merge`, { sourceId });
      toast('Leads unificados com sucesso!');
      onMerged();
      onClose();
    } catch {
      toast('Erro ao unificar leads', 'error');
    } finally {
      setMerging(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Unificar leads duplicados">
      <div className="space-y-4 max-h-[65vh] overflow-y-auto pr-1">

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
          <AlertTriangle size={15} className="text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-amber-700">
            <p className="font-semibold mb-0.5">Lead principal: <span className="text-amber-900">{leadName}</span></p>
            <p>Ao unificar, mensagens, tarefas e notas do duplicado serão migradas para este lead. O duplicado será excluído.</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 gap-2 text-slate-400 text-sm">
            <Loader2 size={16} className="animate-spin" /> Buscando duplicatas...
          </div>
        ) : duplicates.length === 0 ? (
          <div className="text-center py-10 text-slate-400 text-sm">
            <Check size={32} className="mx-auto mb-2 text-green-400" />
            Nenhuma duplicata encontrada para este lead.
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-500 font-medium">{duplicates.length} possível(is) duplicata(s) encontrada(s):</p>
            {duplicates.map(dup => (
              <div
                key={dup.id}
                onClick={() => setSelected(selected === dup.id ? null : dup.id)}
                className={`border rounded-xl p-3 cursor-pointer transition-all ${
                  selected === dup.id
                    ? 'border-af-mid bg-af-light/30'
                    : 'border-af-border hover:border-af-mid/40'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <Avatar name={dup.name} size="md" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-800 truncate">{dup.name}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${
                        dup.score >= 80 ? 'bg-red-100 text-red-700' :
                        dup.score >= 50 ? 'bg-amber-100 text-amber-700' :
                        'bg-slate-100 text-slate-600'
                      }`}>
                        {dup.score >= 80 ? 'Alta' : dup.score >= 50 ? 'Média' : 'Baixa'} similaridade
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {dup.pipeline} → {dup.stage} · {dup.user}
                    </p>
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {dup.reasons.map(r => (
                        <span key={r} className="text-xs bg-blue-50 text-blue-700 border border-blue-100 px-2 py-0.5 rounded-md">
                          {r}
                        </span>
                      ))}
                    </div>
                    {dup.customFields?.telefone_1 && (
                      <p className="text-xs text-slate-400 mt-1">📱 {dup.customFields.telefone_1}</p>
                    )}
                  </div>
                </div>

                {selected === dup.id && (
                  <div className="mt-3 pt-3 border-t border-af-border">
                    <Button
                      onClick={e => { e.stopPropagation(); handleMerge(dup.id); }}
                      loading={merging === dup.id}
                      className="w-full"
                    >
                      <GitMerge size={14} />
                      Unificar com "{dup.name}"
                    </Button>
                    <p className="text-xs text-slate-400 text-center mt-1.5">
                      Este lead será mantido. O duplicado será excluído.
                    </p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
