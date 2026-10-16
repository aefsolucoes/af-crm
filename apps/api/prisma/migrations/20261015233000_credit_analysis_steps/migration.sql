-- Linha do tempo dos passos de cada rodada (passo + horário): mostra ONDE o tempo vai (fila, digitação, espera da tela de resultado…). Fabio 15/10.
ALTER TABLE "CreditAnalysis" ADD COLUMN "steps" JSONB;
