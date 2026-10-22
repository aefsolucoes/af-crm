-- Painel de custos: lançamentos manuais, uso de fornecedores por volume (Voyage) e cotação do dólar

CREATE TABLE "CostEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "month" TEXT NOT NULL,
    "recurring" BOOLEAN NOT NULL DEFAULT false,
    "endMonth" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'EXTRA',
    "campaign" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CostEntry_accountId_month_idx" ON "CostEntry"("accountId", "month");

CREATE TABLE "ProviderUsage" (
    "day" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "units" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderUsage_pkey" PRIMARY KEY ("day","provider","feature")
);

CREATE TABLE "CostSetting" (
    "accountId" TEXT NOT NULL,
    "usdBrl" DOUBLE PRECISION,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostSetting_pkey" PRIMARY KEY ("accountId")
);
