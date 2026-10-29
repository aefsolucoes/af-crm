CREATE TABLE "CartorioRegiao" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "uf" TEXT NOT NULL,
    "cidade" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "cartorio" TEXT NOT NULL,
    "hits" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CartorioRegiao_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CartorioRegiao_accountId_uf_cidade_chave_cartorio_key" ON "CartorioRegiao"("accountId", "uf", "cidade", "chave", "cartorio");
CREATE INDEX "CartorioRegiao_accountId_uf_cidade_chave_idx" ON "CartorioRegiao"("accountId", "uf", "cidade", "chave");
