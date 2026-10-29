-- Certidão pelo ONR também por ENDEREÇO (Fabio 29/10): quando o cliente não sabe o número da matrícula.
ALTER TABLE "CertidaoRequest" ADD COLUMN "pedidoPor" TEXT NOT NULL DEFAULT 'MATRICULA';
ALTER TABLE "CertidaoRequest" ADD COLUMN "endereco" JSONB;
