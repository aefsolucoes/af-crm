-- Aba "Análise de Crédito" (Fabio 14/10): resultado das análises que as extensões
-- do Chrome (Inter, Creditas, Credimorar/Santander) rodam nos portais dos bancos,
-- pedidos de execução vindos do CRM e a proposta escolhida pra cada cliente.
-- Uma linha por execução (lead × banco): nasce como REQUESTED (pedido pelo CRM) ou
-- RUNNING (a extensão começou sozinha) e evolui até APPROVED/REJECTED/etc.
CREATE TABLE "CreditAnalysis" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "bank" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "detail" TEXT,
    "proposalNumber" TEXT,
    "approvedValue" DOUBLE PRECISION,
    "termMonths" INTEGER,
    "rate" TEXT,
    "indexer" TEXT,
    "firstInstallment" DOUBLE PRECISION,
    "lastInstallment" DOUBLE PRECISION,
    "conditions" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT NOT NULL DEFAULT 'EXTENSION',
    "chosen" BOOLEAN NOT NULL DEFAULT false,
    "requestedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreditAnalysis_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CreditAnalysis_leadId_bank_createdAt_idx" ON "CreditAnalysis"("leadId", "bank", "createdAt");
CREATE INDEX "CreditAnalysis_accountId_status_idx" ON "CreditAnalysis"("accountId", "status");
ALTER TABLE "CreditAnalysis" ADD CONSTRAINT "CreditAnalysis_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
