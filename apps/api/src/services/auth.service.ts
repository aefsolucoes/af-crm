import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const prisma = new PrismaClient();

export async function loginService(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new Error('Credenciais inválidas');

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) throw new Error('Credenciais inválidas');

  const payload = { id: user.id, accountId: user.accountId, role: user.role };
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '1h' });
  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET!, { expiresIn: '7d' });

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role, accountId: user.accountId },
  };
}

export function refreshService(token: string) {
  const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET!) as {
    id: string;
    accountId: string;
    role: string;
  };
  const accessToken = jwt.sign(
    { id: payload.id, accountId: payload.accountId, role: payload.role },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  );
  return { accessToken };
}
