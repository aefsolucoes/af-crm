-- Motivo informado ao marcar um lead como Perdido.
ALTER TABLE "Lead" ADD COLUMN "lostReason" TEXT;
