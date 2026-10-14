-- Pedido do PDF de simulação (Evolução das parcelas) ao portal Credimorar; o CRM põe a logo A&F e envia ao cliente.
CREATE TABLE "SimulationDocRequest" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "institution" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "source" TEXT NOT NULL DEFAULT 'USER',
    "requestedById" TEXT,
    "caption" TEXT,
    "detail" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SimulationDocRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SimulationDocRequest_accountId_status_idx" ON "SimulationDocRequest"("accountId", "status");
CREATE INDEX "SimulationDocRequest_leadId_createdAt_idx" ON "SimulationDocRequest"("leadId", "createdAt");
