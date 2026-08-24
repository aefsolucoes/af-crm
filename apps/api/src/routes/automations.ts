import { Router, Response } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { validate } from '../middleware/validate';
import {
  listAutomationRules,
  getAutomationRule,
  createAutomationRule,
  updateAutomationRule,
  deleteAutomationRule,
  listAutomationLogs,
} from '../services/automation.service';

const router = Router();
router.use(authMiddleware);
router.use(requirePermission('automations'));

const TRIGGERS = ['NEW_LEAD', 'STAGE_CHANGE', 'TAG_ADDED', 'INACTIVITY', 'MESSAGE_RECEIVED'] as const;
const ACTION_TYPES = ['send_message', 'send_template', 'assign_agent', 'move_stage', 'add_tag', 'start_salesbot', 'webhook'] as const;

const actionSchema = z.object({
  type: z.enum(ACTION_TYPES),
  config: z.record(z.unknown()),
});

const createSchema = z.object({
  name: z.string().min(1),
  trigger: z.enum(TRIGGERS),
  triggerConfig: z.record(z.unknown()).optional(),
  actions: z.array(actionSchema).min(1),
  active: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).optional(),
  trigger: z.enum(TRIGGERS).optional(),
  triggerConfig: z.record(z.unknown()).nullable().optional(),
  actions: z.array(actionSchema).min(1).optional(),
  active: z.boolean().optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  const rules = await listAutomationRules(req.user!.accountId);
  res.json(rules);
});

router.post('/', validate(createSchema), async (req: AuthRequest, res: Response) => {
  const rule = await createAutomationRule(req.user!.accountId, req.body);
  res.status(201).json(rule);
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  const rule = await getAutomationRule(req.params.id, req.user!.accountId);
  if (!rule) {
    res.status(404).json({ error: 'Automação não encontrada' });
    return;
  }
  res.json(rule);
});

router.put('/:id', validate(updateSchema), async (req: AuthRequest, res: Response) => {
  const rule = await updateAutomationRule(req.params.id, req.user!.accountId, req.body);
  if (!rule) {
    res.status(404).json({ error: 'Automação não encontrada' });
    return;
  }
  res.json(rule);
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const ok = await deleteAutomationRule(req.params.id, req.user!.accountId);
  if (!ok) {
    res.status(404).json({ error: 'Automação não encontrada' });
    return;
  }
  res.status(204).end();
});

router.get('/:id/logs', async (req: AuthRequest, res: Response) => {
  const logs = await listAutomationLogs(req.params.id, req.user!.accountId);
  if (logs === null) {
    res.status(404).json({ error: 'Automação não encontrada' });
    return;
  }
  res.json(logs);
});

export default router;
