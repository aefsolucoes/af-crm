-- AlterTable
ALTER TABLE "User" ADD COLUMN     "whatsAppNumberId" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_whatsAppNumberId_fkey" FOREIGN KEY ("whatsAppNumberId") REFERENCES "WhatsAppNumber"("id") ON DELETE SET NULL ON UPDATE CASCADE;
