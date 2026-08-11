-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_leadId_fkey";

-- DropForeignKey
ALTER TABLE "Note" DROP CONSTRAINT "Note_leadId_fkey";

-- DropForeignKey
ALTER TABLE "Message" DROP CONSTRAINT "Message_leadId_fkey";

-- CreateTable
CREATE TABLE "MessageTemplate" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT 'geral',
    "body" TEXT NOT NULL,
    "variables" TEXT[],
    "triggerText" TEXT,
    "triggerActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageTemplate_accountId_idx" ON "MessageTemplate"("accountId");

-- CreateIndex
CREATE INDEX "MessageTemplate_accountId_triggerActive_idx" ON "MessageTemplate"("accountId", "triggerActive");

-- AddForeignKey
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

