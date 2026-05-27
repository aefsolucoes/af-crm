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

// PATCH /api/pipelines/:id — renomear pipeline
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
    const pipeline = await prisma.pipeline.updateMany({
      where: { id: req.params.id, accountId: req.user!.accountId },
      data: { name },
    });
    res.json({ success: true, updated: pipeline.count });
  } catch {
    res.status(500).json({ error: 'Erro ao renomear pipeline' });
  }
});

// PATCH /api/pipelines/rename-by-name — renomear pelo nome atual
router.post('/rename', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from e to obrigatórios' });
    const result = await prisma.pipeline.updateMany({
      where: { accountId: req.user!.accountId, name: from },
      data: { name: to },
    });
    res.json({ success: true, updated: result.count });
  } catch {
    res.status(500).json({ error: 'Erro ao renomear pipeline' });
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

    // Cria pipelines padrão se não existirem
    const EXTRA_PIPELINES = [
      {
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
      },
      {
        name: 'Follow Up',
        stages: [
          { order: 1, name: 'Remarketing',        color: '#6366f1' },
          { order: 2, name: 'Promoção Enviada',   color: '#f59e0b' },
          { order: 3, name: 'Retomou Interesse',  color: '#10b981' },
          { order: 4, name: 'Descartado',         color: '#94a3b8' },
        ],
      },
    ];

    for (const pl of EXTRA_PIPELINES) {
      const exists = await prisma.pipeline.findFirst({
        where: { accountId: req.user!.accountId, name: pl.name },
      });
      if (exists) {
        log.push(`Já existe: "${pl.name}"`);
      } else {
        await prisma.pipeline.create({
          data: {
            name: pl.name,
            accountId: req.user!.accountId,
            stages: { create: pl.stages },
          },
        });
        log.push(`Criado: "${pl.name}" com ${pl.stages.length} estágios`);
      }
    }

    res.json({ success: true, log });
  } catch (err) {
    res.status(500).json({ error: 'Erro no setup', detail: String(err) });
  }
});

export default router;
