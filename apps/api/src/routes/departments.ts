import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { loadPerms } from '../middleware/permission';
import { listDepartments } from '../services/department.service';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

// Leitura fica aberta pra qualquer colaborador logado — os seletores de
// setor (Usuários, QR Code, o próprio card do lead) precisam da lista.
// Gerenciar (criar/renomear/excluir) exige a permissão "settings", mesma
// área onde a tela de Departamentos vai morar.
router.use(async (req: AuthRequest, res: Response, next) => {
  if (req.method === 'GET') return next();
  try {
    const perms = await loadPerms(req);
    if (!perms.settings) return res.status(403).json({ error: 'Você não tem permissão para gerenciar departamentos.' });
    next();
  } catch {
    res.status(500).json({ error: 'Erro ao verificar permissão' });
  }
});

// GET /api/departments — lista (cria os padrão na primeira vez)
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const departments = await listDepartments(req.user!.accountId);
    res.json(departments);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar departamentos' });
  }
});

// POST /api/departments — cria um novo
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
    const accountId = req.user!.accountId;
    const maxOrder = await prisma.department.aggregate({ where: { accountId }, _max: { order: true } });
    const department = await prisma.department.create({
      data: { accountId, name, order: (maxOrder._max.order ?? -1) + 1 },
    });
    res.status(201).json(department);
  } catch {
    res.status(500).json({ error: 'Erro ao criar departamento' });
  }
});

// PATCH /api/departments/:id — renomeia e/ou atualiza o escopo de produtos da IA
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.department.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
    if (!existing) return res.status(404).json({ error: 'Departamento não encontrado' });

    const data: { name?: string; aiScope?: string | null } = {};
    if (req.body?.name !== undefined) {
      const name = String(req.body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });
      data.name = name;
    }
    if (req.body?.aiScope !== undefined) {
      const aiScope = String(req.body.aiScope || '').trim();
      data.aiScope = aiScope || null;
    }
    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Nada para atualizar' });

    const department = await prisma.department.update({ where: { id: existing.id }, data });
    res.json(department);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar departamento' });
  }
});

// DELETE /api/departments/:id — só se não tiver nada vinculado (evita órfãos)
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const existing = await prisma.department.findFirst({
      where: { id: req.params.id, accountId },
      include: { _count: { select: { users: true, pipelines: true, whatsappNumbers: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'Departamento não encontrado' });
    const { users, pipelines, whatsappNumbers } = existing._count;
    if (users > 0 || pipelines > 0 || whatsappNumbers > 0) {
      return res.status(400).json({
        error: `Não dá pra excluir: tem ${users} colaborador(es), ${pipelines} funil(is) e ${whatsappNumbers} número(s) de WhatsApp vinculados. Mova-os para outro departamento antes.`,
      });
    }
    await prisma.department.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir departamento' });
  }
});

export default router;
