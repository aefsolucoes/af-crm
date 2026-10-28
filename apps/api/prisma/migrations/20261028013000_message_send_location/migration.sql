-- Localização do aparelho em cada envio da equipe (relatório em Configurações → Localização).
CREATE TABLE "MessageSendLocation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "leadName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "detail" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MessageSendLocation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "MessageSendLocation_messageId_key" ON "MessageSendLocation"("messageId");
CREATE INDEX "MessageSendLocation_accountId_createdAt_idx" ON "MessageSendLocation"("accountId", "createdAt");
CREATE INDEX "MessageSendLocation_userId_createdAt_idx" ON "MessageSendLocation"("userId", "createdAt");
