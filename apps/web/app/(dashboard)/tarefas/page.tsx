'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import { Task } from '@/types';
import api from '@/lib/api';
import { formatDate, isOverdue } from '@/lib/utils';
import { CheckSquare, Square, Clock, AlertCircle, CheckCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import Link from 'next/link';
import { useState } from 'react';

async function fetchTasks(): Promise<Task[]> {
  const { data } = await api.get('/api/tasks');
  return data;
}

export default function TarefasPage() {
  const [filter, setFilter] = useState<'all' | 'pending' | 'overdue' | 'done'>('all');
  const queryClient = useQueryClient();

  const { data: tasks, isLoading } = useQuery({ queryKey: ['tasks'], queryFn: fetchTasks });

  async function handleToggle(task: Task) {
    try {
      await api.patch(`/api/tasks/${task.id}`, { done: !task.done });
      toast(task.done ? 'Tarefa reaberta' : 'Tarefa concluída!');
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    } catch {
      toast('Erro ao atualizar tarefa', 'error');
    }
  }

  const filtered = (tasks || []).filter((t) => {
    if (filter === 'done') return t.done;
    if (filter === 'pending') return !t.done && !isOverdue(t.dueAt);
    if (filter === 'overdue') return !t.done && isOverdue(t.dueAt);
    return true;
  });

  const pending = (tasks || []).filter((t) => !t.done && !isOverdue(t.dueAt)).length;
  const overdue = (tasks || []).filter((t) => !t.done && isOverdue(t.dueAt)).length;
  const done = (tasks || []).filter((t) => t.done).length;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Tarefas" />

      {/* Stats */}
      <div className="px-6 py-3 bg-white border-b border-af-border flex items-center gap-6">
        <button onClick={() => setFilter('all')} className={cn('text-xs font-medium px-3 py-1.5 rounded-full transition-colors', filter === 'all' ? 'bg-af-mid text-white' : 'bg-af-light text-slate-600 hover:bg-af-border')}>
          Todas · {tasks?.length || 0}
        </button>
        <button onClick={() => setFilter('pending')} className={cn('text-xs font-medium px-3 py-1.5 rounded-full transition-colors', filter === 'pending' ? 'bg-af-mid text-white' : 'bg-af-light text-slate-600 hover:bg-af-border')}>
          Pendentes · {pending}
        </button>
        <button onClick={() => setFilter('overdue')} className={cn('text-xs font-medium px-3 py-1.5 rounded-full transition-colors', filter === 'overdue' ? 'bg-red-500 text-white' : 'bg-red-50 text-red-600 hover:bg-red-100')}>
          Vencidas · {overdue}
        </button>
        <button onClick={() => setFilter('done')} className={cn('text-xs font-medium px-3 py-1.5 rounded-full transition-colors', filter === 'done' ? 'bg-green-600 text-white' : 'bg-green-50 text-green-700 hover:bg-green-100')}>
          Concluídas · {done}
        </button>
      </div>

      <div className="flex-1 overflow-auto px-6 py-4 scrollbar-thin">
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
          </div>
        ) : (
          <div className="space-y-2 max-w-3xl">
            {filtered.map((task) => {
              const overdue = !task.done && isOverdue(task.dueAt);
              return (
                <div key={task.id} className={cn('flex items-center gap-4 bg-white rounded-xl border px-4 py-3 shadow-sm hover:shadow-md transition-shadow', overdue ? 'border-red-200 bg-red-50/30' : 'border-af-border')}>
                  <button onClick={() => handleToggle(task)} className={cn('flex-shrink-0', task.done ? 'text-green-500' : 'text-slate-300 hover:text-af-mid')}>
                    {task.done ? <CheckSquare size={20} /> : <Square size={20} />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className={cn('text-sm font-medium', task.done ? 'line-through text-slate-400' : 'text-slate-900')}>
                      {task.title}
                    </p>
                    <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-500">
                      <span className="flex items-center gap-1">
                        {overdue ? <AlertCircle size={11} className="text-red-500" /> : <Clock size={11} />}
                        <span className={overdue ? 'text-red-600 font-medium' : ''}>{formatDate(task.dueAt)}{overdue ? ' · Vencida' : ''}</span>
                      </span>
                      {task.user && <span>· {task.user.name}</span>}
                      {task.lead && (
                        <Link href={`/leads/${task.lead.id}`} className="hover:text-af-mid hover:underline">
                          · {task.lead.name}
                        </Link>
                      )}
                    </div>
                  </div>
                  {task.done && <CheckCheck size={16} className="text-green-500 flex-shrink-0" />}
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="text-center py-12 text-slate-400 text-sm">Nenhuma tarefa encontrada</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
