-- Custos pagos × estimados (Fabio 14/11): dia da cobrança no cartão e fechamento/vencimento da fatura
ALTER TABLE "CostEntry" ADD COLUMN "paidAt" TEXT;
ALTER TABLE "CostEntry" ADD COLUMN "chargeDay" INTEGER;
ALTER TABLE "CostSetting" ADD COLUMN "cardClosingDay" INTEGER NOT NULL DEFAULT 22;
ALTER TABLE "CostSetting" ADD COLUMN "cardDueDay" INTEGER NOT NULL DEFAULT 27;
