-- Pasta "LEADS ATIVOS" de cada setor no Google Drive — destino da pasta do
-- cliente quando o card entra em "Documentação Recebida".
ALTER TABLE "Department" ADD COLUMN "activeLeadsFolderId" TEXT;
