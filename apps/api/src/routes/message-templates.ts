import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

function extractVariables(text: string): string[] {
  const matches = text.match(/\{\{([^}]+)\}\}/g) || [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, '').trim()))];
}

// GET /api/message-templates — templates da conta (compartilhados por toda a equipe)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const templates = await prisma.messageTemplate.findMany({
      where: { accountId: req.user!.accountId },
      orderBy: { createdAt: 'asc' },
    });
    res.json(templates);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar templates' });
  }
});

// POST /api/message-templates
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { name, category, body, triggerText, triggerActive } = req.body as {
      name?: string; category?: string; body?: string; triggerText?: string; triggerActive?: boolean;
    };
    if (!name?.trim() || !body?.trim()) return res.status(400).json({ error: 'name e body são obrigatórios' }) as any;

    const template = await prisma.messageTemplate.create({
      data: {
        accountId: req.user!.accountId,
        name: name.trim(),
        category: category || 'geral',
        body,
        variables: extractVariables(body),
        triggerText: triggerText?.trim() || null,
        triggerActive: triggerActive === true,
      },
    });
    res.status(201).json(template);
  } catch {
    res.status(500).json({ error: 'Erro ao criar template' });
  }
});

// POST /api/message-templates/import — migração única dos templates que
// estavam salvos só no navegador (localStorage) para o banco, na primeira
// vez que o colaborador abre a tela depois do lançamento desta função.
router.post('/import', async (req: AuthRequest, res: Response) => {
  try {
    const items = Array.isArray(req.body?.templates) ? req.body.templates : [];
    if (items.length === 0) return res.json({ imported: 0 });

    const accountId = req.user!.accountId;
    const existing = await prisma.messageTemplate.findMany({ where: { accountId }, select: { name: true } });
    const existingNames = new Set(existing.map((t) => t.name.trim().toLowerCase()));

    const toCreate = (items as { name?: string; category?: string; body?: string }[])
      .filter((t) => t.name?.trim() && t.body?.trim() && !existingNames.has(t.name.trim().toLowerCase()));

    if (toCreate.length === 0) return res.json({ imported: 0 });

    await prisma.messageTemplate.createMany({
      data: toCreate.map((t) => ({
        accountId,
        name: t.name!.trim(),
        category: t.category || 'geral',
        body: t.body!,
        variables: extractVariables(t.body!),
      })),
    });
    res.json({ imported: toCreate.length });
  } catch {
    res.status(500).json({ error: 'Erro ao importar templates' });
  }
});

// PATCH /api/message-templates/:id
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
    if (!existing) return res.status(404).json({ error: 'Template não encontrado' }) as any;

    const { name, category, body, triggerText, triggerActive } = req.body as {
      name?: string; category?: string; body?: string; triggerText?: string | null; triggerActive?: boolean;
    };
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name.trim();
    if (category !== undefined) data.category = category;
    if (body !== undefined) { data.body = body; data.variables = extractVariables(body); }
    if (triggerText !== undefined) data.triggerText = triggerText?.trim() || null;
    if (triggerActive !== undefined) data.triggerActive = triggerActive === true;

    const template = await prisma.messageTemplate.update({ where: { id: existing.id }, data });
    res.json(template);
  } catch {
    res.status(500).json({ error: 'Erro ao editar template' });
  }
});

// DELETE /api/message-templates/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
    if (!existing) return res.status(404).json({ error: 'Template não encontrado' }) as any;
    await prisma.messageTemplate.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir template' });
  }
});

export default router;
