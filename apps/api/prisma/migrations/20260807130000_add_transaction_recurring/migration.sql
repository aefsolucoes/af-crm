-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "isRecurring" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "recurringDay" INTEGER,
ADD COLUMN "recurringParentId" TEXT;
