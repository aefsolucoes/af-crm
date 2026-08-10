'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { StickyNote, Plus, X, Users, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DashboardNoteItem {
  id: string;
  content: string;
  done: boolean;
  scope: 'PRIVATE' | 'TEAM';
  authorName?: string;
  createdAt: string;
}

type Scope = 'PRIVATE' | 'TEAM';

// Paleta inspirada no Freeform (post-its coloridos) — cada nota "sorteia" uma
// cor e uma leve inclinação a partir do próprio id, então fica estável entre
// renders (não fica "piscando" cor diferente a cada atualização).
const PALETTE = [
  { bg: '#FEF9C3', tape: '#FDE68A' }, // amarelo
  { bg: '#FCE7F3', tape: '#FBCFE8' }, // rosa
  { bg: '#DBEAFE', tape: '#BFDBFE' }, // azul
  { bg: '#D1FAE5', tape: '#A7F3D0' }, // verde
  { bg: '#EDE9FE', tape: '#DDD6FE' }, // roxo
  { bg: '#FFEDD5', tape: '#FED7AA' }, // laranja
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function noteStyle(id: string) {
  const h = hashString(id);
  const color = PALETTE[h % PALETTE.length];
  const rotation = (h % 5) - 2; // -2deg a +2deg
  return { color, rotation };
}

async function fetchNotes(scope: Scope): Promise<DashboardNoteItem[]> {
  const { data } = await api.get(`/api/dashboard-notes?scope=${scope}`);
  return data;
}

export function NotesBoard() {
  const [scope, setScope] = useState<Scope>('PRIVATE');
  const [draft, setDraft] = useState('');
  const [adding, setAdding] = useState(false);
  const queryClient = useQueryClient();

  const { data: notes, isLoading } = useQuery({
    queryKey: ['dashboard-notes', scope],
    queryFn: () => fetchNotes(scope),
  });

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ['dashboard-notes', scope] });
  }

  async function handleAdd() {
    const content = draft.trim();
    if (!content) return;
    setAdding(true);
    try {
      await api.post('/api/dashboard-notes', { content, scope });
      setDraft('');
      invalidate();
    } catch {
      toast('Erro ao salvar anotação', 'error');
    } finally {
      setAdding(false);
    }
  }

  async function toggleDone(note: DashboardNoteItem) {
    try {
      await api.patch(`/api/dashboard-notes/${note.id}`, { done: !note.done });
      invalidate();
    } catch {
      toast('Erro ao atualizar anotação', 'error');
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.delete(`/api/dashboard-notes/${id}`);
      invalidate();
    } catch {
      toast('Erro ao excluir anotação', 'error');
    }
  }

  return (
    <div className="bg-white rounded-2xl border border-af-border shadow-sm p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <StickyNote size={16} className="text-amber-500" /> Anotações
        </h3>
        <div className="flex bg-slate-100 rounded-xl p-1 gap-1">
          <button
            onClick={() => setScope('PRIVATE')}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all', scope === 'PRIVATE' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700')}
          >
            <Lock size={12} /> Minhas
          </button>
          <button
            onClick={() => setScope('TEAM')}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all', scope === 'TEAM' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700')}
          >
            <Users size={12} /> Mural da equipe
          </button>
        </div>
      </div>

      {/* Adicionar nova anotação */}
      <div className="flex items-center gap-2 mb-4">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          placeholder={scope === 'PRIVATE' ? 'O que você tem para hoje?' : 'Deixe um recado para a equipe...'}
          className="flex-1 text-sm px-3.5 py-2.5 border border-af-border rounded-xl bg-slate-50 text-slate-800 focus:outline-none focus:ring-2 focus:ring-af-accent focus:bg-white transition-colors"
        />
        <button
          onClick={handleAdd}
          disabled={!draft.trim() || adding}
          className="flex-shrink-0 w-10 h-10 rounded-xl bg-af-mid text-white flex items-center justify-center hover:bg-af-dark disabled:opacity-40 transition-colors"
        >
          <Plus size={18} />
        </button>
      </div>

      {/* Quadro de post-its */}
      {isLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-24 rounded-lg bg-slate-100 animate-pulse" />)}
        </div>
      ) : !notes?.length ? (
        <div className="flex flex-col items-center justify-center py-10 text-slate-400">
          <StickyNote size={28} className="mb-2 opacity-30" />
          <p className="text-sm">{scope === 'PRIVATE' ? 'Nenhuma anotação ainda' : 'Nenhum recado no mural ainda'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4 py-1">
          {notes.map((note) => {
            const { color, rotation } = noteStyle(note.id);
            return (
              <div
                key={note.id}
                className="group relative rounded-lg p-3.5 pt-4 shadow-sm hover:shadow-md transition-shadow"
                style={{ backgroundColor: color.bg, transform: `rotate(${rotation}deg)` }}
              >
                {/* "fitinha" no topo, estilo post-it colado */}
                <div
                  className="absolute -top-2 left-1/2 -translate-x-1/2 w-8 h-3 rounded-sm opacity-80"
                  style={{ backgroundColor: color.tape }}
                />
                <button
                  onClick={() => handleDelete(note.id)}
                  title="Excluir"
                  className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity text-slate-500 hover:text-slate-800 p-0.5"
                >
                  <X size={13} />
                </button>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={note.done}
                    onChange={() => toggleDone(note)}
                    className="mt-0.5 rounded border-slate-400 flex-shrink-0"
                  />
                  <span className={cn('text-sm text-slate-800 leading-snug break-words', note.done && 'line-through opacity-50')}>
                    {note.content}
                  </span>
                </label>
                {scope === 'TEAM' && note.authorName && (
                  <p className="text-[10px] text-slate-500/80 mt-2 text-right italic">— {note.authorName}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
