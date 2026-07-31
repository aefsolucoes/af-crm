import { PrismaClient, User } from '@prisma/client';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { randomInt } from 'crypto';
import { isEmailConfigured, sendLoginCodeEmail } from './email.service';
import { effectivePermissions } from '../lib/permissions';

const prisma = new PrismaClient();

// Códigos de acesso (2ª etapa do login) guardados em memória, com validade
// curta. Se a API reiniciar, o usuário só pede um novo código. Não persistimos
// em banco de propósito: o código vive minutos e é descartável.
interface LoginCode {
  codeHash: string;
  expiresAt: number;
  attempts: number;
}
const loginCodes = new Map<string, LoginCode>(); // chave: userId
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function issueTokens(user: User) {
  const payload = { id: user.id, accountId: user.accountId, role: user.role };
  const accessToken = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: '1h' });
  const refreshToken = jwt.sign(payload, process.env.JWT_REFRESH_SECRET!, { expiresIn: '7d' });
  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role, accountId: user.accountId,
      themeColor: user.themeColor, themeImage: user.themeImage, themeOpacity: user.themeOpacity,
      permissions: effectivePermissions(user.role, user.permissions),
    },
  };
}

// 1ª etapa: valida e-mail + senha. Se o e-mail estiver configurado, gera um
// código, envia para o e-mail cadastrado e pede a 2ª etapa. Caso contrário,
// entra direto (para não trancar ninguém antes do SMTP estar pronto).
export async function loginService(email: string, password: string) {
  // E-mail é sempre guardado em minúsculas na criação; normaliza aqui também
  // para o login não ligar para maiúscula/minúscula (ex.: "Fabio@..." x "fabio@...").
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) throw new Error('Credenciais inválidas');

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) throw new Error('Credenciais inválidas');

  if (!isEmailConfigured()) {
    return issueTokens(user);
  }

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  const codeHash = await bcrypt.hash(code, 10);
  loginCodes.set(user.id, { codeHash, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });

  try {
    await sendLoginCodeEmail(user.email, user.name, code);
  } catch {
    loginCodes.delete(user.id);
    throw new Error('Não consegui enviar o código para o seu e-mail. Tente novamente em instantes.');
  }

  // Não devolvemos tokens ainda — só a indicação de que falta o código.
  return { requiresCode: true, email: user.email };
}

// 2ª etapa: confere o código enviado por e-mail e só então entrega os tokens.
export async function verifyLoginCodeService(email: string, code: string) {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!user) throw new Error('Código inválido');

  const rec = loginCodes.get(user.id);
  if (!rec) throw new Error('Código expirado. Solicite um novo.');
  if (Date.now() > rec.expiresAt) {
    loginCodes.delete(user.id);
    throw new Error('Código expirado. Solicite um novo.');
  }
  if (rec.attempts >= MAX_ATTEMPTS) {
    loginCodes.delete(user.id);
    throw new Error('Muitas tentativas. Solicite um novo código.');
  }

  const ok = await bcrypt.compare(code, rec.codeHash);
  if (!ok) {
    rec.attempts += 1;
    throw new Error('Código inválido.');
  }

  loginCodes.delete(user.id);
  return issueTokens(user);
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
