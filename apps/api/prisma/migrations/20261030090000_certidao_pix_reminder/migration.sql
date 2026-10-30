-- Lembrete das 18h do PIX da certidão e pedido refeito 1x quando o PIX vence (Fabio 30/10)
ALTER TABLE "CertidaoRequest" ADD COLUMN "pixRemindedAt" TIMESTAMP(3);
ALTER TABLE "CertidaoRequest" ADD COLUMN "retryOfId" TEXT;
