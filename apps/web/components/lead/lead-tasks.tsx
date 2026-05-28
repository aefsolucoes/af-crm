'use client';
import { Note, Task, NoteType } from '@/types';
import { formatDate, formatDateTime, isOverdue } from '@/lib/utils';
import {
  CheckSquare, Square, Clock, AlertCircle, Plus,
  FileText, Phone, Mail, ArrowRightLeft, StickyNote, ListChecks,
  Pencil, Check, X, Trash2, User,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth.store';

interface LeadTasksProps {
  tasks: Task[];
  notes: Note[];
  leadId: string;
  onRefresh: () => void;
}

const NOTE_ICONS: Record<NoteType, React.ReactNode> = {
  COMMENT: <FileText size={13} />,
  CALL: <Phone size={13} />,
  EMAIL: <Mail size={13} />,
  STAGE_CHANGE: <ArrowRightLeft size={13} />,
  DATA_EDIT: <Pencil size={13} />,
};

const NOTE_LABELS: Record<NoteType, string> = {
  COMMENT: 'Nota',
  CALL: 'Ligação',
  EMAIL: 'E-mail',
  STAGE_CHANGE: 'Mudança de estágio',
  DATA_EDIT: 'Edição',
};

// STAGE_CHANGE e DATA_EDIT são automáticos — não editáveis pelo usuário
const SYSTEM_TYPES: NoteType[] = ['STAGE_CHANGE', 'DATA_EDIT'];

type PanelTab = 'tasks' | 'notes';

export function LeadTasks({ tasks, notes, leadId, onRefresh }: LeadTasksProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>('tasks');
  const { user } = useAuthStore();

  // ── Tarefas ──
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [taskForm, setTaskForm] = useState({ title: '', dueAt: '' });
  const [savingTask, setSavingTask] = useState(false);

  // ── Notas ──
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [noteContent, setNoteContent] = useState('');
  const [noteType, setNoteType] = useState<NoteType>('COMMENT');
  const [savingNote, setSavingNote] = useState(false);

  // ── Edição de nota ──
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');

  async function handleToggle(task: Task) {
    try {
      await api.patch(`/api/tasks/${task.id}`, { done: !task.done });
      toast(task.done ? 'Tarefa reaberta' : 'Tarefa concluída!');
      onRefresh();
    } catch {
      toast('Erro ao atualizar tarefa', 'error');
    }
  }

  async function handleCreateTask(e: React.FormEvent) {
    e.preventDefault();
    if (!taskForm.title || !taskForm.dueAt) return;
    setSavingTask(true);
    try {
      await api.post('/api/tasks', {
        title: taskForm.title,
        dueAt: new Date(taskForm.dueAt).toISOString(),
        userId: user?.id || tasks[0]?.userId || '',
        leadId,
      });
      toast('Tarefa criada!');
      setTaskForm({ title: '', dueAt: '' });
      setShowTaskForm(false);
      onRefresh();
    } catch {
      toast('Erro ao criar tarefa', 'error');
    } finally {
      setSavingTask(false);
    }
  }

  async function handleAddNote() {
    if (!noteContent.trim()) return;
    setSavingNote(true);
    try {
      await api.post('/api/notes', { leadId, content: noteContent.trim(), type: noteType });
      toast('Nota adicionada!');
      setNoteContent('');
      setShowNoteForm(false);
      onRefresh();
    } catch {
      toast('Erro ao adicionar nota', 'error');
    } finally {
      setSavingNote(false);
    }
  }

  function startEditNote(note: Note) {
    setEditingNoteId(note.id);
    setEditingContent(note.content);
  }

  async function handleSaveEditNote(noteId: string) {
    if (!editingContent.trim()) return;
    try {
      await api.patch(`/api/notes/${noteId}`, { content: editingContent.trim() });
      toast('Nota atualizada!');
      setEditingNoteId(null);
      onRefresh();
    } catch {
      toast('Erro ao editar nota', 'error');
    }
  }

  async function handleDeleteNote(noteId: string) {
    if (!confirm('Excluir esta nota?')) return;
    try {
      await api.delete(`/api/notes/${noteId}`);
      toast('Nota excluída');
      onRefresh();
    } catch {
      toast('Erro ao excluir nota', 'error');
    }
  }

  const pending = tasks.filter(t => !t.done);
  const done = tasks.filter(t => t.done);
  // Notas manuais (excluindo eventos de sistema)
  const manualNotes = [...notes]
    .filter(n => !SYSTEM_TYPES.includes(n.type))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  return (
    <div className="flex flex-col h-full">

      {/* ── Tabs ── */}
      <div className="flex border-b border-af-border bg-white">
        <button
          onClick={() => setActiveTab('tasks')}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-semibold transition-colors border-b-2',
            activeTab === 'tasks'
              ? 'border-af-mid text-af-mid'
              : 'border-transparent text-slate-400 hover:text-slate-600'
          )}
        >
          <ListChecks size={14} />
          Tarefas
          {pending.length > 0 && (
            <span className="bg-af-mid text-white text-[10px] px-1.5 py-0.5 rounded-full leading-none">
              {pending.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('notes')}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-semibold transition-colors border-b-2',
            activeTab === 'notes'
              ? 'border-af-mid text-af-mid'
              : 'border-transparent text-slate-400 hover:text-slate-600'
          )}
        >
          <StickyNote size={14} />
          Notas
          {manualNotes.length > 0 && (
            <span className="bg-slate-200 text-slate-600 text-[10px] px-1.5 py-0.5 rounded-full leading-none">
              {manualNotes.length}
            </span>
          )}
        </button>
      </div>

      {/* ── TAREFAS ── */}
      {activeTab === 'tasks' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-af-border bg-white">
            <span className="text-xs text-slate-500">{pending.length} pendente{pending.length !== 1 ? 's' : ''}</span>
            <Button size="sm" variant="secondary" onClick={() => setShowTaskForm(!showTaskForm)}>
              <Plus size={12} />
              Nova tarefa
            </Button>
          </div>

          {showTaskForm && (
            <form onSubmit={handleCreateTask} className="px-4 py-3 bg-af-light border-b border-af-border space-y-2">
              <input
                value={taskForm.title}
                onChange={e => setTaskForm(p => ({ ...p, title: e.target.value }))}
                placeholder="Título da tarefa"
                className="w-full text-xs px-2.5 py-1.5 border border-af-border rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-af-accent"
              />
              <input
                type="datetime-local"
                value={taskForm.dueAt}
                onChange={e => setTaskForm(p => ({ ...p, dueAt: e.target.value }))}
                className="w-full text-xs px-2.5 py-1.5 border border-af-border rounded-lg bg-white focus:outline-none focus:ring-1 focus:ring-af-accent"
              />
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="secondary" onClick={() => setShowTaskForm(false)}>Cancelar</Button>
                <Button type="submit" size="sm" loading={savingTask} className="flex-1">Criar</Button>
              </div>
            </form>
          )}

          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {pending.map(task => {
              const overdue = isOverdue(task.dueAt);
              return (
                <div
                  key={task.id}
                  className={cn(
                    'flex items-start gap-2.5 px-4 py-3 border-b border-af-border/50 hover:bg-af-light/50',
                    overdue && 'bg-red-50/40'
                  )}
                >
                  <button onClick={() => handleToggle(task)} className="mt-0.5 flex-shrink-0 text-slate-300 hover:text-af-mid transition-colors">
                    <Square size={15} />
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-slate-800 font-medium leading-snug">{task.title}</p>
                    <div className={cn('flex items-center gap-1 text-xs mt-1', overdue ? 'text-red-500' : 'text-slate-400')}>
                      {overdue ? <AlertCircle size={10} /> : <Clock size={10} />}
                      {formatDate(task.dueAt)}
                      {overdue && <span className="font-semibold">· Vencida</span>}
                    </div>
                  </div>
                </div>
              );
            })}

            {done.length > 0 && (
              <>
                <div className="px-4 py-2 bg-slate-50">
                  <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Concluídas ({done.length})</p>
                </div>
                {done.map(task => (
                  <div key={task.id} className="flex items-start gap-2.5 px-4 py-3 border-b border-af-border/50 opacity-50">
                    <button onClick={() => handleToggle(task)} className="mt-0.5 flex-shrink-0 text-green-500">
                      <CheckSquare size={15} />
                    </button>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-500 line-through leading-snug">{task.title}</p>
                      <div className="flex items-center gap-1 text-xs text-slate-400 mt-1">
                        <Clock size={10} />
                        {formatDate(task.dueAt)}
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {tasks.length === 0 && !showTaskForm && (
              <div className="flex flex-col items-center justify-center h-32 text-slate-400 text-xs gap-2">
                <ListChecks size={20} className="opacity-40" />
                <span>Nenhuma tarefa</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── NOTAS ── */}
      {activeTab === 'notes' && (
        <div className="flex flex-col flex-1 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-af-border bg-white">
            <span className="text-xs text-slate-500">{manualNotes.length} nota{manualNotes.length !== 1 ? 's' : ''}</span>
            <Button size="sm" variant="secondary" onClick={() => setShowNoteForm(!showNoteForm)}>
              <Plus size={12} />
              Nova nota
            </Button>
          </div>

          {showNoteForm && (
            <div className="px-4 py-3 bg-af-light border-b border-af-border space-y-2">
              <div className="flex gap-1.5 flex-wrap">
                {(['COMMENT', 'CALL', 'EMAIL'] as NoteType[]).map(t => (
                  <button
                    key={t}
                    onClick={() => setNoteType(t)}
                    className={cn(
                      'flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg transition-colors',
                      noteType === t ? 'bg-af-mid text-white' : 'bg-white text-slate-600 border border-af-border hover:bg-slate-50'
                    )}
                  >
                    {NOTE_ICONS[t]}
                    {NOTE_LABELS[t]}
                  </button>
                ))}
              </div>
              <textarea
                value={noteContent}
                onChange={e => setNoteContent(e.target.value)}
                placeholder="Escreva sua nota aqui..."
                className="w-full px-3 py-2 text-xs border border-af-border rounded-lg bg-white resize-none focus:outline-none focus:ring-2 focus:ring-af-accent"
                rows={4}
              />
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setShowNoteForm(false)}>Cancelar</Button>
                <Button size="sm" loading={savingNote} onClick={handleAddNote} className="flex-1">Salvar</Button>
              </div>
            </div>
          )}

          <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-3 space-y-3">
            {manualNotes.map(note => (
              <div key={note.id} className="group bg-white border border-af-border rounded-xl p-3 shadow-sm">
                <div className="flex items-center justify-between mb-2">
                  <span className={cn(
                    'flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-md',
                    note.type === 'COMMENT' && 'bg-slate-100 text-slate-600',
                    note.type === 'CALL' && 'bg-green-50 text-green-700',
                    note.type === 'EMAIL' && 'bg-blue-50 text-blue-700',
                  )}>
                    {NOTE_ICONS[note.type]}
                    {NOTE_LABELS[note.type]}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-400">{formatDateTime(note.createdAt)}</span>
                    {/* Botões editar/excluir — só aparecem no hover */}
                    <div className="hidden group-hover:flex items-center gap-1">
                      <button
                        onClick={() => startEditNote(note)}
                        className="p-0.5 text-slate-400 hover:text-af-mid transition-colors"
                        title="Editar nota"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        onClick={() => handleDeleteNote(note.id)}
                        className="p-0.5 text-slate-400 hover:text-red-500 transition-colors"
                        title="Excluir nota"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Autor */}
                {note.user && (
                  <div className="flex items-center gap-1 mb-1.5">
                    <User size={10} className="text-slate-400" />
                    <span className="text-[10px] text-slate-400">{note.user.name}</span>
                    {note.updatedAt && note.updatedAt !== note.createdAt && (
                      <span className="text-[10px] text-slate-300 ml-1">· editado {formatDateTime(note.updatedAt)}</span>
                    )}
                  </div>
                )}

                {/* Conteúdo ou editor inline */}
                {editingNoteId === note.id ? (
                  <div className="space-y-2 mt-1">
                    <textarea
                      autoFocus
                      value={editingContent}
                      onChange={e => setEditingContent(e.target.value)}
                      className="w-full px-2 py-1.5 text-xs border border-af-mid rounded-lg bg-white resize-none focus:outline-none"
                      rows={4}
                      onKeyDown={e => {
                        if (e.key === 'Escape') setEditingNoteId(null);
                        if (e.key === 'Enter' && e.ctrlKey) handleSaveEditNote(note.id);
                      }}
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => setEditingNoteId(null)}
                        className="text-[11px] text-slate-500 hover:text-slate-700 flex items-center gap-1 border border-af-border rounded px-2 py-1"
                      >
                        <X size={10} /> Cancelar
                      </button>
                      <button
                        onClick={() => handleSaveEditNote(note.id)}
                        className="text-[11px] text-white bg-af-mid hover:bg-af-dark flex items-center gap-1 rounded px-2 py-1 flex-1 justify-center"
                      >
                        <Check size={10} /> Salvar
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-slate-700 leading-relaxed whitespace-pre-wrap">{note.content}</p>
                )}
              </div>
            ))}

            {manualNotes.length === 0 && !showNoteForm && (
              <div className="flex flex-col items-center justify-center h-32 text-slate-400 text-xs gap-2">
                <StickyNote size={20} className="opacity-40" />
                <span>Nenhuma nota</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
