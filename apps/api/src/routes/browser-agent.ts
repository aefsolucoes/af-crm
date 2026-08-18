import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { getExtensionSocketId } from '../websocket';
import { runAgentLoop } from '../services/browser-agent.service';

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
  if (!getExtensionSocketId(req.user!.id)) {
    res.status(409).json({ error: 'Extensão do Agente de Navegador não está conectada. Abra o Chrome com a extensão carregada e logada, numa aba comum.' });
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

export default router;
