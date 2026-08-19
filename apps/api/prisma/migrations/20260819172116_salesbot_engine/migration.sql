/*
  Warnings:

  - Added the required column `updatedAt` to the `SalesBot` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "SalesBotRunStatus" AS ENUM ('RUNNING', 'WAITING_REPLY', 'WAITING_TIME', 'COMPLETED', 'STOPPED', 'ERROR');

-- DropIndex
DROP INDEX "WhatsAppConfig_accountId_key";

-- AlterTable
ALTER TABLE "SalesBot" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL;

-- CreateTable
CREATE TABLE "SalesBotRun" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "salesBotId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "status" "SalesBotRunStatus" NOT NULL DEFAULT 'RUNNING',
    "currentStepId" TEXT,
    "resumeAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesBotRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesBotRunLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT,
    "stepType" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SalesBotRunLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SalesBotRun_leadId_idx" ON "SalesBotRun"("leadId");

-- CreateIndex
CREATE INDEX "SalesBotRun_status_resumeAt_idx" ON "SalesBotRun"("status", "resumeAt");

-- CreateIndex
CREATE INDEX "SalesBotRunLog_runId_idx" ON "SalesBotRunLog"("runId");

-- CreateIndex
CREATE INDEX "SalesBot_accountId_idx" ON "SalesBot"("accountId");

-- AddForeignKey
ALTER TABLE "SalesBotRun" ADD CONSTRAINT "SalesBotRun_salesBotId_fkey" FOREIGN KEY ("salesBotId") REFERENCES "SalesBot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesBotRunLog" ADD CONSTRAINT "SalesBotRunLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SalesBotRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
