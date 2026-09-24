-- Campos aditivos pra ligação de voz aparecer como mensagem dentro da conversa.
ALTER TABLE "Message" ADD COLUMN "callWaCallId" TEXT;
ALTER TABLE "Message" ADD COLUMN "callStatus" TEXT;
ALTER TABLE "Message" ADD COLUMN "callDurationSec" INTEGER;

CREATE UNIQUE INDEX "Message_callWaCallId_key" ON "Message"("callWaCallId");
