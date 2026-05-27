import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

// GET /api/fields
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const fields = await prisma.fieldDefinition.findMany({
      where: { accountId: req.user!.accountId },
      orderBy: [{ createdAt: 'asc' }, { order: 'asc' }],
    });
    res.json(fields);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar campos' });
  }
});

// POST /api/fields
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { name, type, tab, options, order } = req.body;
    if (!name) return res.status(400).json({ error: 'Nome obrigatório' });

    const key = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, '_')
      .replace(/[^a-z0-9_]/g, '');

    const existing = await prisma.fieldDefinition.findFirst({
      where: { accountId: req.user!.accountId, key },
    });
    const finalKey = existing ? `${key}_${Date.now()}` : key;

    const field = await prisma.fieldDefinition.create({
      data: {
        name,
        key: finalKey,
        type: type || 'TEXT',
        tab: tab || 'Principal',
        options: options || [],
        order: order ?? 0,
        accountId: req.user!.accountId,
      },
    });
    res.json(field);
  } catch {
    res.status(500).json({ error: 'Erro ao criar campo' });
  }
});

// POST /api/fields/migrate-pipeline — migra estágios do pipeline principal
router.post('/migrate-pipeline', async (req: AuthRequest, res: Response) => {
  const NEW_STAGES = [
    { order: 1, name: 'Prospecção',              color: '#3b82f6' },
    { order: 2, name: 'Follow Up',               color: '#f59e0b' },
    { order: 3, name: 'Aguardando Simulação',    color: '#8b5cf6' },
    { order: 4, name: 'Proposta Enviada',        color: '#f97316' },
    { order: 5, name: 'Aguardando Documentação', color: '#ef4444' },
    { order: 6, name: 'Fechado',                 color: '#10b981' },
  ];
  const RENAMES: Record<string, string> = {
    'Prospecção':  'Prospecção',
    'Qualificação':'Aguardando Simulação',
    'Proposta':    'Proposta Enviada',
    'Negociação':  'Aguardando Documentação',
    'Fechado':     'Fechado',
  };

  try {
    const pipeline = await prisma.pipeline.findFirst({
      where: { accountId: req.user!.accountId },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    if (!pipeline) return res.status(404).json({ error: 'Pipeline não encontrado' });

    const log: string[] = [];

    // Renomeia estágios existentes
    for (const stage of pipeline.stages) {
      const newName = RENAMES[stage.name];
      const newStage = NEW_STAGES.find(s => s.name === newName);
      if (newName && newStage) {
        await prisma.stage.update({
          where: { id: stage.id },
          data: { name: newName, order: newStage.order, color: newStage.color },
        });
        log.push(`Renomeado: "${stage.name}" → "${newName}"`);
      }
    }

    // Insere novos estágios
    const existingNames = pipeline.stages.map(s => RENAMES[s.name] || s.name);
    for (const ns of NEW_STAGES) {
      if (!existingNames.includes(ns.name)) {
        await prisma.stage.create({
          data: { name: ns.name, color: ns.color, order: ns.order, pipelineId: pipeline.id },
        });
        log.push(`Criado: "${ns.name}"`);
      }
    }

    // Remove estágios obsoletos sem leads
    const refreshed = await prisma.pipeline.findFirst({
      where: { id: pipeline.id },
      include: { stages: { include: { _count: { select: { leads: true } } } } },
    });
    const validNames = NEW_STAGES.map(s => s.name);
    for (const stage of refreshed!.stages) {
      if (!validNames.includes(stage.name)) {
        if (stage._count.leads === 0) {
          await prisma.stage.delete({ where: { id: stage.id } });
          log.push(`Removido: "${stage.name}"`);
        } else {
          log.push(`Mantido (tem leads): "${stage.name}"`);
        }
      }
    }

    res.json({ success: true, log });
  } catch (err) {
    res.status(500).json({ error: 'Erro na migração', detail: String(err) });
  }
});

// PATCH /api/fields/by-key/:key — atualiza opções pelo key do campo
router.patch('/by-key/:key', async (req: AuthRequest, res: Response) => {
  try {
    const { options } = req.body;
    if (!Array.isArray(options)) return res.status(400).json({ error: 'options deve ser array' });
    const result = await prisma.fieldDefinition.updateMany({
      where: { accountId: req.user!.accountId, key: req.params.key },
      data: { options },
    });
    res.json({ updated: result.count });
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar campo' });
  }
});

// PUT /api/fields/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { name, type, tab, options, order } = req.body;
    const field = await prisma.fieldDefinition.update({
      where: { id: req.params.id },
      data: { name, type, tab, options, order },
    });
    res.json(field);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar campo' });
  }
});

// DELETE /api/fields/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.fieldDefinition.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir campo' });
  }
});

export default router;
