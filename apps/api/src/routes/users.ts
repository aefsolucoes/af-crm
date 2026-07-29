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
      select: { id: true, name: true, email: true, role: true, whatsAppNumberId: true },
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

// PATCH /api/users/me/whatsapp — o próprio usuário vincula o número que ele opera.
router.patch('/me/whatsapp', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const { whatsAppNumberId } = req.body as { whatsAppNumberId?: string | null };
    if (whatsAppNumberId) {
      const num = await prisma.whatsAppNumber.findFirst({ where: { id: whatsAppNumberId, accountId } });
      if (!num) return res.status(400).json({ error: 'Número de WhatsApp inválido' });
    }
    const user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { whatsAppNumberId: whatsAppNumberId || null },
      select: { id: true, whatsAppNumberId: true },
    });
    res.json(user);
  } catch {
    res.status(500).json({ error: 'Erro ao vincular o número' });
  }
});

// PATCH /api/users/:id/whatsapp — vincula (ou desvincula) o número de WhatsApp
// que o usuário opera. Usado no Relatório Matinal pra dividir os clientes.
router.patch('/:id/whatsapp', async (req: AuthRequest, res: Response) => {
  try {
    if (req.user!.role === 'AGENT') {
      return res.status(403).json({ error: 'Apenas admin/gerente pode vincular números' });
    }
    const accountId = req.user!.accountId;
    const { whatsAppNumberId } = req.body as { whatsAppNumberId?: string | null };

    const target = await prisma.user.findFirst({ where: { id: req.params.id, accountId } });
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });

    if (whatsAppNumberId) {
      const num = await prisma.whatsAppNumber.findFirst({ where: { id: whatsAppNumberId, accountId } });
      if (!num) return res.status(400).json({ error: 'Número de WhatsApp inválido' });
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { whatsAppNumberId: whatsAppNumberId || null },
      select: { id: true, whatsAppNumberId: true },
    });
    res.json(user);
  } catch {
    res.status(500).json({ error: 'Erro ao vincular o número' });
  }
});

export default router;
