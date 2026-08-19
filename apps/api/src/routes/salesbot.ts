import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { validate } from '../middleware/validate';
import {
  listSalesBots,
  getSalesBot,
  createSalesBot,
  updateSalesBot,
  deleteSalesBot,
  listSalesBotRuns,
} from '../services/salesbot.service';

const router = Router();
router.use(authMiddleware);
router.use(requirePermission('salesbot'));

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  active: z.boolean().optional(),
  flow: z
    .object({
      trigger: z.object({ keywords: z.array(z.string()) }),
      steps: z.array(
        z.object({
          id: z.string(),
          type: z.enum(['send_message', 'pause', 'condition', 'action', 'validation', 'stop_salesbot']),
          config: z.record(z.unknown()),
        })
      ),
    })
    .optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  const bots = await listSalesBots(req.user!.accountId);
  res.json(bots);
});

router.post('/', validate(createSchema), async (req: AuthRequest, res: Response) => {
  const bot = await createSalesBot(req.user!.accountId, req.body);
  res.status(201).json(bot);
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  const bot = await getSalesBot(req.params.id, req.user!.accountId);
  if (!bot) {
    res.status(404).json({ error: 'SalesBot não encontrado' });
    return;
  }
  res.json(bot);
});

router.put('/:id', validate(updateSchema), async (req: AuthRequest, res: Response) => {
  const bot = await updateSalesBot(req.params.id, req.user!.accountId, req.body);
  if (!bot) {
    res.status(404).json({ error: 'SalesBot não encontrado' });
    return;
  }
  res.json(bot);
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const ok = await deleteSalesBot(req.params.id, req.user!.accountId);
  if (!ok) {
    res.status(404).json({ error: 'SalesBot não encontrado' });
    return;
  }
  res.status(204).end();
});

router.get('/:id/runs', async (req: AuthRequest, res: Response) => {
  const runs = await listSalesBotRuns(req.params.id, req.user!.accountId);
  if (runs === null) {
    res.status(404).json({ error: 'SalesBot não encontrado' });
    return;
  }
  res.json(runs);
});

export default router;
