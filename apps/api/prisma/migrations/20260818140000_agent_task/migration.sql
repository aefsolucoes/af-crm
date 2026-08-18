-- Agente de Navegador (Fase 1) — tarefas e log de auditoria por passo.
CREATE TYPE "AgentTaskStatus" AS ENUM ('PENDING', 'RUNNING', 'AWAITING_APPROVAL', 'AWAITING_HUMAN_TAKEOVER', 'COMPLETED', 'FAILED', 'CANCELLED');

CREATE TABLE "AgentTask" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "leadId" TEXT,
    "instruction" TEXT NOT NULL,
    "status" "AgentTaskStatus" NOT NULL DEFAULT 'PENDING',
    "conversation" JSONB NOT NULL DEFAULT '[]',
    "pendingAction" JSONB,
    "resultSummary" TEXT,
    "errorMessage" TEXT,
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentTask_accountId_userId_idx" ON "AgentTask"("accountId", "userId");
CREATE INDEX "AgentTask_status_idx" ON "AgentTask"("status");

CREATE TABLE "AgentActionLog" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "requiredApproval" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentActionLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentActionLog_taskId_seq_idx" ON "AgentActionLog"("taskId", "seq");
