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
  revertFalseFollowupExecutions,
} from '../services/automation.service';

const router = Router();
router.use(authMiddleware);
router.use(requirePermission('automations'));

const TRIGGERS = ['NEW_LEAD', 'STAGE_CHANGE', 'TAG_ADDED', 'INACTIVITY', 'MESSAGE_RECEIVED', 'FORM_SUBMITTED'] as const;
const ACTION_TYPES = ['send_message', 'send_template', 'send_email', 'assign_agent', 'move_stage', 'move_stage_by_name', 'add_note', 'add_tag', 'start_salesbot', 'webhook', 'activate_ai', 'deactivate_ai'] as const;

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

// MANUTENÇÃO PONTUAL — corrige os leads que o bug do template
// follow_up_credito (sem {{1}}) moveu sem o follow-up ter sido enviado de
// verdade. Só ADMIN, sem persistência de "já rodei" (idempotente por
// natureza — leads já corrigidos saem do filtro sozinhos). Remover depois
// de rodar uma vez em produção.
router.post('/maintenance/revert-false-followups', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só admin' });
  const result = await revertFalseFollowupExecutions(req.user!.accountId);
  res.json(result);
});

export default router;
