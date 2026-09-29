-- Pedido de ligação do cliente vira um item do balão "Dúvidas da IA": a
-- Andreia confirma o horário (ou propõe outro) antes de agendar.
ALTER TABLE "AiTeamQuestion" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'QUESTION';
ALTER TABLE "AiTeamQuestion" ADD COLUMN "callWhen" TEXT;
ALTER TABLE "AiTeamQuestion" ADD COLUMN "callAt" TIMESTAMP(3);
