-- Chave pública pro site externo chamar POST /api/webhooks/site-lead
ALTER TABLE "Account" ADD COLUMN "leadIntakeApiKey" TEXT;
CREATE UNIQUE INDEX "Account_leadIntakeApiKey_key" ON "Account"("leadIntakeApiKey");
