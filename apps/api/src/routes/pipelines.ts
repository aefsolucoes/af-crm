import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { ensureDefaultDepartments, getScopeDepartmentId } from '../services/department.service';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

const pipelineSchema = z.object({
  name: z.string().min(1),
  stages: z.array(z.object({ name: z.string(), color: z.string().optional(), order: z.number() })).optional(),
  departmentId: z.string().optional().nullable(),
});

const stageCreateSchema = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    await ensureDefaultDepartments(accountId);
    // Não-admin só enxerga os funis do PRÓPRIO setor (mais os "órfãos", sem
    // setor definido — não deveria sobrar nenhum depois do bootstrap, mas
    // não custa não esconder um funil por acidente). Admin vê tudo.
    const scopeDepartmentId = await getScopeDepartmentId(accountId, req.user!.id, req.user!.role);
    const pipelines = await prisma.pipeline.findMany({
      where: {
        accountId,
        ...(scopeDepartmentId ? { OR: [{ departmentId: scopeDepartmentId }, { departmentId: null }] } : {}),
      },
      include: { stages: { orderBy: { order: 'asc' } }, department: { select: { id: true, name: true } } },
    });
    res.json(pipelines);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar pipelines' });
  }
});

router.post('/', validate(pipelineSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { name, stages, departmentId } = req.body;
    // Não-admin cria sempre dentro do PRÓPRIO setor (não escolhe outro).
    // Admin pode escolher (ou deixar sem setor).
    const scopeDepartmentId = await getScopeDepartmentId(req.user!.accountId, req.user!.id, req.user!.role);
    const pipeline = await prisma.pipeline.create({
      data: {
        name,
        accountId: req.user!.accountId,
        departmentId: scopeDepartmentId ?? (departmentId || null),
        stages: stages ? { create: stages } : undefined,
      },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    res.status(201).json(pipeline);
  } catch {
    res.status(500).json({ error: 'Erro ao criar pipeline' });
  }
});

/** Bloqueia mexer num pipeline de OUTRO setor (não-admin). Retorna true e já
 *  responde 403/404 se não puder — o chamador só precisa dar `return`. */
async function blockedByDepartment(req: AuthRequest, res: Response, pipelineId: string): Promise<boolean> {
  const scopeDepartmentId = await getScopeDepartmentId(req.user!.accountId, req.user!.id, req.user!.role);
  if (!scopeDepartmentId) return false; // admin ou sem setor definido — sem restrição
  const pipeline = await prisma.pipeline.findFirst({ where: { id: pipelineId, accountId: req.user!.accountId } });
  if (!pipeline) { res.status(404).json({ error: 'Pipeline não encontrado' }); return true; }
  if (pipeline.departmentId && pipeline.departmentId !== scopeDepartmentId) {
    res.status(403).json({ error: 'Esse funil é de outro departamento.' });
    return true;
  }
  return false;
}

// PATCH /api/pipelines/:id — renomear pipeline
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (await blockedByDepartment(req, res, req.params.id)) return;
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

// POST /api/pipelines/:id/stages — adiciona uma nova etapa ao final do pipeline
router.post('/:id/stages', validate(stageCreateSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (await blockedByDepartment(req, res, req.params.id)) return;
    const pipeline = await prisma.pipeline.findFirst({
      where: { id: req.params.id, accountId: req.user!.accountId },
      include: { stages: true },
    });
    if (!pipeline) return res.status(404).json({ error: 'Pipeline não encontrado' });

    const maxOrder = pipeline.stages.reduce((max, s) => Math.max(max, s.order), 0);
    const stage = await prisma.stage.create({
      data: {
        name: req.body.name,
        color: req.body.color || '#64748b',
        order: maxOrder + 1,
        pipelineId: pipeline.id,
      },
    });
    res.status(201).json(stage);
  } catch {
    res.status(500).json({ error: 'Erro ao criar etapa' });
  }
});

// PATCH /api/pipelines/:id/stages/:stageId — renomeia e/ou muda a cor de uma
// etapa já existente (não existia nenhum jeito de editar depois de criada —
// toda etapa nova nascia cinza, sem como corrigir pela tela).
router.patch('/:id/stages/:stageId', async (req: AuthRequest, res: Response) => {
  try {
    if (await blockedByDepartment(req, res, req.params.id)) return;
    const stage = await prisma.stage.findFirst({ where: { id: req.params.stageId, pipelineId: req.params.id } });
    if (!stage) return res.status(404).json({ error: 'Etapa não encontrada' });

    const { name, color } = req.body as { name?: string; color?: string };
    const data: Record<string, unknown> = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (typeof color === 'string' && color.trim()) data.color = color.trim();
    if (!Object.keys(data).length) return res.status(400).json({ error: 'Nada para atualizar' });

    const updated = await prisma.stage.update({ where: { id: stage.id }, data });
    res.json(updated);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar etapa' });
  }
});

// DELETE /api/pipelines/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (await blockedByDepartment(req, res, req.params.id)) return;
    const pipeline = await prisma.pipeline.findFirst({
      where: { id: req.params.id, accountId: req.user!.accountId },
      include: { _count: { select: { leads: true } } },
    });
    if (!pipeline) return res.status(404).json({ error: 'Pipeline não encontrado' });
    if (pipeline._count.leads > 0)
      return res.status(400).json({ error: `Pipeline tem ${pipeline._count.leads} lead(s) — mova-os antes de excluir` });

    await prisma.stage.deleteMany({ where: { pipelineId: req.params.id } });
    await prisma.pipeline.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir pipeline' });
  }
});

// POST /api/pipelines/setup — limpa pipelines extras e cria "Em contratação"
router.post('/setup', async (req: AuthRequest, res: Response) => {
  const KEEP = 'Financiamento Habitacional';
  const NEW_PIPELINE = {
    name: 'Em contratação',
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
      // Apaga estágios antes do pipeline (FK constraint)
      await prisma.stage.deleteMany({ where: { pipelineId: p.id } });
      await prisma.pipeline.delete({ where: { id: p.id } });
      log.push(`Apagado: "${p.name}"`);
    }

    // Cria pipelines padrão se não existirem
    const EXTRA_PIPELINES = [
      {
        name: 'Em contratação',
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
