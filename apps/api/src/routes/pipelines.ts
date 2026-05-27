import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

const pipelineSchema = z.object({
  name: z.string().min(1),
  stages: z.array(z.object({ name: z.string(), color: z.string().optional(), order: z.number() })).optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const pipelines = await prisma.pipeline.findMany({
      where: { accountId: req.user!.accountId },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    res.json(pipelines);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar pipelines' });
  }
});

router.post('/', validate(pipelineSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { name, stages } = req.body;
    const pipeline = await prisma.pipeline.create({
      data: {
        name,
        accountId: req.user!.accountId,
        stages: stages ? { create: stages } : undefined,
      },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    res.status(201).json(pipeline);
  } catch {
    res.status(500).json({ error: 'Erro ao criar pipeline' });
  }
});

// DELETE /api/pipelines/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const pipeline = await prisma.pipeline.findFirst({
      where: { id: req.params.id, accountId: req.user!.accountId },
      include: { _count: { select: { leads: true } } },
    });
    if (!pipeline) return res.status(404).json({ error: 'Pipeline não encontrado' });
    if (pipeline._count.leads > 0)
      return res.status(400).json({ error: `Pipeline tem ${pipeline._count.leads} lead(s) — mova-os antes de excluir` });

    await prisma.pipeline.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir pipeline' });
  }
});

// POST /api/pipelines/setup — limpa pipelines extras e cria "Fechamento"
router.post('/setup', async (req: AuthRequest, res: Response) => {
  const KEEP = 'Financiamento Habitacional';
  const NEW_PIPELINE = {
    name: 'Fechamento',
    stages: [
      { order: 1, name: 'Documentação Recebida', color: '#3b82f6' },
      { order: 2, name: 'Crédito em Análise',    color: '#f59e0b' },
      { order: 3, name: 'Crédito Aprovado',       color: '#10b981' },
      { order: 4, name: 'Vistoria do Imóvel',     color: '#8b5cf6' },
      { order: 5, name: 'Análise Jurídica',        color: '#f97316' },
      { order: 6, name: 'Registro em Cartório',    color: '#ef4444' },
      { order: 7, name: 'Pagamento ao Vendedor',   color: '#059669' },
    ],
  };

  try {
    const pipelines = await prisma.pipeline.findMany({
      where: { accountId: req.user!.accountId },
      include: { _count: { select: { leads: true } } },
    });

    const log: string[] = [];

    // Apaga pipelines que não são o principal e não têm leads
    for (const p of pipelines) {
      if (p.name === KEEP) { log.push(`Mantido: "${p.name}"`); continue; }
      if (p._count.leads > 0) { log.push(`Mantido (tem ${p._count.leads} lead(s)): "${p.name}"`); continue; }
      await prisma.pipeline.delete({ where: { id: p.id } });
      log.push(`Apagado: "${p.name}"`);
    }

    // Cria "Fechamento" se não existir
    const exists = await prisma.pipeline.findFirst({
      where: { accountId: req.user!.accountId, name: NEW_PIPELINE.name },
    });
    if (exists) {
      log.push(`Já existe: "${NEW_PIPELINE.name}"`);
    } else {
      await prisma.pipeline.create({
        data: {
          name: NEW_PIPELINE.name,
          accountId: req.user!.accountId,
          stages: { create: NEW_PIPELINE.stages },
        },
      });
      log.push(`Criado: "${NEW_PIPELINE.name}" com ${NEW_PIPELINE.stages.length} estágios`);
    }

    res.json({ success: true, log });
  } catch (err) {
    res.status(500).json({ error: 'Erro no setup', detail: String(err) });
  }
});

export default router;
