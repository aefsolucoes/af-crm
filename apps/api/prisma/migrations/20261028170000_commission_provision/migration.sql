-- CreateTable
CREATE TABLE "CommissionProvision" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "leadName" TEXT NOT NULL,
    "product" TEXT,
    "payer" TEXT,
    "baseAmount" DOUBLE PRECISION NOT NULL,
    "ratePct" DOUBLE PRECISION NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "expectedDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "receivedAmount" DOUBLE PRECISION,
    "receivedAt" TIMESTAMP(3),
    "transactionId" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionProvision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionProvision_accountId_status_idx" ON "CommissionProvision"("accountId", "status");

-- CreateIndex
CREATE INDEX "CommissionProvision_leadId_idx" ON "CommissionProvision"("leadId");
