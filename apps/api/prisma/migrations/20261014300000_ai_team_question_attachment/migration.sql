-- Dúvida da IA sobre um documento do cliente: guarda qual arquivo (anexo) está em questão.
ALTER TABLE "AiTeamQuestion" ADD COLUMN "attachmentId" TEXT;
