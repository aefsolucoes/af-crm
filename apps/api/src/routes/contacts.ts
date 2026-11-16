import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { normalizeClientName } from '../lib/text';

const router = Router();
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
      data: { ...req.body, name: normalizeClientName(req.body.name), accountId: req.user!.accountId },
      include: { company: true },
    });
    res.status(201).json(contact);
  } catch {
    res.status(500).json({ error: 'Erro ao criar contato' });
  }
});

// Troca/apaga o e-mail do contato (admin). Fabio 16/11: o contato do Alexandro era o e-mail da Luana (Inter) — não havia como tirar pela tela.
router.patch('/:id/email', validate(z.object({ email: z.string().email().nullable() })), async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só o administrador muda o e-mail do contato' });
  try {
    const r = await prisma.contact.updateMany({ where: { id: req.params.id, accountId: req.user!.accountId }, data: { email: req.body.email } });
    if (!r.count) return res.status(404).json({ error: 'Contato não encontrado' });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Erro ao mudar o e-mail do contato' });
  }
});

export default router;
