'use client';
import { Task } from '@/types';
import { formatDate, isOverdue } from '@/lib/utils';
import { CheckSquare, Square, Clock, AlertCircle, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth.store';

interface LeadTasksProps {
  tasks: Task[];
  leadId: string;
  onRefresh: () => void;
}

export function LeadTasks({ tasks, leadId, onRefresh }: LeadTasksProps) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ title: '', dueAt: '' });
  const [saving, setSaving] = useState(false);
  const { user } = useAuthStore();

  async function handleToggle(task: Task) {
    try {
      await api.patch(`/api/tasks/${task.id}`, { done: !task.done });
      toast(task.done ? 'Tarefa reaberta' : 'Tarefa concluída!');
      onRefresh();
    } catch {
      toast('Erro ao atualizar tarefa', 'error');
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title || !form.dueAt) return;
    setSaving(true);
    try {
      await api.post('/api/tasks', { title: form.title, dueAt: new Date(form.dueAt).toISOString(), userId: user?.id || tasks[0]?.userId || '', leadId });
      toast('Tarefa criada!');
      setForm({ title: '', dueAt: '' });
      setShowForm(false);
      onRefresh();
    } catch {
      toast('Erro ao criar tarefa', 'error');
    } finally {
      setSaving(false);
    }
  }

  const pending = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-af-border">
        <h3 className="text-sm font-semibold text-slate-700">Tarefas</h3>
        <Button size="sm" variant="secondary" onClick={() => setShowForm(!showForm)}>
          <Plus size={12} />
        </Button>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="px-4 py-3 bg-af-light border-b border-af-border space-y-2">
          <input
            value={form.title}
            onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))}
            placeholder="Título da tarefa"
            className="w-full text-xs px-2 py-1.5 border border-af-border rounded bg-white focus:outline-none focus:ring-1 focus:ring-af-accent"
          />
          <input
            type="datetime-local"
            value={form.dueAt}
            onChange={(e) => setForm((p) => ({ ...p, dueAt: e.target.value }))}
            className="w-full text-xs px-2 py-1.5 border border-af-border rounded bg-white focus:outline-none focus:ring-1 focus:ring-af-accent"
          />
          <Button type="submit" size="sm" loading={saving} className="w-full">Criar</Button>
        </form>
      )}

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {pending.map((task) => {
          const overdue = isOverdue(task.dueAt);
          return (
            <div key={task.id} className={cn('flex items-start gap-2 px-4 py-3 border-b border-af-border/50 hover:bg-af-light/50 group', overdue && !task.done ? 'bg-red-50/50' : '')}>
              <button onClick={() => handleToggle(task)} className="mt-0.5 flex-shrink-0 text-slate-400 hover:text-af-mid">
                <Square size={15} />
              </button>
              <div className="flex-1 min-w-0">
                <p className="text-xs text-slate-800 font-medium">{task.title}</p>
                <div className={cn('flex items-center gap-1 text-xs mt-0.5', overdue ? 'text-red-500' : 'text-slate-400')}>
                  {overdue ? <AlertCircle size={11} /> : <Clock size={11} />}
                  {formatDate(task.dueAt)}
                  {overdue && <span className="font-medium">· Vencida</span>}
                </div>
              </div>
            </div>
          );
        })}

        {done.length > 0 && (
          <div className="px-4 py-2">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Concluídas</p>
          </div>
        )}
        {done.map((task) => (
          <div key={task.id} className="flex items-start gap-2 px-4 py-3 border-b border-af-border/50 opacity-60">
            <button onClick={() => handleToggle(task)} className="mt-0.5 flex-shrink-0 text-green-500">
              <CheckSquare size={15} />
            </button>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-slate-500 line-through">{task.title}</p>
              <div className="flex items-center gap-1 text-xs text-slate-400 mt-0.5">
                <Clock size={11} />
                {formatDate(task.dueAt)}
              </div>
            </div>
          </div>
        ))}

        {tasks.length === 0 && (
          <div className="flex items-center justify-center h-24 text-slate-400 text-xs">
            Nenhuma tarefa
          </div>
        )}
      </div>
    </div>
  );
}
