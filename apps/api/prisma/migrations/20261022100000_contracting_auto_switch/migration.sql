-- Chave geral dos passos automáticos da contratação (desligada por padrão: a equipe faz à mão)
ALTER TABLE "CreditAutoSetting" ADD COLUMN "contractingAuto" BOOLEAN NOT NULL DEFAULT false;
