import { Router, Response, Request } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { startQRConnection, getQRStatus, disconnectQR } from '../services/baileys.service';

const router = Router();

// Public debug endpoint (no auth) - remove after diagnosis
router.get('/debug', async (req: Request, res: Response) => {
  try {
    const baileys = await import('@whiskeysockets/baileys') as any;
    const keys = Object.keys(baileys);
    const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
    res.json({
      baileys_keys: keys,
      makeWASocket_type: typeof makeWASocket,
      useMultiFileAuthState_type: typeof baileys.useMultiFileAuthState,
      node_version: process.version,
      platform: process.platform,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

router.use(authMiddleware);

router.get('/status', (req: AuthRequest, res: Response) => {
  res.json(getQRStatus(req.user!.accountId));
});

router.post('/connect', async (req: AuthRequest, res: Response) => {
  const { status } = getQRStatus(req.user!.accountId);
  if (status === 'connected') return res.json({ status: 'connected' });

  // Always clear old session before connecting to force fresh QR generation
  await disconnectQR(req.user!.accountId).catch(() => {});

  startQRConnection(req.user!.accountId).catch(console.error);
  res.json({ status: 'connecting' });
});

router.post('/disconnect', async (req: AuthRequest, res: Response) => {
  await disconnectQR(req.user!.accountId);
  res.json({ status: 'disconnected' });
});

export default router;
