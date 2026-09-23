-- Chamada de voz via WhatsApp Calling API (WebRTC) + permissão do cliente
-- pra receber ligação da empresa. Migration aditiva, não toca em tabela
-- existente.

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'CONNECTING', 'CONNECTED', 'ENDED', 'MISSED', 'REJECTED', 'FAILED');

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "whatsappConfigId" TEXT NOT NULL,
    "leadId" TEXT,
    "waCallId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "fromPhone" TEXT NOT NULL,
    "toPhone" TEXT NOT NULL,
    "answeredByUserId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallPermission" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "consecutiveUnanswered" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CallPermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Call_waCallId_key" ON "Call"("waCallId");

-- CreateIndex
CREATE INDEX "Call_accountId_idx" ON "Call"("accountId");

-- CreateIndex
CREATE INDEX "Call_leadId_idx" ON "Call"("leadId");

-- CreateIndex
CREATE INDEX "CallPermission_accountId_contactId_idx" ON "CallPermission"("accountId", "contactId");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_whatsappConfigId_fkey" FOREIGN KEY ("whatsappConfigId") REFERENCES "WhatsAppConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_answeredByUserId_fkey" FOREIGN KEY ("answeredByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallPermission" ADD CONSTRAINT "CallPermission_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallPermission" ADD CONSTRAINT "CallPermission_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
