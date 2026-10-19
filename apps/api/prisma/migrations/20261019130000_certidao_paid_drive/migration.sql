-- Certidão: só confere a emissão depois do pagamento confirmado; PDF vai pro Drive (nada guardado no CRM)
ALTER TABLE "CertidaoRequest" ADD COLUMN "paidAt" TIMESTAMP(3);
ALTER TABLE "CertidaoRequest" ADD COLUMN "paidVia" TEXT;
ALTER TABLE "CertidaoRequest" ADD COLUMN "driveFileId" TEXT;
ALTER TABLE "CertidaoRequest" ADD COLUMN "driveUrl" TEXT;
