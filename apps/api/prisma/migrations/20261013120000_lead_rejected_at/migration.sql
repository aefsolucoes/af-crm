-- "Reprovado" (Fabio 13/10): cliente que passou pela Pré-Análise e foi reprovado
-- pelos bancos. Marca de data no card; o card também vai pra Perdido (status
-- LOST + funil Perdidos). Alimenta o painel mensal do Dashboard.
ALTER TABLE "Lead" ADD COLUMN "rejectedAt" TIMESTAMP(3);
