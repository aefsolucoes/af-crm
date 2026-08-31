'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Topbar } from '@/components/ui/topbar';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { LeadPicker } from '@/components/agente-navegador/lead-picker';
import { PlaybooksTab } from '@/components/agente-navegador/playbooks-tab';
import {
  MousePointerClick, Send, Loader2, X, Clock, CheckCircle2, XCircle, StopCircle,
  ThumbsUp, ThumbsDown, MessageCircleQuestion, ListChecks, BookOpen, BookmarkPlus,
  Search, Plus, ChevronRight, ChevronDown, MonitorPlay,
} from 'lucide-react';

type AgentTaskStatus = 'PENDING' | 'RUNNING' | 'AWAITING_APPROVAL' | 'AWAITING_ANSWER' | 'AWAITING_HUMAN_TAKEOVER' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

interface PendingAction {
  kind: 'question' | 'approval';
  message: string;
}

interface AgentTask {
  id: string;
  instruction: string;
  status: AgentTaskStatus;
  pendingAction?: PendingAction | null;
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
  AWAITING_ANSWER: { label: 'Aguardando resposta', color: 'text-amber-400', icon: Clock },
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

/** Agrupa os passos "de clique/digitação" (browser_*) em blocos consecutivos —
 *  cada bloco vira UMA linha recolhida ("Usado N ações"), igual o Claude no
 *  Chrome faz, em vez de listar cada clique pra sempre na tela. Mensagem do
 *  chat ao vivo (operator_message) e pergunta/aprovação (ask_human) NUNCA
 *  entram num bloco — são o "texto" da conversa, cada uma vira sua própria
 *  bolha, do mesmo jeito que corta um bloco de ações em dois no Claude
 *  sempre que ele fala alguma coisa no meio do caminho. */
type Block = { kind: 'actions'; steps: Step[] } | { kind: 'message'; step: Step } | { kind: 'ask'; step: Step };

function groupSteps(steps: Step[]): Block[] {
  const blocks: Block[] = [];
  let current: Step[] = [];
  const flush = () => { if (current.length) { blocks.push({ kind: 'actions', steps: current }); current = []; } };
  for (const s of steps) {
    if (s.tool === 'operator_message') { flush(); blocks.push({ kind: 'message', step: s }); }
    else if (s.tool === 'ask_human') { flush(); blocks.push({ kind: 'ask', step: s }); }
    else current.push(s);
  }
  flush();
  return blocks;
}

export default function AgenteNavegadorPage() {
  const queryClient = useQueryClient();
  const [pageTab, setPageTab] = useState<'tarefas' | 'guias'>('tarefas');
  const [savingPlaybook, setSavingPlaybook] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [leadId, setLeadId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [status, setStatus] = useState<AgentTaskStatus | null>(null);
  const [result, setResult] = useState<{ summary?: string | null; error?: string | null } | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [answerText, setAnswerText] = useState('');
  const [responding, setResponding] = useState(false);
  const [liveText, setLiveText] = useState('');
  const [sendingLive, setSendingLive] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const { data: tasks } = useQuery({ queryKey: ['browser-agent-tasks'], queryFn: fetchTasks, refetchInterval: 15000 });

  const activeTask = (tasks || []).find((t) => t.id === activeTaskId);
  const isRunning = status === 'PENDING' || status === 'RUNNING';
  const isPaused = status === 'AWAITING_APPROVAL' || status === 'AWAITING_ANSWER';
  const currentScreenshot = [...steps].reverse().find((s) => s.screenshot)?.screenshot;
  const blocks = useMemo(() => groupSteps(steps), [steps]);

  const filteredTasks = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return tasks || [];
    return (tasks || []).filter((t) => t.instruction.toLowerCase().includes(q));
  }, [tasks, historySearch]);

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

    function onStatus(payload: { taskId: string; status: AgentTaskStatus; resultSummary?: string; errorMessage?: string; pendingAction?: PendingAction }) {
      if (payload.taskId !== activeTaskId) return;
      setStatus(payload.status);
      setPendingAction(payload.pendingAction || null);
      if (payload.status === 'RUNNING') setAnswerText('');
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

  function resetComposer() {
    setActiveTaskId(null);
    setStatus(null);
    setResult(null);
    setSteps([]);
    setPendingAction(null);
    setExpandedGroups(new Set());
  }

  async function handleStart(e: React.FormEvent) {
    e.preventDefault();
    const text = instruction.trim();
    if (!text || starting) return;
    setStarting(true);
    try {
      const { data } = await api.post('/api/browser-agent/tasks', { instruction: text, leadId: leadId || undefined });
      setActiveTaskId(data.id);
      setStatus(data.status);
      setResult(null);
      setSteps([]);
      setPendingAction(null);
      setExpandedGroups(new Set());
      setInstruction('');
      queryClient.invalidateQueries({ queryKey: ['browser-agent-tasks'] });
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao iniciar a tarefa', 'error');
    } finally {
      setStarting(false);
    }
  }

  async function handleRespond(response: { approve: boolean } | { answer: string }) {
    if (!activeTaskId || responding) return;
    setResponding(true);
    try {
      await api.post(`/api/browser-agent/tasks/${activeTaskId}/respond`, response);
      setPendingAction(null);
      setStatus('RUNNING');
      setAnswerText('');
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao enviar a resposta', 'error');
    } finally {
      setResponding(false);
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

  /** Chat AO VIVO — manda uma mensagem enquanto a tarefa está rodando, sem
   *  esperar ela parar sozinha pra perguntar (diferente de handleRespond,
   *  que só serve pra tarefa PAUSADA). O agente lê no próximo passo — some
   *  do campo na hora, mas leva alguns segundos pra aparecer no histórico. */
  async function handleSendLive(e: React.FormEvent) {
    e.preventDefault();
    if (!activeTaskId || !liveText.trim() || sendingLive) return;
    setSendingLive(true);
    const text = liveText.trim();
    setLiveText('');
    try {
      await api.post(`/api/browser-agent/tasks/${activeTaskId}/message`, { text });
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao enviar a mensagem', 'error');
      setLiveText(text); // devolve o texto pro campo — não perde o que foi digitado
    } finally {
      setSendingLive(false);
    }
  }

  async function handleSavePlaybook() {
    if (!activeTaskId || savingPlaybook) return;
    setSavingPlaybook(true);
    try {
      const { data } = await api.post(`/api/browser-agent/tasks/${activeTaskId}/save-playbook`);
      toast(`Guia "${data.title}" salvo! Revise na aba Guias.`);
      queryClient.invalidateQueries({ queryKey: ['browser-agent-playbooks'] });
      setPageTab('guias');
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Erro ao gerar o guia', 'error');
    } finally {
      setSavingPlaybook(false);
    }
  }

  async function openTask(task: AgentTask) {
    setActiveTaskId(task.id);
    setStatus(task.status);
    setResult({ summary: task.resultSummary, error: task.errorMessage });
    setPendingAction(task.pendingAction || null);
    setSteps([]);
    setExpandedGroups(new Set());
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

      <div className="flex items-center gap-1 px-6 pt-3 border-b border-af-border flex-shrink-0">
        <button
          onClick={() => setPageTab('tarefas')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-2 rounded-t-lg text-sm font-medium border-b-2 -mb-px transition-colors',
            pageTab === 'tarefas' ? 'border-af-accent text-af-accent' : 'border-transparent text-slate-500 hover:text-slate-700'
          )}
        >
          <ListChecks size={15} /> Tarefas
        </button>
        <button
          onClick={() => setPageTab('guias')}
          className={cn(
            'flex items-center gap-1.5 px-3 py-2 rounded-t-lg text-sm font-medium border-b-2 -mb-px transition-colors',
            pageTab === 'guias' ? 'border-af-accent text-af-accent' : 'border-transparent text-slate-500 hover:text-slate-700'
          )}
        >
          <BookOpen size={15} /> Guias
        </button>
      </div>

      {pageTab === 'guias' && <PlaybooksTab />}

      {pageTab === 'tarefas' && (
        <div className="flex-1 overflow-hidden flex">
          {/* Barra lateral: histórico de tarefas com busca — estilo lista de
              conversas de um app de chat, em vez do bloco "Histórico" fixo
              de antes. */}
          <div className="w-64 flex-shrink-0 border-r border-af-border flex flex-col bg-af-light/40">
            <div className="p-2.5 space-y-2 border-b border-af-border flex-shrink-0">
              <button
                onClick={resetComposer}
                className="w-full flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-white border border-af-border text-slate-600 hover:border-af-accent hover:text-af-accent transition-colors"
              >
                <Plus size={13} /> Nova tarefa
              </button>
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                <input
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                  placeholder="Buscar no histórico…"
                  className="w-full pl-7 pr-2 py-1.5 text-xs border border-af-border rounded-lg bg-white text-slate-700 focus:outline-none focus:ring-1 focus:ring-af-accent"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin px-2 py-2 space-y-1">
              {filteredTasks.map((t) => {
                const meta = STATUS_META[t.status];
                return (
                  <button
                    key={t.id}
                    onClick={() => openTask(t)}
                    className={cn(
                      'w-full text-left px-3 py-2 rounded-lg text-xs transition-colors',
                      t.id === activeTaskId ? 'bg-af-mid/10 border border-af-mid/30' : 'hover:bg-white border border-transparent'
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
              {filteredTasks.length === 0 && (
                <p className="text-xs text-slate-400 px-1 py-2">
                  {historySearch ? 'Nenhuma tarefa encontrada.' : 'Nenhuma tarefa ainda.'}
                </p>
              )}
            </div>
          </div>

          {/* Coluna principal: chat */}
          <div className="flex-1 flex overflow-hidden">
            <div className="flex-1 flex flex-col overflow-hidden">
              {!activeTaskId ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6">
                  <MousePointerClick size={32} className="text-slate-300" />
                  <p className="text-sm text-slate-400 text-center max-w-sm">
                    Descreva uma tarefa pra IA controlar o Chrome, ou escolha uma da lista ao lado.
                  </p>
                  <form onSubmit={handleStart} className="w-full max-w-xl flex flex-col gap-2">
                    <div className="flex gap-2">
                      <LeadPicker value={leadId} onChange={setLeadId} disabled={starting} />
                      <input
                        type="text"
                        value={instruction}
                        onChange={(e) => setInstruction(e.target.value)}
                        placeholder='Ex.: "abra o google.com e pesquise gatos"'
                        disabled={starting}
                        className="flex-1 px-4 py-2.5 text-sm border border-af-border rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent disabled:opacity-50"
                      />
                      <button
                        type="submit"
                        disabled={starting || !instruction.trim()}
                        className="flex items-center gap-1.5 px-4 py-2.5 rounded-lg bg-af-mid text-white text-sm font-medium hover:bg-af-dark disabled:opacity-50"
                      >
                        {starting ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
                        Iniciar
                      </button>
                    </div>
                    <p className="text-xs text-slate-400 text-center">A extensão do Chrome precisa estar instalada, logada e conectada.</p>
                  </form>
                </div>
              ) : (
                <>
                  <div className="flex items-center justify-between px-4 py-2.5 border-b border-af-border flex-shrink-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {statusMeta && (
                        <span className={cn('flex items-center gap-1 text-xs font-medium', statusMeta.color)}>
                          <statusMeta.icon size={13} className={status === 'RUNNING' ? 'animate-spin' : ''} />
                          {statusMeta.label}
                        </span>
                      )}
                    </div>
                    {(isRunning || isPaused) && (
                      <button onClick={handleCancel} className="flex items-center gap-1 text-xs text-red-500 hover:text-red-600 font-medium">
                        <X size={13} /> Cancelar
                      </button>
                    )}
                  </div>

                  {/* Transcrição em formato de chat */}
                  <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-4 space-y-3">
                    {/* A instrução original vira a 1ª bolha, como uma mensagem sua. */}
                    {activeTask && (
                      <div className="flex justify-end">
                        <p className="max-w-[75%] text-sm px-3.5 py-2.5 rounded-2xl rounded-br-sm bg-af-navy text-white">
                          {activeTask.instruction}
                        </p>
                      </div>
                    )}

                    {steps.length === 0 && isRunning && (
                      <p className="text-xs text-slate-400 italic">Aguardando a IA decidir o primeiro passo…</p>
                    )}

                    {blocks.map((block, i) => {
                      if (block.kind === 'message') {
                        return (
                          <div key={`b${i}`} className="flex justify-end">
                            <p className="max-w-[75%] text-sm px-3.5 py-2.5 rounded-2xl rounded-br-sm bg-af-mid text-white">
                              {String(block.step.input.text ?? block.step.summary)}
                            </p>
                          </div>
                        );
                      }
                      if (block.kind === 'ask') {
                        const s = block.step;
                        return (
                          <div key={`b${i}`} className="flex items-start gap-2">
                            <MessageCircleQuestion size={16} className="flex-shrink-0 mt-1 text-amber-500" />
                            <p className="max-w-[75%] text-sm px-3.5 py-2.5 rounded-2xl rounded-bl-sm bg-amber-50 text-amber-800">
                              {String(s.input.message ?? s.summary)}
                            </p>
                          </div>
                        );
                      }
                      // Bloco de ações (cliques/digitação) — recolhido por padrão, igual
                      // "Usado o Claude no Chrome (N ações)": expande só se pedir.
                      const isOpen = expandedGroups.has(i);
                      const last = block.steps[block.steps.length - 1];
                      const failed = block.steps.some((s) => !s.ok);
                      return (
                        <div key={`b${i}`} className="max-w-[85%]">
                          <button
                            onClick={() =>
                              setExpandedGroups((prev) => {
                                const next = new Set(prev);
                                next.has(i) ? next.delete(i) : next.add(i);
                                return next;
                              })
                            }
                            className={cn(
                              'w-full flex items-center gap-2 text-xs px-3 py-2 rounded-xl border transition-colors text-left',
                              failed ? 'bg-red-50 border-red-200 text-red-600' : 'bg-slate-50 border-af-border text-slate-500 hover:bg-slate-100'
                            )}
                          >
                            {isOpen ? <ChevronDown size={13} className="flex-shrink-0" /> : <ChevronRight size={13} className="flex-shrink-0" />}
                            <MonitorPlay size={13} className="flex-shrink-0" />
                            <span className="flex-1">
                              Usado {block.steps.length} ação{block.steps.length !== 1 ? 'ões' : ''}
                              {failed && ' — com erro'}
                            </span>
                            {!isOpen && last?.screenshot && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={`data:image/png;base64,${last.screenshot}`}
                                alt=""
                                className="w-10 h-7 object-cover rounded border border-af-border flex-shrink-0"
                              />
                            )}
                          </button>
                          {isOpen && (
                            <div className="mt-1.5 space-y-1 pl-2 border-l-2 border-af-border ml-2">
                              {block.steps.map((s) => (
                                <div key={s.seq} className={cn('text-xs px-3 py-2 rounded-lg', s.ok ? 'bg-slate-50' : 'bg-red-50')}>
                                  <p className="font-medium text-slate-700">
                                    {s.seq}. {toolLabel(s.tool, s.input)}
                                  </p>
                                  {s.summary && <p className={cn('mt-0.5', s.ok ? 'text-slate-500' : 'text-red-600')}>{s.summary}</p>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {(result?.summary || result?.error) && (
                      <div className="flex items-start gap-2">
                        <div
                          className={cn(
                            'max-w-[85%] text-sm px-3.5 py-2.5 rounded-2xl rounded-bl-sm font-medium',
                            result.error ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-700'
                          )}
                        >
                          {result.error || result.summary}
                        </div>
                      </div>
                    )}
                    {status === 'COMPLETED' && (
                      <button
                        onClick={handleSavePlaybook}
                        disabled={savingPlaybook}
                        className="flex items-center gap-1.5 text-xs font-medium text-af-accent hover:text-af-dark disabled:opacity-50"
                      >
                        {savingPlaybook ? <Loader2 size={13} className="animate-spin" /> : <BookmarkPlus size={13} />}
                        Guardar como guia
                      </button>
                    )}
                    {isPaused && pendingAction && (
                      <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2.5 max-w-[85%]">
                        <p className="flex items-start gap-1.5 text-xs font-medium text-amber-800">
                          <MessageCircleQuestion size={14} className="flex-shrink-0 mt-0.5" />
                          {pendingAction.message}
                        </p>
                        {pendingAction.kind === 'approval' ? (
                          <div className="flex gap-2">
                            <button
                              onClick={() => handleRespond({ approve: true })}
                              disabled={responding}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 disabled:opacity-50"
                            >
                              <ThumbsUp size={13} /> Aprovar
                            </button>
                            <button
                              onClick={() => handleRespond({ approve: false })}
                              disabled={responding}
                              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white border border-red-300 text-red-600 text-xs font-medium hover:bg-red-50 disabled:opacity-50"
                            >
                              <ThumbsDown size={13} /> Recusar
                            </button>
                          </div>
                        ) : (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (answerText.trim()) handleRespond({ answer: answerText.trim() });
                            }}
                            className="flex gap-2"
                          >
                            <input
                              autoFocus
                              value={answerText}
                              onChange={(e) => setAnswerText(e.target.value)}
                              placeholder="Digite a resposta…"
                              disabled={responding}
                              className="flex-1 px-3 py-1.5 text-xs border border-amber-300 rounded-lg bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent disabled:opacity-50"
                            />
                            <button
                              type="submit"
                              disabled={responding || !answerText.trim()}
                              className="px-3 py-1.5 rounded-lg bg-af-mid text-white text-xs font-medium hover:bg-af-dark disabled:opacity-50"
                            >
                              Responder
                            </button>
                          </form>
                        )}
                      </div>
                    )}
                    <div ref={transcriptEndRef} />
                  </div>

                  {(status === 'RUNNING' || status === 'PENDING') && (
                    <form onSubmit={handleSendLive} className="flex gap-2 px-4 py-3 border-t border-af-border bg-af-light/40 flex-shrink-0">
                      <input
                        value={liveText}
                        onChange={(e) => setLiveText(e.target.value)}
                        placeholder="Mandar uma mensagem pro agente (ele lê antes do próximo passo)…"
                        disabled={sendingLive}
                        className="flex-1 px-3.5 py-2 text-sm border border-af-border rounded-full bg-white text-slate-800 focus:outline-none focus:ring-1 focus:ring-af-accent disabled:opacity-50"
                      />
                      <button
                        type="submit"
                        disabled={sendingLive || !liveText.trim()}
                        className="flex items-center justify-center w-9 h-9 rounded-full bg-af-mid text-white hover:bg-af-dark disabled:opacity-50 flex-shrink-0"
                      >
                        {sendingLive ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                      </button>
                    </form>
                  )}
                </>
              )}
            </div>

            {/* Painel direito: tela ao vivo */}
            {activeTaskId && (
              <div className="w-[380px] flex-shrink-0 border-l border-af-border flex flex-col bg-white overflow-hidden">
                <div className="flex items-center gap-1.5 px-3.5 py-2.5 border-b border-af-border flex-shrink-0">
                  <MonitorPlay size={14} className="text-slate-400" />
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Tela ao vivo</p>
                  {status === 'RUNNING' && <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse ml-auto" />}
                </div>
                <div className="flex-1 bg-slate-900 flex items-center justify-center overflow-hidden">
                  {currentScreenshot ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={`data:image/png;base64,${currentScreenshot}`} alt="Tela atual" className="w-full h-auto" />
                  ) : (
                    <p className="text-xs text-slate-500 p-4 text-center">A tela aparece aqui assim que o primeiro passo rodar.</p>
                  )}
                </div>
                {activeTask && (
                  <div className="px-3.5 py-2.5 border-t border-af-border text-xs text-slate-400 flex-shrink-0 space-y-0.5">
                    <p>{activeTask.stepCount} passo{activeTask.stepCount !== 1 ? 's' : ''} até agora</p>
                    <p>Criada {new Date(activeTask.createdAt).toLocaleString('pt-BR')}</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
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
