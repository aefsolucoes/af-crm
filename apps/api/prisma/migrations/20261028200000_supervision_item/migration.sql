-- Supervisão de sexta: um item por card "Em contratação" por semana
CREATE TABLE "SupervisionItem" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "weekKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resumo" TEXT NOT NULL,
    "situacao" TEXT,
    "pendencias" TEXT,
    "sugestao" TEXT,
    "acao" TEXT,
    "sentText" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupervisionItem_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupervisionItem_weekKey_leadId_key" ON "SupervisionItem"("weekKey", "leadId");
CREATE INDEX "SupervisionItem_accountId_weekKey_status_idx" ON "SupervisionItem"("accountId", "weekKey", "status");
