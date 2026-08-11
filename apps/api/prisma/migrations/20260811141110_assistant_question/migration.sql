-- CreateTable
CREATE TABLE "AssistantQuestion" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "askedByUserId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campo" TEXT NOT NULL,
    "pergunta" TEXT NOT NULL,
    "resposta" TEXT,
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "AssistantQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssistantQuestion_accountId_targetUserId_answered_idx" ON "AssistantQuestion"("accountId", "targetUserId", "answered");

-- AddForeignKey
ALTER TABLE "AssistantQuestion" ADD CONSTRAINT "AssistantQuestion_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantQuestion" ADD CONSTRAINT "AssistantQuestion_askedByUserId_fkey" FOREIGN KEY ("askedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantQuestion" ADD CONSTRAINT "AssistantQuestion_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantQuestion" ADD CONSTRAINT "AssistantQuestion_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

