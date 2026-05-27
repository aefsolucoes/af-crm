import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { getLeads, getLeadById, createLead, updateLead, updateLeadStage, deleteLead } from '../services/lead.service';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

const createLeadSchema = z.object({
  name: z.string().min(1),
  value: z.number().optional(),
  pipelineId: z.string(),
  stageId: z.string(),
  userId: z.string(),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const updateLeadSchema = createLeadSchema.partial().extend({
  status: z.enum(['OPEN', 'WON', 'LOST']).optional(),
});
const stageSchema = z.object({ stageId: z.string() });

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const archived = req.query.archived === 'true';
    const leads = await getLeads(req.user!.accountId, req.query.pipelineId as string, req.query.stageId as string, archived);
    res.json(leads);
  } catch (err: unknown) {
    res.status(500).json({ error: 'Erro ao buscar leads' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const lead = await getLeadById(req.params.id, req.user!.accountId);
    if (!lead) { res.status(404).json({ error: 'Lead não encontrado' }); return; }
    res.json(lead);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar lead' });
  }
});

router.post('/', validate(createLeadSchema), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await createLead({ ...req.body, accountId: req.user!.accountId });
    res.status(201).json(lead);
  } catch {
    res.status(500).json({ error: 'Erro ao criar lead' });
  }
});

router.put('/:id', validate(updateLeadSchema), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await updateLead(req.params.id, req.user!.accountId, req.body);
    res.json(lead);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar lead' });
  }
});

router.patch('/:id/stage', validate(stageSchema), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await updateLeadStage(req.params.id, req.user!.accountId, req.body.stageId);
    res.json(lead);
  } catch {
    res.status(500).json({ error: 'Erro ao mover lead' });
  }
});

// PATCH /api/leads/:id/pipeline — mover lead para outro pipeline (vai para o 1º estágio)
router.patch('/:id/pipeline', async (req: AuthRequest, res: Response) => {
  try {
    const { pipelineId, stageId } = req.body as { pipelineId: string; stageId?: string };
    if (!pipelineId) return res.status(400).json({ error: 'pipelineId obrigatório' });

    // Se não passou stageId, pega o primeiro do pipeline
    let targetStageId = stageId;
    if (!targetStageId) {
      const pipeline = await prisma.pipeline.findUnique({
        where: { id: pipelineId },
        include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
      });
      if (!pipeline || !pipeline.stages[0]) {
        return res.status(404).json({ error: 'Pipeline ou estágio não encontrado' });
      }
      targetStageId = pipeline.stages[0].id;
    }

    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { pipelineId, stageId: targetStageId },
    });
    res.json(lead);
  } catch {
    res.status(500).json({ error: 'Erro ao mover lead para outro pipeline' });
  }
});

// PATCH /api/leads/:id/archive  — arquivar ou desarquivar
router.patch('/:id/archive', async (req: AuthRequest, res: Response) => {
  try {
    const { archived } = req.body as { archived: boolean };
    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { archived: archived ?? true },
    });
    res.json(lead);
  } catch {
    res.status(500).json({ error: 'Erro ao arquivar lead' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await deleteLead(req.params.id, req.user!.accountId);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Erro ao excluir lead' });
  }
});

// PATCH /api/leads/:id/custom-fields
router.patch('/:id/custom-fields', async (req: AuthRequest, res: Response) => {
  try {
    const { customFields } = req.body;
    const lead = await updateLead(req.params.id, req.user!.accountId, { customFields } as any);
    res.json(lead);
  } catch {
    res.status(500).json({ error: 'Erro ao salvar campos' });
  }
});

export default router;
