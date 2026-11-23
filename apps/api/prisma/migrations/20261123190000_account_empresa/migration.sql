-- Dados da empresa por conta (plano do piloto, Fabio 23/11): nome, assinatura, telefone, site, convênio CAIXA… Vazio = os da A&F (lib/empresa.ts).
ALTER TABLE "Account" ADD COLUMN "empresa" JSONB;
