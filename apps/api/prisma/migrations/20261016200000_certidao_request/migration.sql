-- Pedido de certidão de matrícula ao RI Digital/ONR (extensão "Certidão ONR").
CREATE TABLE "CertidaoRequest" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "uf" TEXT NOT NULL,
    "cidade" TEXT NOT NULL,
    "cartorio" TEXT NOT NULL,
    "matricula" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "source" TEXT NOT NULL DEFAULT 'USER',
    "requestedById" TEXT,
    "sendPix" BOOLEAN NOT NULL DEFAULT true,
    "clientIntro" TEXT,
    "protocolo" TEXT,
    "numeroRegistral" TEXT,
    "valorCents" INTEGER,
    "pixCode" TEXT,
    "pixExpiresAt" TIMESTAMP(3),
    "pixSentAt" TIMESTAMP(3),
    "detail" TEXT,
    "pdf" BYTEA,
    "pdfName" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextCheckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CertidaoRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CertidaoRequest_accountId_status_idx" ON "CertidaoRequest"("accountId", "status");
CREATE INDEX "CertidaoRequest_leadId_createdAt_idx" ON "CertidaoRequest"("leadId", "createdAt");
