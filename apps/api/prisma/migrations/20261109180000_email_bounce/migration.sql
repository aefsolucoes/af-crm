-- E-mail que voltou (Fabio 09/11): INEXISTENTE não recebe mais nada; CAIXA_CHEIA pausa os automáticos por 30 dias.
CREATE TABLE "EmailBounce" (
    "accountId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" TEXT,
    "lastAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailBounce_pkey" PRIMARY KEY ("accountId","address")
);
