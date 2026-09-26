-- "Esqueci minha senha": token do link (hash) + validade, e data da última
-- troca de senha (derruba sessões antigas).
ALTER TABLE "User" ADD COLUMN "passwordResetHash" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordResetExpiresAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
