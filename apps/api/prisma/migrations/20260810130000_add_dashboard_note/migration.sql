-- CreateEnum
CREATE TYPE "DashboardNoteScope" AS ENUM ('PRIVATE', 'TEAM');

-- CreateTable
CREATE TABLE "DashboardNote" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" "DashboardNoteScope" NOT NULL DEFAULT 'PRIVATE',
    "content" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DashboardNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DashboardNote_accountId_scope_idx" ON "DashboardNote"("accountId", "scope");

-- CreateIndex
CREATE INDEX "DashboardNote_userId_idx" ON "DashboardNote"("userId");
