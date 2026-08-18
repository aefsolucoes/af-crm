'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { MousePointerClick, Send, Loader2, X, Clock, CheckCircle2, XCircle, StopCircle } from 'lucide-react';

type AgentTaskStatus = 'PENDING' | 'RUNNING' | 'AWAITING_APPROVAL' | 'AWAITING_HUMAN_TAKEOVER' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

interface AgentTask {
  id: string;
  instruction: string;
  status: AgentTaskStatus;
  resultSummary?: string | null;
  errorMessage?: string | null;
  stepCount: number;
  createdAt: string;
}

interface AgentActionLog {
  id: string;
  seq: number;
  tool: string;
  input: Record<string, unknown>;
  output: { ok?: boolean; summary?: string } | null;
  createdAt: string;
}

interface Step {
  seq: number;
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  summary: string;
  screenshot?: string;
}

const STATUS_META: Record<AgentTaskStatus, { label: string; color: string; icon: typeof Clock }> = {
  PENDING: { label: 'Iniciando…', color: 'text-slate-400', icon: Clock },
  RUNNING: { label: 'Executando…', color: 'text-amber-400', icon: Loader2 },
  AWAITING_APPROVAL: { label: 'Aguardando aprovação', color: 'text-amber-400', icon: Clock },
  AWAITING_HUMAN_TAKEOVER: { label: 'Aguardando você', color: 'text-amber-400', icon: Clock },
  COMPLETED: { label: 'Concluída', color: 'text-emerald-400', icon: CheckCircle2 },
  FAILED: { label: 'Falhou', color: 'text-red-400', icon: XCircle },
  CANCELLED: { label: 'Cancelada', color: 'text-slate-400', icon: StopCircle },
};

async function fetchTasks(): Promise<AgentTask[]> {
  const { data } = await api.get('/api/browser-agent/tasks');
  return data;
}

async function fetchTaskDetail(id: string): Promise<AgentTask & { logs: AgentActionLog[] }> {
  const { data } = await api.get(`/api/browser-agent/tasks/${id}`);
  return data;
}

export default function AgenteNavegadorPage() {
  const queryClient = useQueryClient();
  const [instruction, setInstruction] = useState('');
  const [starting, setStarting] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<AgentTaskStatus | null>(null);
  const [result, setResult] = useState<{ summary?: string | null; error?: string | null } | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const { data: tasks } = useQuery({ queryKey: ['browser-agent-tasks'], queryFn: fetchTasks, refetchInterval: 15000 });

  const activeTask = (tasks || []).find((t) => t.id === activeTaskId);
  const isRunning = status === 'PENDING' || status === 'RUNNING';
  const currentScreenshot = [...steps].reverse().find((s) => s.screenshot)?.screenshot;

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [steps]);

  // Escuta o progresso ao vivo da tarefa ativa — cada passo que o Claude decide
  // chega aqui na hora (screenshot inclusa), sem precisar recarregar a página.
  useEffect(() => {
    const socket = getSocket();

    function onStep(payload: Step & { taskId: string }) {
      if (payload.taskId !== activeTaskId) return;
      setSteps((prev) => [...prev, payload]);
    }

    function onStatus(payload: { taskId: string; status: AgentTaskStatus; resultSummary?: string; errorMessage?: string }) {
      if (payload.taskId !== activeTaskId) return;
      setStatus(payload.status);
      if (payload.resultSummary || payload.errorMessage) {
        setResult({ summary: payload.resultSummary, error: payload.errorMessage });
      }
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(payload.status)) {
        queryClient.invalidateQueries({ queryKey: ['browser-agent-tasks'] });
      }
    }

    socket.on('agent_step', onStep);
    socket.on('agent_task_status', onStatus);
    return () => {
      socket.off('agent_step', onStep);
      socket.off('agent_task_status', onStatus);
    };
  }, [activeTaskId, queryClient]);

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    const text = instruction.trim();
    if (!text || starting) return;
    setStarting(true);
    try {
      const { data } = await api.post('/api/browser-agent/tasks', { instruction: text });
      setActiveTaskId(data.id);
      setStatus(data.status);
      setResult(null);
      setSteps([]);
      setInstruction('');
      queryClient.invalidateQueries({ queryKey: ['browser-agent-tasks'] });
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao iniciar a tarefa', 'error');
    } finally {
      setStarting(false);
    }
  }

  async function handleCancel() {
    if (!activeTaskId) return;
    try {
      await api.post(`/api/browser-agent/tasks/${activeTaskId}/cancel`);
    } catch {
      toast('Erro ao cancelar', 'error');
    }
  }

  async function openTask(task: AgentTask) {
    setActiveTaskId(task.id);
    setStatus(task.status);
    setResult({ summary: task.resultSummary, error: task.errorMessage });
    setSteps([]);
    try {
      const detail = await fetchTaskDetail(task.id);
      setSteps(
        detail.logs.map((l) => ({
          seq: l.seq,
          tool: l.tool,
          input: l.input,
          ok: !!l.output?.ok,
          summary: l.output?.summary || '',
        }))
      );
    } catch {
      toast('Erro ao carregar detalhes da tarefa', 'error');
    }
  }

  const statusMeta = status ? STATUS_META[status] : null;

  return (
    <div className="flex flex-col h-full">
      <Topbar title="Agente de Navegador" subtitle="A IA controla o Chrome de verdade — vê a tela, clica, digita" />

      <div className="flex-1 overflow-hidden flex">
        {/* Coluna principal: instrução, transcript, screenshot */}
        <div className="flex-1 flex flex-col overflow-hidden px-6 py-4 gap-4">
          <form onSubmit={handleStart} className="flex gap-2">
            <input
              type="text"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder='Ex.: "abra o google.com e pesquise gatos"'
              disabled={isRunning}
              className="flex-1 px-4 py-2.5 text-sm border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={starting || isRunning || !instruction.trim()}
              className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-af-mid text-white text-sm font-medium hover:bg-af-dark disabled:opacity-50"
            >
              {starting ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              Iniciar
            </button>
          </form>

          {!activeTaskId && (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 text-sm gap-2">
              <MousePointerClick size={32} className="opacity-40" />
              <p>Descreva uma tarefa acima, ou escolha uma da lista ao lado.</p>
              <p className="text-xs opacity-70">A extensão do Chrome precisa estar instalada, logada e conectada.</p>
            </div>
          )}

          {activeTaskId && (
            <div className="flex-1 flex gap-4 overflow-hidden">
              {/* Transcript */}
              <div className="flex-1 flex flex-col overflow-hidden border border-af-border rounded-xl bg-white">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-af-border">
                  <div className="flex items-center gap-2 min-w-0">
                    {statusMeta && (
                      <span className={cn('flex items-center gap-1 text-xs font-medium', statusMeta.color)}>
                        <statusMeta.icon size={13} className={status === 'RUNNING' ? 'animate-spin' : ''} />
                        {statusMeta.label}
                      </span>
                    )}
                  </div>
                  {isRunning && (
                    <button onClick={handleCancel} className="flex items-center gap-1 text-xs text-red-500 hover:text-red-600 font-medium">
                      <X size={13} /> Cancelar
                    </button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-thin">
                  {steps.length === 0 && isRunning && (
                    <p className="text-xs text-slate-400 italic">Aguardando a IA decidir o primeiro passo…</p>
                  )}
                  {steps.map((s) => (
                    <div key={s.seq} className={cn('text-xs px-3 py-2 rounded-lg', s.ok ? 'bg-slate-50' : 'bg-red-50')}>
                      <p className="font-medium text-slate-700">
                        {s.seq}. {toolLabel(s.tool, s.input)}
                      </p>
                      {s.summary && <p className={cn('mt-0.5', s.ok ? 'text-slate-500' : 'text-red-600')}>{s.summary}</p>}
                    </div>
                  ))}
                  {(result?.summary || result?.error) && (
                    <div className={cn('text-xs px-3 py-2 rounded-lg font-medium', result.error ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700')}>
                      {result.error || result.summary}
                    </div>
                  )}
                  <div ref={transcriptEndRef} />
                </div>
              </div>

              {/* Screenshot ao vivo */}
              <div className="w-[420px] flex-shrink-0 border border-af-border rounded-xl bg-slate-900 overflow-hidden flex items-center justify-center">
                {currentScreenshot ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`data:image/png;base64,${currentScreenshot}`} alt="Tela atual" className="w-full h-auto" />
                ) : (
                  <p className="text-xs text-slate-500 p-4 text-center">A tela aparece aqui assim que o primeiro passo rodar.</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Histórico */}
        <div className="w-72 flex-shrink-0 border-l border-af-border overflow-y-auto scrollbar-thin px-3 py-4 space-y-1">
          <p className="px-1 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Histórico</p>
          {(tasks || []).map((t) => {
            const meta = STATUS_META[t.status];
            return (
              <button
                key={t.id}
                onClick={() => openTask(t)}
                className={cn(
                  'w-full text-left px-3 py-2 rounded-lg text-xs transition-colors',
                  t.id === activeTaskId ? 'bg-af-mid/10 border border-af-mid/30' : 'hover:bg-slate-50 border border-transparent'
                )}
              >
                <p className="text-slate-700 line-clamp-2">{t.instruction}</p>
                <span className={cn('flex items-center gap-1 mt-1', meta.color)}>
                  <meta.icon size={11} />
                  {meta.label}
                </span>
              </button>
            );
          })}
          {(tasks || []).length === 0 && <p className="text-xs text-slate-400 px-1">Nenhuma tarefa ainda.</p>}
        </div>
      </div>
    </div>
  );
}

function toolLabel(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'browser_navigate': return `Abrir ${input.url}`;
    case 'browser_click': return `Clicar em (${input.x}, ${input.y})`;
    case 'browser_type': return `Digitar "${input.text}"`;
    case 'browser_key': return `Pressionar ${input.key}`;
    case 'browser_scroll': return `Rolar pra ${input.direction}`;
    case 'browser_wait': return `Esperar ${input.seconds}s`;
    case 'browser_screenshot': return 'Olhar a tela';
    default: return tool;
  }
}
