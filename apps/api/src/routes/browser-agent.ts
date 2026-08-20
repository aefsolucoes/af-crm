import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { getExtensionSocketId } from '../websocket';
import { runAgentLoop, applyHumanResponse, continueAgentLoop, generatePlaybookFromTask } from '../services/browser-agent.service';

const prisma = new PrismaClient();
const router = Router();
router.use(authMiddleware);
router.use(requirePermission('browser_agent'));

/**
 * Fase 0 — rotas de teste MANUAIS do Agente de Navegador. Sem Claude, sem
 * persistência: só provam que o cano existe (API → socket.io → extensão →
 * Chrome DevTools Protocol na aba real → volta). Cada rota relaya um comando
 * síncrono pro socket da extensão do usuário logado e espera a resposta (com
 * timeout) — exatamente o mecanismo que o loop de decisão real vai usar na
 * Fase 1, só que aqui quem decide "qual ação" é você, testando com curl, não
 * o Claude.
 */
async function relayToExtension<T = unknown>(
  req: AuthRequest,
  res: Response,
  event: string,
  payload: Record<string, unknown>
): Promise<void> {
  const io = req.app.get('io');
  const socketId = getExtensionSocketId(req.user!.id);
  if (!socketId) {
    res.status(409).json({ error: 'Extensão do Agente de Navegador não está conectada. Abra o Chrome com a extensão carregada e logada.' });
    return;
  }
  try {
    const result = await io
      .to(socketId)
      .timeout(15000)
      .emitWithAck(event, payload) as T[];
    // emitWithAck com .to(socketId) devolve um array (1 resposta por socket
    // na sala/alvo) — aqui é sempre 1 socket, então pega o primeiro.
    res.json(result[0] ?? { error: 'Extensão não respondeu' });
  } catch (err: any) {
    res.status(504).json({ error: `Extensão não respondeu a tempo: ${err?.message || 'timeout'}` });
  }
}

router.post('/test/screenshot', async (req: AuthRequest, res: Response) => {
  await relayToExtension(req, res, 'agent_command', { type: 'screenshot' });
});

router.post('/test/click', async (req: AuthRequest, res: Response) => {
  const { x, y } = req.body as { x?: number; y?: number };
  if (typeof x !== 'number' || typeof y !== 'number') {
    res.status(400).json({ error: 'x e y (números) são obrigatórios' });
    return;
  }
  await relayToExtension(req, res, 'agent_command', { type: 'click', x, y });
});

router.post('/test/type', async (req: AuthRequest, res: Response) => {
  const { text } = req.body as { text?: string };
  if (!text) {
    res.status(400).json({ error: 'text é obrigatório' });
    return;
  }
  await relayToExtension(req, res, 'agent_command', { type: 'type', text });
});

// ── Fase 1 — tarefas de verdade, decididas pela IA ──────────────────────────

router.post('/tasks', async (req: AuthRequest, res: Response) => {
  const { instruction, leadId } = req.body as { instruction?: string; leadId?: string };
  if (!instruction?.trim()) {
    res.status(400).json({ error: 'instruction é obrigatório' });
    return;
  }
  if (leadId) {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId: req.user!.accountId } });
    if (!lead) {
      res.status(400).json({ error: 'Lead não encontrado.' });
      return;
    }
  }
  if (!getExtensionSocketId(req.user!.id)) {
    res.status(409).json({ error: 'Extensão do Agente de Navegador não está conectada. Abra o Chrome com a extensão carregada e logada.' });
    return;
  }
  const task = await prisma.agentTask.create({
    data: {
      accountId: req.user!.accountId,
      userId: req.user!.id,
      leadId: leadId || null,
      instruction: instruction.trim(),
      status: 'PENDING',
    },
  });
  res.status(201).json(task);

  // Dispara o loop em background — a requisição HTTP já respondeu. Cada
  // passo do loop pode levar segundos (ida-e-volta real até o Chrome do
  // usuário), inviável segurar isso numa única requisição aberta.
  const io = req.app.get('io');
  runAgentLoop(task.id, req.user!.accountId, req.user!.id, io).catch((err) => {
    console.error('[Agente de Navegador] Loop caiu com erro não tratado:', err);
  });
});

router.get('/tasks', async (req: AuthRequest, res: Response) => {
  const tasks = await prisma.agentTask.findMany({
    where: { accountId: req.user!.accountId },
    orderBy: { createdAt: 'desc' },
    take: 30,
  });
  res.json(tasks);
});

router.get('/tasks/:id', async (req: AuthRequest, res: Response) => {
  const task = await prisma.agentTask.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
  if (!task) {
    res.status(404).json({ error: 'Tarefa não encontrada' });
    return;
  }
  const logs = await prisma.agentActionLog.findMany({ where: { taskId: task.id }, orderBy: { seq: 'asc' } });
  res.json({ ...task, logs });
});

router.post('/tasks/:id/cancel', async (req: AuthRequest, res: Response) => {
  const task = await prisma.agentTask.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
  if (!task) {
    res.status(404).json({ error: 'Tarefa não encontrada' });
    return;
  }
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(task.status)) {
    res.json(task); // já tinha terminado — nada a fazer
    return;
  }
  const updated = await prisma.agentTask.update({
    where: { id: task.id },
    data: { status: 'CANCELLED', completedAt: new Date() },
  });
  // O loop confere o status a cada passo e para sozinho ao ver CANCELLED;
  // aqui só avisamos a tela na hora, sem esperar o próximo passo dele.
  const io = req.app.get('io');
  io.to(`user_${task.userId}`).emit('agent_task_status', { taskId: task.id, status: 'CANCELLED' });
  res.json(updated);
});

// Responde uma tarefa pausada em AWAITING_APPROVAL ({approve: boolean}) ou
// AWAITING_ANSWER ({answer: string}) — completa o turno pendente e retoma o
// loop em background, mesmo padrão fire-and-forget do POST /tasks acima.
router.post('/tasks/:id/respond', async (req: AuthRequest, res: Response) => {
  const io = req.app.get('io');
  const body = req.body as { approve?: boolean; answer?: string };
  const response = typeof body.approve === 'boolean' ? { approve: body.approve } : { answer: String(body.answer ?? '') };

  const result = await applyHumanResponse(req.params.id, req.user!.accountId, response, io);
  if (!result.ok) {
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json(result.task);

  continueAgentLoop(req.params.id, req.user!.accountId, io).catch((err) => {
    console.error('[Agente de Navegador] Retomada do loop caiu com erro não tratado:', err);
  });
});

// Gera um AgentPlaybook a partir de uma tarefa CONCLUÍDA — uma chamada à IA
// (ver generatePlaybookFromTask), síncrona (não é rápido tipo /respond, mas
// também não é uma tarefa longa como o loop principal — só 1 chamada).
router.post('/tasks/:id/save-playbook', async (req: AuthRequest, res: Response) => {
  const task = await prisma.agentTask.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
  if (!task) {
    res.status(404).json({ error: 'Tarefa não encontrada' });
    return;
  }
  if (task.status !== 'COMPLETED') {
    res.status(409).json({ error: 'Só dá pra guardar como guia uma tarefa CONCLUÍDA.' });
    return;
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor.' });
    return;
  }
  const logs = await prisma.agentActionLog.findMany({ where: { taskId: task.id }, orderBy: { seq: 'asc' } });
  if (logs.length === 0) {
    res.status(400).json({ error: 'Essa tarefa não tem nenhum passo registrado.' });
    return;
  }
  try {
    const { domain, title, steps } = await generatePlaybookFromTask(apiKey, task, logs);
    const playbook = await prisma.agentPlaybook.create({
      data: { accountId: req.user!.accountId, domain, title, steps, sourceTaskId: task.id },
    });
    res.status(201).json(playbook);
  } catch (err: any) {
    console.error('[Agente de Navegador] Falha ao gerar guia:', err);
    res.status(500).json({ error: err?.message || 'Erro ao gerar o guia.' });
  }
});

// ── Guias (AgentPlaybook) — CRUD simples pra tela de revisão/edição ─────────

router.get('/playbooks', async (req: AuthRequest, res: Response) => {
  const playbooks = await prisma.agentPlaybook.findMany({
    where: { accountId: req.user!.accountId },
    orderBy: { updatedAt: 'desc' },
  });
  res.json(playbooks);
});

router.post('/playbooks', async (req: AuthRequest, res: Response) => {
  const { domain, title, steps } = req.body as { domain?: string; title?: string; steps?: string };
  if (!domain?.trim() || !title?.trim() || !steps?.trim()) {
    res.status(400).json({ error: 'domain, title e steps são obrigatórios' });
    return;
  }
  const playbook = await prisma.agentPlaybook.create({
    data: { accountId: req.user!.accountId, domain: domain.trim(), title: title.trim(), steps: steps.trim() },
  });
  res.status(201).json(playbook);
});

router.patch('/playbooks/:id', async (req: AuthRequest, res: Response) => {
  const existing = await prisma.agentPlaybook.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
  if (!existing) {
    res.status(404).json({ error: 'Guia não encontrado' });
    return;
  }
  const { domain, title, steps, active } = req.body as { domain?: string; title?: string; steps?: string; active?: boolean };
  const playbook = await prisma.agentPlaybook.update({
    where: { id: existing.id },
    data: {
      ...(domain !== undefined ? { domain: String(domain).trim() } : {}),
      ...(title !== undefined ? { title: String(title).trim() } : {}),
      ...(steps !== undefined ? { steps: String(steps).trim() } : {}),
      ...(active !== undefined ? { active: !!active } : {}),
    },
  });
  res.json(playbook);
});

router.delete('/playbooks/:id', async (req: AuthRequest, res: Response) => {
  const existing = await prisma.agentPlaybook.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
  if (!existing) {
    res.status(404).json({ error: 'Guia não encontrado' });
    return;
  }
  await prisma.agentPlaybook.delete({ where: { id: existing.id } });
  res.json({ ok: true });
});

export default router;
