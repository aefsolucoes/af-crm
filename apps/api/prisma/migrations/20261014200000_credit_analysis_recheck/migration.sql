-- Conferência repetida (de 1 em 1 min): quando o resultado ainda não saiu, a mesma linha volta pra fila com "não antes de"
-- e uma contagem de tentativas, até sair o resultado ou chegar no limite.
ALTER TABLE "CreditAnalysis" ADD COLUMN "notBefore" TIMESTAMP(3);
ALTER TABLE "CreditAnalysis" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 0;
