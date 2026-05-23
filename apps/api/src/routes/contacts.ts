import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

const contactSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  companyId: z.string().optional(),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const contacts = await prisma.contact.findMany({
      where: { accountId: req.user!.accountId },
      include: { company: true },
      orderBy: { name: 'asc' },
    });
    res.json(contacts);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar contatos' });
  }
});

router.post('/', validate(contactSchema), async (req: AuthRequest, res: Response) => {
  try {
    const contact = await prisma.contact.create({
      data: { ...req.body, accountId: req.user!.accountId },
      include: { company: true },
    });
    res.status(201).json(contact);
  } catch {
    res.status(500).json({ error: 'Erro ao criar contato' });
  }
});

export default router;
