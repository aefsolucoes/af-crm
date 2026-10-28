-- Pedido de permissão da localização dos envios (chave geral + quem fica de fora). Configurações → Localização.
CREATE TABLE "SendLocationSetting" (
    "accountId" TEXT NOT NULL,
    "promptEnabled" BOOLEAN NOT NULL DEFAULT false,
    "disabledUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SendLocationSetting_pkey" PRIMARY KEY ("accountId")
);
