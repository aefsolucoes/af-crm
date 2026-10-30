-- Cliente disse que pagou o PIX da certidão: a extensão confere no portal (Fabio 30/10)
ALTER TABLE "CertidaoRequest" ADD COLUMN "paidClaimedAt" TIMESTAMP(3);
