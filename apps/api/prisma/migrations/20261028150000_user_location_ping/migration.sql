-- Localizador da equipe: um ponto por abertura do CRM (Configurações → Localização).
CREATE TABLE "UserLocationPing" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracy" DOUBLE PRECISION,
    "status" TEXT NOT NULL DEFAULT 'OK',
    "detail" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserLocationPing_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "UserLocationPing_accountId_createdAt_idx" ON "UserLocationPing"("accountId", "createdAt");
CREATE INDEX "UserLocationPing_userId_createdAt_idx" ON "UserLocationPing"("userId", "createdAt");
