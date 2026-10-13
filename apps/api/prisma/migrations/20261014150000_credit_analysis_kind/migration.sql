-- Tipo do pedido de análise: RUN (rodar a análise no banco) ou CHECK (só conferir o resultado de uma proposta
-- que já foi enviada — ex.: ver no portal do Inter se virou "aprovado condicional", sem criar proposta duplicada).
ALTER TABLE "CreditAnalysis" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'RUN';
