'use client';
import { useCallback, useEffect, useState } from 'react';
import { RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';

interface Change {
  id: string;
  label: string;
  userName: string;
  createdAt: string;
  revertedAt: string | null;
  revertedByName: string | null;
}

function ago(iso: string) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.round(h / 24)} d`;
}

/** Botão "Reverter" do card (Fabio 19/10): desfaz a última alteração que a equipe fez (Perdido, mover de etapa/funil, arquivar, responsável,
 *  campos…) e deixa voltar a qualquer ponto do histórico dos últimos 30 dias. O que a IA/automação mexeu depois é preservado (ver lead-change.service.ts na API). */
export function LeadRevertBar({ leadId, version, onReverted }: { leadId: string; version?: string; onReverted: () => void }) {
  const [changes, setChanges] = useState<Change[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get(`/api/leads/${leadId}/changes`);
      setChanges(Array.isArray(data) ? data : []);
    } catch { /* sem histórico: a barra some */ }
  }, [leadId]);

  // A alteração só entra no histórico alguns segundos depois da ação (a API espera as consequências dela terminarem): busca de novo em seguida.
  useEffect(() => {
    load();
    const t = setTimeout(load, 4500);
    return () => clearTimeout(t);
  }, [load, version]);

  async function revert(c: Change) {
    const newer = changes.filter((x) => !x.revertedAt && new Date(x.createdAt) > new Date(c.createdAt)).length;
    const msg = `Reverter: "${c.label}"?\n\nO card volta a como estava antes dessa alteração.${newer ? `\nIsso também desfaz as ${newer} alteração(ões) mais nova(s).` : ''}`;
    if (!confirm(msg)) return;
    setBusy(true);
    try {
      await api.post(`/api/leads/${leadId}/changes/${c.id}/revert`);
      toast('Alteração desfeita');
      setOpen(false);
      onReverted();
      load();
    } catch (e: any) {
      toast(e?.response?.data?.error || 'Não consegui reverter', 'error');
    } finally {
      setBusy(false);
    }
  }

  if (!changes.length) return null;
  const top = changes.find((c) => !c.revertedAt);

  return (
    <div className="text-[11px] text-slate-500">
      <div className="flex items-center gap-1.5 min-w-0">
        {top ? (
          <>
            <button
              onClick={() => revert(top)}
              disabled={busy}
              title="Desfazer a última alteração feita neste card"
              className="flex-shrink-0 flex items-center gap-1 font-medium px-2 py-0.5 border rounded-md transition-colors disabled:opacity-50 bg-violet-50 text-violet-700 hover:bg-violet-100 border-violet-200"
            >
              <RotateCcw size={11} /> Reverter
            </button>
            <span className="truncate" title={`${top.label} — ${top.userName}`}>{top.label} · {ago(top.createdAt)}</span>
          </>
        ) : (
          <span className="truncate">Alterações desfeitas</span>
        )}
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex-shrink-0 ml-auto flex items-center gap-0.5 text-slate-400 hover:text-slate-600"
          title="Ver o histórico de alterações"
        >
          Histórico {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>
      {open && (
        <ul className="mt-1.5 space-y-1 max-h-48 overflow-y-auto pr-1">
          {changes.map((c) => (
            <li key={c.id} className="flex items-start gap-1.5 rounded-md border border-slate-100 bg-slate-50 px-2 py-1">
              <div className="min-w-0 flex-1">
                <p className={`leading-snug ${c.revertedAt ? 'line-through text-slate-400' : 'text-slate-600'}`}>{c.label}</p>
                <p className="text-[10px] text-slate-400">
                  {c.userName} · {ago(c.createdAt)}{c.revertedAt ? ` · desfeita por ${c.revertedByName || '—'}` : ''}
                </p>
              </div>
              {!c.revertedAt && (
                <button
                  onClick={() => revert(c)}
                  disabled={busy}
                  className="flex-shrink-0 text-violet-700 hover:text-violet-900 font-medium disabled:opacity-50"
                  title="Voltar o card a como estava antes desta alteração"
                >
                  Voltar a antes
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
