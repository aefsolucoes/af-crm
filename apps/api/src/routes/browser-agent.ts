import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { getExtensionSocketId } from '../websocket';

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

export default router;
