-- Crédito pedido NA RODADA de cada análise (aprovou/reprovou com qual valor): guarda o histórico quando o valor muda (Fabio 15/10).
ALTER TABLE "CreditAnalysis" ADD COLUMN "requestedValue" DOUBLE PRECISION;
