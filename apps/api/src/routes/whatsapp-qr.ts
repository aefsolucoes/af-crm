import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { startQRConnection, getQRStatus, disconnectQR } from '../services/baileys.service';

const router = Router();
router.use(authMiddleware);

// GET /api/whatsapp-qr/status
router.get('/status', (req: AuthRequest, res: Response) => {
  const status = getQRStatus(req.user!.accountId);
  res.json(status);
});

// POST /api/whatsapp-qr/connect
router.post('/connect', async (req: AuthRequest, res: Response) => {
  const { status } = getQRStatus(req.user!.accountId);
  if (status === 'connected') return res.json({ status: 'connected' });

  startQRConnection(req.user!.accountId).catch(console.error);
  res.json({ status: 'connecting' });
});

// POST /api/whatsapp-qr/disconnect
router.post('/disconnect', async (req: AuthRequest, res: Response) => {
  await disconnectQR(req.user!.accountId);
  res.json({ status: 'disconnected' });
});

export default router;
