import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { loginService, refreshService } from '../services/auth.service';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', validate(loginSchema), async (req: Request, res: Response) => {
  try {
    const result = await loginService(req.body.email, req.body.password);
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro interno';
    res.status(401).json({ error: message });
  }
});

router.post('/refresh', async (req: Request, res: Response) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    res.status(400).json({ error: 'Refresh token obrigatório' });
    return;
  }
  try {
    const result = refreshService(refreshToken);
    res.json(result);
  } catch {
    res.status(401).json({ error: 'Refresh token inválido' });
  }
});

export default router;
