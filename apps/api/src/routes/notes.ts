import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

const NOTE_INCLUDE = {
  user: { select: { id: true, name: true } },
};

// POST /api/notes
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { leadId, content, type } = req.body;
    if (!leadId || !content) return res.status(400).json({ error: 'leadId e content obrigatórios' }) as any;
    const note = await prisma.note.create({
      data: { leadId, content, type: type || 'COMMENT', userId: req.user!.id },
      include: NOTE_INCLUDE,
    });
    res.status(201).json(note);
  } catch {
    res.status(500).json({ error: 'Erro ao criar nota' });
  }
});

// PATCH /api/notes/:id — editar conteúdo
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { content } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content obrigatório' }) as any;

    const existing = await prisma.note.findFirst({
      where: { id: req.params.id, lead: { accountId: req.user!.accountId } },
    });
    if (!existing) return res.status(404).json({ error: 'Nota não encontrada' }) as any;

    const note = await prisma.note.update({
      where: { id: req.params.id },
      data: { content: content.trim() },
      include: NOTE_INCLUDE,
    });
    res.json(note);
  } catch {
    res.status(500).json({ error: 'Erro ao editar nota' });
  }
});

// DELETE /api/notes/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.note.findFirst({
      where: { id: req.params.id, lead: { accountId: req.user!.accountId } },
    });
    if (!existing) return res.status(404).json({ error: 'Nota não encontrada' }) as any;
    await prisma.note.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir nota' });
  }
});

export default router;
