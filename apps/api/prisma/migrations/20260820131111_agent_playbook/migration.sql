-- CreateTable
CREATE TABLE "AgentPlaybook" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "steps" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sourceTaskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPlaybook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentPlaybook_accountId_idx" ON "AgentPlaybook"("accountId");
