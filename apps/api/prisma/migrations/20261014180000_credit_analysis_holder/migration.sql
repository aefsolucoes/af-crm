-- Em nome de quem a análise foi feita (titular na análise). Quando as participantes são invertidas, é o 2º participante;
-- o aviso de aprovação ao cliente precisa dizer isso ("aprovado no nome de ...").
ALTER TABLE "CreditAnalysis" ADD COLUMN "holderName" TEXT;
