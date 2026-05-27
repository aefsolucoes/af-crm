import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

// POST /api/notes
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { leadId, content, type } = req.body;
    if (!leadId || !content) return res.status(400).json({ error: 'leadId e content obrigatórios' }) as any;
    const note = await prisma.note.create({
      data: { leadId, content, type: type || 'COMMENT' },
    });
    res.status(201).json(note);
  } catch {
    res.status(500).json({ error: 'Erro ao criar nota' });
  }
});

export default router;
