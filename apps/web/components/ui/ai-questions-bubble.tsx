'use client';
import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageCircleQuestion, Bot, BookOpen, Send, X, Hand, Undo2, Loader2 } from 'lucide-react';
import api from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { playSoundOnce, SoundKey } from '@/lib/sounds';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth.store';
import { cn } from '@/lib/utils';

/**
 * Balão "Dúvidas da IA" — um chat entre a IA que atende os clientes sozinha
 * e a equipe. Quando a IA não sabe responder um cliente, ela avisa o cliente
 * que vai verificar e pergunta aqui; o colaborador responde, a IA escreve a
 * mensagem e manda pro cliente, e se a resposta for regra geral guarda na
 * Base de Conhecimento (vai aprendendo). Backend: ai-team-question.service.ts.
 * O servidor só avisa (socket) quem é do setor do card; a lista vem filtrada.
 */
interface AiQuestion {
  id: string;
  leadId: string;
  question: string;
  clientMessage: string | null;
  status: 'OPEN' | 'ANSWERED' | 'DISMISSED';
  answer: string | null;
  answeredByName: string | null;
  answeredAt: string | null;
  sentReply: string | null;
  sendError: string | null;
  knowledgeEntryId: string | null;
  knowledgeTitle: string | null;
  createdAt: string;
  lead: { name: string };
}

function timeAgo(iso: string) {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

export function AiQuestionsBubble() {
  const { user } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const { data: questions = [] } = useQuery<AiQuestion[]>({
    queryKey: ['ai-questions'],
    queryFn: async () => (await api.get('/api/ai-questions')).data,
    enabled: !!user,
    refetchInterval: 60_000,
  });
  const pending = questions.filter((q) => q.status === 'OPEN');

  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();
    function onNew(data: { leadName?: string; isNew?: boolean }) {
      queryClient.invalidateQueries({ queryKey: ['ai-questions'] });
      if (!data?.isNew) return;
      const saved = (typeof window !== 'undefined' && localStorage.getItem('af_notification_sound')) || 'whatsapp';
      if (saved !== 'none') playSoundOnce(saved as SoundKey);
      toast(`A IA tem uma dúvida sobre ${data.leadName || 'um cliente'} — veja no balão de Dúvidas da IA.`, 'warning');
    }
    function onUpdated() { queryClient.invalidateQueries({ queryKey: ['ai-questions'] }); }
    socket.on('ai_team_question', onNew);
    socket.on('ai_team_question_updated', onUpdated);
    return () => {
      socket.off('ai_team_question', onNew);
      socket.off('ai_team_question_updated', onUpdated);
    };
  }, [queryClient]);

  async function act(q: AiQuestion, action: 'answer' | 'dismiss' | 'forget') {
    const answer = (drafts[q.id] || '').trim();
    if (action === 'answer' && !answer) return;
    setBusy(`${q.id}:${action}`);
    try {
      await api.post(`/api/ai-questions/${q.id}/${action}`, action === 'answer' ? { answer } : {});
      if (action === 'answer') setDrafts((d) => ({ ...d, [q.id]: '' }));
      if (action === 'dismiss') {
        setOpen(false);
        router.push(`/inbox?leadId=${q.leadId}`);
      }
      await queryClient.invalidateQueries({ queryKey: ['ai-questions'] });
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Não deu certo, tente de novo.', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (!user) return null;

  // No celular, dentro da Inbox o botão cobriria o campo de digitar/enviar.
  const hideOnMobile = pathname.startsWith('/inbox');
  const ordered = [...pending, ...questions.filter((q) => q.status !== 'OPEN')];

  return (
    <>
      {open && (
        <div className="fixed z-[95] bottom-20 right-4 md:right-5 w-[400px] max-w-[calc(100vw-2rem)] h-[600px] max-h-[calc(100vh-7rem)] flex flex-col rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
          <div className="flex items-center gap-2.5 px-4 py-3 text-white" style={{ backgroundColor: '#2261a8' }}>
            <Bot size={20} className="flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-tight">Dúvidas da IA</p>
              <p className="text-[11px] text-white/75 leading-tight">Quando não sabe responder um cliente, a IA pergunta aqui</p>
            </div>
            <button onClick={() => setOpen(false)} className="p-1 rounded-md hover:bg-white/15" aria-label="Fechar">
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto bg-slate-50 p-3 space-y-3">
            {ordered.length === 0 && (
              <div className="h-full flex flex-col items-center justify-center text-center px-6 text-slate-400">
                <MessageCircleQuestion size={32} className="mb-2" />
                <p className="text-sm">Nenhuma dúvida por aqui.</p>
                <p className="text-xs mt-1">Quando a IA não souber responder um cliente, ela diz que vai verificar e pergunta aqui pra equipe.</p>
              </div>
            )}

            {ordered.map((q) => (
              <div key={q.id} className={cn('rounded-xl border bg-white p-3', q.status === 'OPEN' ? 'border-amber-300' : 'border-slate-200 opacity-90')}>
                <div className="flex items-center gap-2 mb-2">
                  <button
                    onClick={() => { setOpen(false); router.push(`/inbox?leadId=${q.leadId}`); }}
                    className="text-sm font-semibold text-slate-800 hover:text-[#2261a8] truncate text-left"
                    title="Abrir conversa"
                  >
                    {q.lead.name}
                  </button>
                  <span className="text-[11px] text-slate-400 flex-shrink-0">{timeAgo(q.createdAt)}</span>
                  <span className={cn('ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded-full flex-shrink-0',
                    q.status === 'OPEN' ? 'bg-amber-100 text-amber-700' : q.status === 'ANSWERED' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500')}>
                    {q.status === 'OPEN' ? 'Aguardando' : q.status === 'ANSWERED' ? 'Respondida' : 'Assumida'}
                  </span>
                </div>

                {q.clientMessage && (
                  <p className="text-xs text-slate-500 border-l-2 border-slate-200 pl-2 mb-2 line-clamp-3 whitespace-pre-line">Cliente: {q.clientMessage}</p>
                )}

                <div className="flex gap-2">
                  <div className="w-6 h-6 rounded-full bg-[#2261a8]/10 text-[#2261a8] flex items-center justify-center flex-shrink-0"><Bot size={13} /></div>
                  <div className="text-sm text-slate-700 bg-slate-100 rounded-xl rounded-tl-sm px-3 py-2 whitespace-pre-line">{q.question}</div>
                </div>

                {q.answer && (
                  <div className="flex justify-end mt-2">
                    <div className="max-w-[85%] text-sm text-white rounded-xl rounded-tr-sm px-3 py-2 whitespace-pre-line" style={{ backgroundColor: '#2261a8' }}>
                      {q.answer}
                      {q.answeredByName && <span className="block text-[10px] text-white/70 mt-0.5 text-right">{q.answeredByName}</span>}
                    </div>
                  </div>
                )}

                {q.status === 'ANSWERED' && q.sentReply && (
                  <p className="text-xs text-slate-500 mt-2"><span className="font-medium text-emerald-700">Enviado ao cliente:</span> “{q.sentReply}”</p>
                )}
                {q.status === 'DISMISSED' && (
                  <p className="text-xs text-slate-500 mt-2">{q.answeredByName || 'Alguém da equipe'} assumiu a conversa — a IA foi desligada nesse card.</p>
                )}
                {q.knowledgeTitle && (
                  <div className="flex items-center gap-1.5 mt-1.5 text-xs text-[#2261a8]">
                    <BookOpen size={12} className="flex-shrink-0" />
                    <span className="truncate">Aprendi: {q.knowledgeTitle}</span>
                    <button
                      onClick={() => act(q, 'forget')}
                      disabled={busy === `${q.id}:forget`}
                      className="ml-auto flex items-center gap-0.5 text-slate-400 hover:text-red-500 flex-shrink-0"
                      title="Não era regra geral — tirar da Base de Conhecimento"
                    >
                      <Undo2 size={11} /> desfazer
                    </button>
                  </div>
                )}

                {q.status === 'OPEN' && (
                  <div className="mt-2.5">
                    {q.sendError && (
                      <p className="text-xs text-red-600 mb-1.5">Não foi pro cliente: {q.sendError}. Responda pela Inbox ou tente de novo.</p>
                    )}
                    <textarea
                      value={drafts[q.id] || ''}
                      onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); act(q, 'answer'); }
                      }}
                      rows={2}
                      placeholder="Responda aqui — a IA passa pro cliente"
                      className="w-full text-sm rounded-lg border border-slate-200 px-2.5 py-1.5 resize-none focus:outline-none focus:border-[#2261a8] text-slate-800"
                    />
                    <div className="flex items-center justify-end gap-2 mt-1.5">
                      <button
                        onClick={() => act(q, 'dismiss')}
                        disabled={!!busy}
                        className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg text-slate-500 hover:bg-slate-100"
                        title="Fecha a dúvida, desliga a IA nesse card e abre a conversa pra você falar direto"
                      >
                        <Hand size={12} /> Eu assumo
                      </button>
                      <button
                        onClick={() => act(q, 'answer')}
                        disabled={!!busy || !(drafts[q.id] || '').trim()}
                        className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg text-white font-medium disabled:opacity-50"
                        style={{ backgroundColor: '#2261a8' }}
                      >
                        {busy === `${q.id}:answer` ? <><Loader2 size={12} className="animate-spin" /> Passando pro cliente...</> : <><Send size={12} /> Responder</>}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'fixed z-[95] bottom-4 right-4 md:bottom-5 md:right-5 w-[52px] h-[52px] rounded-full text-white shadow-lg flex items-center justify-center hover:brightness-110 transition',
          hideOnMobile && !open && 'hidden md:flex',
          pending.length > 0 && !open && 'animate-pulse',
        )}
        style={{ backgroundColor: '#2261a8' }}
        aria-label="Dúvidas da IA"
        title="Dúvidas da IA"
      >
        {open ? <X size={22} /> : <MessageCircleQuestion size={24} />}
        {pending.length > 0 && !open && (
          <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center border-2 border-white">
            {pending.length}
          </span>
        )}
      </button>
    </>
  );
}
