-- Ações de automação adiadas (mensagem inicial 10 min depois, só se o cliente ainda não falou com a gente).
CREATE TABLE "AutomationDeferred" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "actionIndex" INTEGER NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),
    CONSTRAINT "AutomationDeferred_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AutomationDeferred_status_runAt_idx" ON "AutomationDeferred"("status", "runAt");
CREATE INDEX "AutomationDeferred_leadId_ruleId_idx" ON "AutomationDeferred"("leadId", "ruleId");
