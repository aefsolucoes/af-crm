ALTER TABLE "KnowledgeEntry" ADD COLUMN "fixedKey" TEXT;
CREATE UNIQUE INDEX "KnowledgeEntry_accountId_fixedKey_key" ON "KnowledgeEntry"("accountId", "fixedKey");
