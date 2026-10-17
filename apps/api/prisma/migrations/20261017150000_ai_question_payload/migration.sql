-- Rascunho de e-mail a banco que espera autorização da equipe (kind BANK_EMAIL).
ALTER TABLE "AiTeamQuestion" ADD COLUMN "payload" JSONB;
