-- CreateTable
CREATE TABLE "MetaLeadsConfig" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "verifyToken" TEXT NOT NULL DEFAULT 'af_meta_verify',
    "pageAccessToken" TEXT NOT NULL DEFAULT '',
    "defaultStageId" TEXT,
    "defaultUserId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MetaLeadsConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaLeadsConfig_accountId_key" ON "MetaLeadsConfig"("accountId");

-- AddForeignKey
ALTER TABLE "MetaLeadsConfig" ADD CONSTRAINT "MetaLeadsConfig_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
