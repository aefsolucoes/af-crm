-- Histórico reversível do card (botão Reverter): antes/depois dos campos alterados por ações humanas.
CREATE TABLE "LeadChange" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "userId" TEXT,
    "userName" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "changed" TEXT[],
    "revertedAt" TIMESTAMP(3),
    "revertedByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadChange_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LeadChange_leadId_createdAt_idx" ON "LeadChange"("leadId", "createdAt");
