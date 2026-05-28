-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "avatar" TEXT;

-- AlterTable
ALTER TABLE "MetaLeadsConfig" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Note" ALTER COLUMN "updatedAt" DROP DEFAULT;
