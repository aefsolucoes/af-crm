import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { loginService, verifyLoginCodeService, refreshService, requestPasswordReset, resetPasswordWithToken } from '../services/auth.service';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const verifyCodeSchema = z.object({
  email: z.string().email(),
  code: z.string().min(4).max(8),
});

// 1ª etapa do login: e-mail + senha. Pode devolver os tokens direto (se o e-mail
// não estiver configurado) ou { requiresCode: true } pedindo a 2ª etapa.
router.post('/login', validate(loginSchema), async (req: Request, res: Response) => {
  try {
    const result = await loginService(req.body.email, req.body.password);
    res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Erro interno';
    res.status(401).json({ error: message });
  }
});

// 2ª etapa: confere o código enviado por e-mail e entrega os tokens.
router.post('/verify-code', validate(verifyCodeSchema), async (req: Request, res: Response) => {
  try {
    const result = await verifyLoginCodeService(req.body.email, req.body.code);
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
    const result = await refreshService(refreshToken);
    res.json(result);
  } catch {
    res.status(401).json({ error: 'Refresh token inválido' });
  }
});

// "Esqueci minha senha" — trava simples por IP (20 pedidos/hora) contra abuso.
const resetHits = new Map<string, number[]>();
function tooManyResets(ip: string) {
  const now = Date.now();
  const hits = (resetHits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  hits.push(now);
  resetHits.set(ip, hits);
  return hits.length > 20;
}

router.post('/forgot-password', async (req: Request, res: Response) => {
  const email = String(req.body?.email || '').trim();
  if (!email) return res.status(400).json({ error: 'Informe o e-mail' });
  if (tooManyResets(req.ip || 'x')) return res.status(429).json({ error: 'Muitos pedidos — tente de novo daqui a pouco.' });
  const frontendUrl = process.env.PUBLIC_FRONTEND_URL || 'https://crm.aefsolucoesfinanceiras.com.br';
  try {
    await requestPasswordReset(email, frontendUrl);
  } catch (err: unknown) {
    console.error('[Senha] Falha ao mandar link de redefinição:', err instanceof Error ? err.message : err);
    if (err instanceof Error && err.message.includes('não está configurado')) return res.status(503).json({ error: err.message });
  }
  // Mesma resposta exista ou não a conta.
  res.json({ ok: true });
});

router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    await resetPasswordWithToken(String(req.body?.token || ''), String(req.body?.password || ''));
    res.json({ ok: true });
  } catch (err: unknown) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Não consegui trocar a senha' });
  }
});

export default router;
