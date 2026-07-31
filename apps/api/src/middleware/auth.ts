import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import type { PermissionMap } from '../lib/permissions';

export interface AuthRequest extends Request {
  user?: { id: string; accountId: string; role: string };
  // Permissões efetivas do usuário, preenchidas pelo requirePermission quando a
  // rota é gateada (para checagens mais finas dentro do handler).
  perms?: PermissionMap;
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Token não fornecido' });
    return;
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: string;
      accountId: string;
      role: string;
    };
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado' });
  }
}
