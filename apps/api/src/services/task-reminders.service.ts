import { prisma } from '../lib/prisma';

/**
 * PUSH DAS TAREFAS (Fabio 22/10: "quero que as tarefas ou agendamentos cheguem em push"). Poller (1 min): tarefa NÃO concluída cuja hora chegou e que ainda não avisou → push SÓ pro dono da tarefa
 * (celular com o app fechado inclusive), com o nome do cliente; clicar abre o card (ou a página de Tarefas, se for lembrete pessoal). Vale também pras tarefas que o CRM cria sozinho
 * (ex.: "📞 Ligar para … — quando" do balão Dúvidas da IA). Tarefa que venceu há mais de 6 h sem avisar (CRM fora do ar) não avisa tarde demais: só marca. Estado: Task.reminderSentAt.
 */
const WINDOW_MS = 6 * 3600_000;
const BRT_MS = 3 * 3600_000;
const hhmm = (d: Date) => new Date(d.getTime() - BRT_MS).toISOString().slice(11, 16);

export async function processTaskReminders(): Promise<void> {
  const now = new Date();
  const tasks = await prisma.task.findMany({
    where: { done: false, reminderSentAt: null, dueAt: { lte: now } },
    include: { user: { select: { id: true, accountId: true } }, lead: { select: { id: true, name: true } } },
    orderBy: { dueAt: 'asc' },
    take: 60,
  });
  for (const t of tasks) {
    // marca primeiro (uma instância só avisa): updateMany devolve 0 se outra já marcou
    const got = await prisma.task.updateMany({ where: { id: t.id, reminderSentAt: null }, data: { reminderSentAt: new Date() } });
    if (!got.count) continue;
    if (now.getTime() - t.dueAt.getTime() > WINDOW_MS) continue; // venceu faz tempo: não avisa fora de hora
    try {
      const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
      await sendPushToAccount(t.user.accountId, {
        title: `⏰ ${t.title}`.slice(0, 90),
        body: `${t.lead ? `${t.lead.name} · ` : ''}agora (${hhmm(t.dueAt)})`.slice(0, 140),
        leadId: t.lead?.id,
        url: t.lead ? `/inbox?leadId=${t.lead.id}` : '/tarefas',
      }, [t.user.id]);
    } catch (e: any) { console.warn('[Tarefas] push:', e?.message); }
  }
}
