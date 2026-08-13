-- Contato compartilhado no WhatsApp (cartão de contato/vCard) — permite
-- "Conversar" ou "Criar lead" direto a partir da mensagem.
ALTER TABLE "Message" ADD COLUMN "sharedContactName" TEXT;
ALTER TABLE "Message" ADD COLUMN "sharedContactPhone" TEXT;
