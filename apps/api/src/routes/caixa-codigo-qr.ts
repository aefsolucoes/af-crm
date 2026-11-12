import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { conectarQr, statusQr, desconectarQr } from '../services/caixa-codigo-qr.service';

// WhatsApp por QR só pra receber o código do simulador da CAIXA (Fabio 12/11) — conectar (mostra o QR), estado e desconectar.
const router = Router();
router.use(authMiddleware);

router.get('/status', (req: AuthRequest, res: Response) => { res.json(statusQr(req.user!.accountId)); });
router.post('/conectar', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try { res.json(await conectarQr(req.user!.accountId)); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro ao conectar' }); }
});
router.post('/desconectar', requirePermission('funnel_manage'), async (req: AuthRequest, res: Response) => {
  try { await desconectarQr(req.user!.accountId); res.json({ ok: true }); } catch (e: any) { res.status(500).json({ error: e?.message || 'Erro' }); }
});

export default router;
