-- Botão "Buscar certidão agora": uma busca avulsa no portal, sem exigir pagamento confirmado
ALTER TABLE "CertidaoRequest" ADD COLUMN "forceCheck" BOOLEAN NOT NULL DEFAULT false;
