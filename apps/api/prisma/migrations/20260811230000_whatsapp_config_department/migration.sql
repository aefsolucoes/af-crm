-- WhatsAppConfig deixa de ser 1-por-conta e passa a ser 1-por-DEPARTAMENTO
-- (ex: um número na API Oficial da Meta para Financiamento Habitacional,
-- outro para Consórcio). departmentId null = config "antiga"/genérica.

ALTER TABLE "WhatsAppConfig" DROP CONSTRAINT IF EXISTS "WhatsAppConfig_accountId_key";

ALTER TABLE "WhatsAppConfig" ADD COLUMN "departmentId" TEXT;

ALTER TABLE "WhatsAppConfig" ADD CONSTRAINT "WhatsAppConfig_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "WhatsAppConfig_accountId_departmentId_key" ON "WhatsAppConfig"("accountId", "departmentId");
