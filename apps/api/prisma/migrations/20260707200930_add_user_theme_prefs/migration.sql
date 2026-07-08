-- AlterTable
ALTER TABLE "User" ADD COLUMN     "themeColor" TEXT NOT NULL DEFAULT 'white',
ADD COLUMN     "themeImage" TEXT,
ADD COLUMN     "themeOpacity" INTEGER NOT NULL DEFAULT 85;
