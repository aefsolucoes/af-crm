-- Balão "Dúvidas da IA": perguntas que a IA de atendimento faz pra equipe
-- quando não sabe responder o cliente sozinha.
CREATE TABLE "AiTeamQuestion" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "departmentId" TEXT,
    "question" TEXT NOT NULL,
    "clientMessage" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "answeredByUserId" TEXT,
    "answeredByName" TEXT,
    "answeredAt" TIMESTAMP(3),
    "sentReply" TEXT,
    "sendError" TEXT,
    "knowledgeEntryId" TEXT,
    "knowledgeTitle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiTeamQuestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiTeamQuestion_accountId_status_idx" ON "AiTeamQuestion"("accountId", "status");
CREATE INDEX "AiTeamQuestion_leadId_idx" ON "AiTeamQuestion"("leadId");

ALTER TABLE "AiTeamQuestion" ADD CONSTRAINT "AiTeamQuestion_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiTeamQuestion" ADD CONSTRAINT "AiTeamQuestion_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
