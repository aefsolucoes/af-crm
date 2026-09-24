-- Guarda o suficiente do envio de um template Meta pra poder reenviar o
-- MESMO template com um clique quando falha (ver POST /:id/retry-template).
ALTER TABLE "Message" ADD COLUMN "templateName" TEXT;
ALTER TABLE "Message" ADD COLUMN "templateLanguage" TEXT;
ALTER TABLE "Message" ADD COLUMN "templateParams" JSONB;
