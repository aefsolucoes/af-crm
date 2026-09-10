-- Marca quando o Google recusa o refresh token (invalid_grant): a conexão
-- existe no banco mas não funciona mais — precisa reconectar. Limpo no
-- reconnect (handleOAuthCallback) ou quando o token volta a funcionar.
ALTER TABLE "GoogleConnection" ADD COLUMN "tokenInvalid" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "GoogleConnection" ADD COLUMN "tokenInvalidAt" TIMESTAMP(3);
