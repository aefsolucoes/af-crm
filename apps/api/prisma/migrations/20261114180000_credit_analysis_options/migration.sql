-- Creditas: todas as opções aprovadas do portal (o CRM escolhe pelo pedido do card)
ALTER TABLE "CreditAnalysis" ADD COLUMN "options" JSONB;
