-- Resposta com citação a uma mensagem específica da mesma conversa (como no
-- WhatsApp) — não é uma relação de verdade, guarda conteúdo "congelado".
ALTER TABLE "Message" ADD COLUMN "replyToExternalId" TEXT;
ALTER TABLE "Message" ADD COLUMN "replyToContent" TEXT;
ALTER TABLE "Message" ADD COLUMN "replyToSender" TEXT;
