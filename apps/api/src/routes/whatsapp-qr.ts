import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getQRStatus } from '../services/baileys.service';

const router = Router();
router.use(authMiddleware);

router.get('/status', (req: AuthRequest, res: Response) => {
  res.json(getQRStatus(req.user!.accountId));
});

router.post('/connect', (_req: AuthRequest, res: Response) => {
  res.status(503).json({ error: 'QR Code via Z-API configurado — use a aba API Oficial ou Z-API' });
});

router.post('/disconnect', (_req: AuthRequest, res: Response) => {
  res.json({ status: 'disconnected' });
});

export default router;
