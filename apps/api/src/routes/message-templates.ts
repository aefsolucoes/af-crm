import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getScopeDepartmentIds, resolveCreateDepartmentId } from '../services/department.service';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

function extractVariables(text: string): string[] {
  const matches = text.match(/\{\{([^}]+)\}\}/g) || [];
  return [...new Set(matches.map((m) => m.replace(/\{\{|\}\}/g, '').trim()))];
}

// GET /api/message-templates — templates da conta. Admin vê todos; colaborador
// só os do PRÓPRIO setor + os "compartilhados" (sem setor definido).
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const scopeDepartmentIds = await getScopeDepartmentIds(accountId, req.user!.id, req.user!.role);
    const templates = await prisma.messageTemplate.findMany({
      where: {
        accountId,
        ...(scopeDepartmentIds.length ? { OR: [{ departmentId: { in: scopeDepartmentIds } }, { departmentId: null }] } : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(templates);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar templates' });
  }
});

// POST /api/message-templates — colaborador com setor cria automaticamente
// DENTRO do próprio setor; admin pode escolher (ou deixar "compartilhado").
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const { name, category, body, triggerText, triggerActive, departmentId } = req.body as {
      name?: string; category?: string; body?: string; triggerText?: string; triggerActive?: boolean; departmentId?: string | null;
    };
    if (!name?.trim() || !body?.trim()) return res.status(400).json({ error: 'name e body são obrigatórios' }) as any;

    const scopeDepartmentIds = await getScopeDepartmentIds(accountId, req.user!.id, req.user!.role);
    const resolved = resolveCreateDepartmentId(scopeDepartmentIds, departmentId);
    if (!resolved.ok) return res.status(400).json({ error: resolved.error }) as any;
    const finalDepartmentId = resolved.departmentId;
    if (finalDepartmentId) {
      const dept = await prisma.department.findFirst({ where: { id: finalDepartmentId, accountId } });
      if (!dept) return res.status(400).json({ error: 'Departamento inválido' }) as any;
    }

    const template = await prisma.messageTemplate.create({
      data: {
        accountId,
        name: name.trim(),
        category: category || 'geral',
        body,
        variables: extractVariables(body),
        triggerText: triggerText?.trim() || null,
        triggerActive: triggerActive === true,
        departmentId: finalDepartmentId,
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

    // Templates importados do navegador (localStorage) entram "compartilhados"
    // — quem os tinha salvos não necessariamente tem setor definido ainda.
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
    const accountId = req.user!.accountId;
    const existing = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, accountId } });
    if (!existing) return res.status(404).json({ error: 'Template não encontrado' }) as any;

    const scopeDepartmentIds = await getScopeDepartmentIds(accountId, req.user!.id, req.user!.role);
    if (scopeDepartmentIds.length && existing.departmentId && !scopeDepartmentIds.includes(existing.departmentId)) {
      return res.status(403).json({ error: 'Esse template é de outro departamento.' }) as any;
    }

    const { name, category, body, triggerText, triggerActive, departmentId } = req.body as {
      name?: string; category?: string; body?: string; triggerText?: string | null; triggerActive?: boolean; departmentId?: string | null;
    };
    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name.trim();
    if (category !== undefined) data.category = category;
    if (body !== undefined) { data.body = body; data.variables = extractVariables(body); }
    if (triggerText !== undefined) data.triggerText = triggerText?.trim() || null;
    if (triggerActive !== undefined) data.triggerActive = triggerActive === true;
    // Só admin (sem setor nenhum) pode mudar o setor do template.
    if (departmentId !== undefined && !scopeDepartmentIds.length) {
      if (departmentId) {
        const dept = await prisma.department.findFirst({ where: { id: departmentId, accountId } });
        if (!dept) return res.status(400).json({ error: 'Departamento inválido' }) as any;
      }
      data.departmentId = departmentId || null;
    }

    const template = await prisma.messageTemplate.update({ where: { id: existing.id }, data });
    res.json(template);
  } catch {
    res.status(500).json({ error: 'Erro ao editar template' });
  }
});

// DELETE /api/message-templates/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const existing = await prisma.messageTemplate.findFirst({ where: { id: req.params.id, accountId } });
    if (!existing) return res.status(404).json({ error: 'Template não encontrado' }) as any;

    const scopeDepartmentIds = await getScopeDepartmentIds(accountId, req.user!.id, req.user!.role);
    if (scopeDepartmentIds.length && existing.departmentId && !scopeDepartmentIds.includes(existing.departmentId)) {
      return res.status(403).json({ error: 'Esse template é de outro departamento.' }) as any;
    }

    await prisma.messageTemplate.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir template' });
  }
});

export default router;
