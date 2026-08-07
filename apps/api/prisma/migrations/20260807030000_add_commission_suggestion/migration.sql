-- CreateEnum
CREATE TYPE "CommissionSuggestionStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DISMISSED');

-- CreateTable
CREATE TABLE "CommissionSuggestion" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "baseAmount" DOUBLE PRECISION NOT NULL,
    "suggestedAmount" DOUBLE PRECISION NOT NULL,
    "status" "CommissionSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "transactionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "CommissionSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommissionSuggestion_accountId_status_idx" ON "CommissionSuggestion"("accountId", "status");
