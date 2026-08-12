-- Setores/linhas de negócio (ex: Financiamento Habitacional, Consórcio) —
-- cada colaborador não-admin passa a enxergar só o que é do seu setor.

CREATE TABLE "Department" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Department_accountId_idx" ON "Department"("accountId");

ALTER TABLE "Department" ADD CONSTRAINT "Department_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- User.departmentId
ALTER TABLE "User" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "User" ADD CONSTRAINT "User_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Pipeline.departmentId
ALTER TABLE "Pipeline" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Pipeline_departmentId_idx" ON "Pipeline"("departmentId");

-- WhatsAppNumber.departmentId
ALTER TABLE "WhatsAppNumber" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "WhatsAppNumber" ADD CONSTRAINT "WhatsAppNumber_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "WhatsAppNumber_departmentId_idx" ON "WhatsAppNumber"("departmentId");
