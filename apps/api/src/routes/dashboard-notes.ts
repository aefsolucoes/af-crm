import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

// GET /api/dashboard-notes?scope=PRIVATE|TEAM
// PRIVATE: só as do colaborador logado. TEAM: mural, todo mundo da conta.
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const scope = req.query.scope === 'TEAM' ? 'TEAM' : 'PRIVATE';
    const notes = await prisma.dashboardNote.findMany({
      where: scope === 'PRIVATE'
        ? { accountId, scope: 'PRIVATE', userId: req.user!.id }
        : { accountId, scope: 'TEAM' },
      orderBy: [{ done: 'asc' }, { createdAt: 'desc' }],
    });
    if (scope === 'PRIVATE') return res.json(notes);

    // No mural, mostra o nome de quem escreveu cada recado.
    const userIds = [...new Set(notes.map((n) => n.userId))];
    const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    res.json(notes.map((n) => ({ ...n, authorName: nameOf.get(n.userId) || '—' })));
  } catch {
    res.status(500).json({ error: 'Erro ao buscar anotações' });
  }
});

// POST /api/dashboard-notes — cria uma anotação (privada ou no mural)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { content, scope } = req.body as { content?: string; scope?: string };
    if (!content?.trim()) return res.status(400).json({ error: 'Escreva algo antes de salvar' });
    const note = await prisma.dashboardNote.create({
      data: {
        content: content.trim(),
        scope: scope === 'TEAM' ? 'TEAM' : 'PRIVATE',
        accountId: req.user!.accountId,
        userId: req.user!.id,
      },
    });
    const user = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } });
    res.status(201).json({ ...note, authorName: user?.name || '—' });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar anotação' });
  }
});

// PATCH /api/dashboard-notes/:id — marcar concluída ou editar o texto.
// Notas PRIVATE só o autor mexe; notas TEAM qualquer colaborador da conta.
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.dashboardNote.findFirst({
      where: { id: req.params.id, accountId: req.user!.accountId },
    });
    if (!existing) return res.status(404).json({ error: 'Anotação não encontrada' });
    if (existing.scope === 'PRIVATE' && existing.userId !== req.user!.id) {
      return res.status(403).json({ error: 'Essa anotação não é sua' });
    }
    const { content, done } = req.body as { content?: string; done?: boolean };
    const data: Record<string, unknown> = {};
    if (content !== undefined) data.content = content.trim();
    if (done !== undefined) data.done = done;
    const note = await prisma.dashboardNote.update({ where: { id: existing.id }, data });
    res.json(note);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar anotação' });
  }
});

// DELETE /api/dashboard-notes/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.dashboardNote.findFirst({
      where: { id: req.params.id, accountId: req.user!.accountId },
    });
    if (!existing) return res.status(404).json({ error: 'Anotação não encontrada' });
    if (existing.scope === 'PRIVATE' && existing.userId !== req.user!.id) {
      return res.status(403).json({ error: 'Essa anotação não é sua' });
    }
    await prisma.dashboardNote.delete({ where: { id: existing.id } });
    res.json({ success: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir anotação' });
  }
});

export default router;
