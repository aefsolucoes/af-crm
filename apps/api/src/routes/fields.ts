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
