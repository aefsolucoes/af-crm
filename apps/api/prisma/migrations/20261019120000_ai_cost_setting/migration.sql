-- Chaves de economia da IA (Base de Conhecimento enxuta / sugestão no Haiku). Sem linha = Haiku nas sugestões ligado, Base enxuta desligada.
CREATE TABLE "AiCostSetting" (
    "accountId" TEXT NOT NULL,
    "kbLean" BOOLEAN NOT NULL DEFAULT false,
    "suggestHaiku" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AiCostSetting_pkey" PRIMARY KEY ("accountId")
);
