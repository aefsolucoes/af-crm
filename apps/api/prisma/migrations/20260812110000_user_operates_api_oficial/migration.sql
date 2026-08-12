-- Usuário pode operar pela API Oficial (em vez de um número QR específico)
-- — usado no Relatório Matinal para achar os clientes certos.
ALTER TABLE "User" ADD COLUMN "operatesApiOficial" BOOLEAN NOT NULL DEFAULT false;
