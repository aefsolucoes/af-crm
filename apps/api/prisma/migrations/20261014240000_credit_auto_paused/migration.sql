-- Pausa geral das execuções automáticas de análise de crédito.
ALTER TABLE "CreditAutoSetting" ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false;
