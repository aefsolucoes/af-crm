import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { startQRConnection, getQRStatus, disconnectQR } from '../services/baileys.service';

const router = Router();
router.use(authMiddleware);

router.get('/status', (req: AuthRequest, res: Response) => {
  res.json(getQRStatus(req.user!.accountId));
});

router.post('/connect', async (req: AuthRequest, res: Response) => {
  const { status } = getQRStatus(req.user!.accountId);
  if (status === 'connected') return res.json({ status: 'connected' });

  startQRConnection(req.user!.accountId).catch(console.error);
  res.json({ status: 'connecting' });
});

router.post('/disconnect', async (req: AuthRequest, res: Response) => {
  await disconnectQR(req.user!.accountId);
  res.json({ status: 'disconnected' });
});

export default router;
