-- Certidão ONR: guarda todos os arquivos que o portal devolve (matrícula + certidão de ônus), não só o primeiro
ALTER TABLE "CertidaoRequest" ADD COLUMN "files" JSONB;
