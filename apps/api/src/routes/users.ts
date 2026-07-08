import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

// GET /api/users — lista usuários da conta
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: { accountId: req.user!.accountId },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: 'asc' },
    });
    res.json(users);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar usuários' });
  }
});

// PATCH /api/users/me/theme — atualiza a aparência do usuário logado (individual, não da conta)
router.patch('/me/theme', async (req: AuthRequest, res: Response) => {
  try {
    const { themeColor, themeImage, themeOpacity } = req.body as {
      themeColor?: string; themeImage?: string | null; themeOpacity?: number;
    };
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        ...(themeColor !== undefined && { themeColor }),
        ...(themeImage !== undefined && { themeImage }),
        ...(themeOpacity !== undefined && { themeOpacity }),
      },
      select: { id: true, themeColor: true, themeImage: true, themeOpacity: true },
    });
    res.json(user);
  } catch {
    res.status(500).json({ error: 'Erro ao salvar aparência' });
  }
});

export default router;
