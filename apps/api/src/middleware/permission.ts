import { Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthRequest } from './auth';
import { effectivePermissions, PermissionKey, PermissionMap } from '../lib/permissions';

const prisma = new PrismaClient();

// Carrega as permissões efetivas do usuário logado (papel + permissões próprias,
// buscadas no banco para refletir mudanças na hora). Guarda em req.perms para
// reaproveitar dentro do mesmo request. Use em checagens finas nos handlers.
export async function loadPerms(req: AuthRequest): Promise<PermissionMap> {
  if (req.perms) return req.perms;
  const user = req.user
    ? await prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true, permissions: true } })
    : null;
  const perms = effectivePermissions(user?.role || 'AGENT', user?.permissions ?? null);
  req.perms = perms;
  return perms;
}

// Gate de rota por permissão: bloqueia (403) se o usuário não tiver a permissão.
// Deve rodar após o authMiddleware.
export function requirePermission(key: PermissionKey) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Não autenticado' });
      const perms = await loadPerms(req);
      if (!perms[key]) {
        return res.status(403).json({ error: 'Você não tem permissão para acessar esta área.' });
      }
      next();
    } catch {
      res.status(500).json({ error: 'Erro ao verificar permissão' });
    }
  };
}
