-- AlterTable
ALTER TABLE "AgentConfig" ADD COLUMN     "knowledgeFolderId" TEXT,
ADD COLUMN     "knowledgeFolderName" TEXT;

-- CreateTable
CREATE TABLE "KnowledgeFile" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "modifiedTime" TEXT,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "indexedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeFile_accountId_idx" ON "KnowledgeFile"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeFile_accountId_driveFileId_key" ON "KnowledgeFile"("accountId", "driveFileId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_accountId_idx" ON "KnowledgeChunk"("accountId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_fileId_idx" ON "KnowledgeChunk"("fileId");

-- AddForeignKey
ALTER TABLE "KnowledgeFile" ADD CONSTRAINT "KnowledgeFile_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "KnowledgeFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
