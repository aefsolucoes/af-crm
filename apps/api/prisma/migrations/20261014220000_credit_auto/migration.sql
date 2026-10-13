-- Chave liga/desliga da "Análise automática" (aba Análise de Crédito): quando a proposta chega e a IA confere os dados, as análises
-- rodam sozinhas nos bancos; se o 1º participante vier reprovado/aprovado a menor roda no 2º, e o cliente é avisado das opções.
-- Desligada por padrão. `enabledAt` = só cards que chegaram na Pré-Análise DEPOIS de ligar entram (não mexe nos antigos).
CREATE TABLE "CreditAutoSetting" (
    "accountId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreditAutoSetting_pkey" PRIMARY KEY ("accountId")
);
