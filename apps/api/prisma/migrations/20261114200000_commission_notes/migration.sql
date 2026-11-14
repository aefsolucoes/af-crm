-- Nota de comissão (Fabio 14/11): vários processos numa nota; valor real por processo e taxa aprendida por banco/produto
ALTER TABLE "CommissionProvision" ADD COLUMN "noteId" TEXT;
ALTER TABLE "CommissionProvision" ADD COLUMN "estimatedAmount" DOUBLE PRECISION;
ALTER TABLE "CommissionProvision" ADD COLUMN "rateLocked" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "CommissionProvision_noteId_idx" ON "CommissionProvision"("noteId");

CREATE TABLE "CommissionNote" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "payer" TEXT NOT NULL,
    "number" TEXT,
    "issueDate" TIMESTAMP(3),
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fileName" TEXT,
    "fileMime" TEXT,
    "fileData" BYTEA,
    "aiRead" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "receivedAt" TIMESTAMP(3),
    "transactionId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CommissionNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CommissionNote_accountId_status_idx" ON "CommissionNote"("accountId", "status");
