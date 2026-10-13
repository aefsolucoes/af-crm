-- Ajustes de um cliente para a análise de crédito (valor do imóvel/financiamento, renda, prazo,
-- renda do 2º participante, inverter titular). Antes ficavam só no popup de cada extensão;
-- agora são feitos na aba "Análise de Crédito" e as extensões leem daqui. Um por cliente × banco.
CREATE TABLE "CreditOverride" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "bank" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreditOverride_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreditOverride_leadId_bank_key" ON "CreditOverride"("leadId", "bank");
ALTER TABLE "CreditOverride" ADD CONSTRAINT "CreditOverride_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
