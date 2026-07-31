import { Router, Response } from 'express';
import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcrypt';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { loadPerms } from '../middleware/permission';
import { PERMISSION_KEYS } from '../lib/permissions';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

const USER_SELECT = { id: true, name: true, email: true, role: true, whatsAppNumberId: true, permissions: true } as const;
const VALID_ROLES: Role[] = ['ADMIN', 'MANAGER', 'AGENT'];

// Normaliza o objeto de permissões recebido: mantém só as chaves conhecidas como
// boolean. null = usuário sem permissões próprias (usa o padrão do papel).
function sanitizePermissions(input: unknown): Record<string, boolean> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const src = input as Record<string, unknown>;
  const out: Record<string, boolean> = {};
  for (const k of PERMISSION_KEYS) out[k] = !!src[k];
  return out;
}

// Gerenciar a equipe (criar, editar, excluir, tirar acesso) exige a permissão
// "users". Admin sempre tem; Gerente por padrão também; Agente não.
async function canManageUsers(req: AuthRequest) {
  const perms = await loadPerms(req);
  return perms.users;
}

// GET /api/users — lista usuários da conta
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: { accountId: req.user!.accountId },
      select: USER_SELECT,
      orderBy: { name: 'asc' },
    });
    res.json(users);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar usuários' });
  }
});

// POST /api/users — cria um novo membro da equipe.
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!(await canManageUsers(req))) {
      return res.status(403).json({ error: 'Você não tem permissão para gerenciar usuários' });
    }
    const accountId = req.user!.accountId;
    const { name, email, password, role, whatsAppNumberId } = req.body as {
      name?: string; email?: string; password?: string; role?: string; whatsAppNumberId?: string | null;
    };

    const cleanName = (name || '').trim();
    const cleanEmail = (email || '').trim().toLowerCase();
    if (!cleanName || !cleanEmail || !password) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
    }
    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existing) return res.status(409).json({ error: 'Já existe um usuário com esse e-mail' });

    if (whatsAppNumberId) {
      const num = await prisma.whatsAppNumber.findFirst({ where: { id: whatsAppNumberId, accountId } });
      if (!num) return res.status(400).json({ error: 'Número de WhatsApp inválido' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        name: cleanName,
        email: cleanEmail,
        password: hashed,
        role: (VALID_ROLES.includes(role as Role) ? role : 'AGENT') as Role,
        accountId,
        whatsAppNumberId: whatsAppNumberId || null,
        permissions: sanitizePermissions((req.body as { permissions?: unknown }).permissions) ?? undefined,
      },
      select: USER_SELECT,
    });
    res.status(201).json(user);
  } catch {
    res.status(500).json({ error: 'Erro ao criar usuário' });
  }
});

// PATCH /api/users/:id — atualiza nome, e-mail, senha, papel e número do membro.
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (!(await canManageUsers(req))) {
      return res.status(403).json({ error: 'Você não tem permissão para gerenciar usuários' });
    }
    const accountId = req.user!.accountId;
    const target = await prisma.user.findFirst({ where: { id: req.params.id, accountId } });
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });

    const { name, email, password, role, whatsAppNumberId } = req.body as {
      name?: string; email?: string; password?: string; role?: string; whatsAppNumberId?: string | null;
    };
    const data: Record<string, unknown> = {};

    if (name !== undefined) {
      if (!name.trim()) return res.status(400).json({ error: 'O nome não pode ficar vazio' });
      data.name = name.trim();
    }
    if (email !== undefined) {
      const cleanEmail = email.trim().toLowerCase();
      if (!cleanEmail) return res.status(400).json({ error: 'O e-mail não pode ficar vazio' });
      if (cleanEmail !== target.email) {
        const dup = await prisma.user.findUnique({ where: { email: cleanEmail } });
        if (dup) return res.status(409).json({ error: 'Já existe um usuário com esse e-mail' });
        data.email = cleanEmail;
      }
    }
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres' });
      data.password = await bcrypt.hash(password, 10);
    }
    if (role && VALID_ROLES.includes(role as Role)) {
      // Não deixar rebaixar o último admin (evita conta sem administrador).
      if (target.role === 'ADMIN' && role !== 'ADMIN') {
        const admins = await prisma.user.count({ where: { accountId, role: 'ADMIN' } });
        if (admins <= 1) return res.status(400).json({ error: 'A conta precisa de pelo menos um administrador' });
      }
      data.role = role as Role;
    }
    if (whatsAppNumberId !== undefined) {
      if (whatsAppNumberId) {
        const num = await prisma.whatsAppNumber.findFirst({ where: { id: whatsAppNumberId, accountId } });
        if (!num) return res.status(400).json({ error: 'Número de WhatsApp inválido' });
      }
      data.whatsAppNumberId = whatsAppNumberId || null;
    }
    if ('permissions' in (req.body as object)) {
      data.permissions = sanitizePermissions((req.body as { permissions?: unknown }).permissions);
    }

    const user = await prisma.user.update({ where: { id: target.id }, data, select: USER_SELECT });
    res.json(user);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar usuário' });
  }
});

// DELETE /api/users/:id — remove um membro. Os registros dele (leads, tarefas,
// notas) são transferidos para quem está excluindo, para não perder histórico.
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    if (!(await canManageUsers(req))) {
      return res.status(403).json({ error: 'Você não tem permissão para gerenciar usuários' });
    }
    if (req.params.id === req.user!.id) {
      return res.status(400).json({ error: 'Você não pode excluir a sua própria conta' });
    }
    const accountId = req.user!.accountId;
    const target = await prisma.user.findFirst({ where: { id: req.params.id, accountId } });
    if (!target) return res.status(404).json({ error: 'Usuário não encontrado' });

    if (target.role === 'ADMIN') {
      const admins = await prisma.user.count({ where: { accountId, role: 'ADMIN' } });
      if (admins <= 1) return res.status(400).json({ error: 'Não é possível excluir o último administrador' });
    }

    const heir = req.user!.id;
    await prisma.$transaction([
      prisma.lead.updateMany({ where: { userId: target.id }, data: { userId: heir } }),
      prisma.task.updateMany({ where: { userId: target.id }, data: { userId: heir } }),
      prisma.note.updateMany({ where: { userId: target.id }, data: { userId: heir } }),
      prisma.transaction.updateMany({ where: { userId: target.id }, data: { userId: heir } }),
      prisma.user.delete({ where: { id: target.id } }),
    ]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Erro ao excluir usuário' });
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
