-- Valor líquido do contrato (Creditas): o aviso de aprovação ao cliente mostra só ele.
ALTER TABLE "CreditAnalysis" ADD COLUMN "netValue" DOUBLE PRECISION;
