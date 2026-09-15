-- Entrada MANUAL da Base de Conhecimento (fato/correção digitado direto pelo
-- usuário, sem precisar subir arquivo no Drive) — participa da mesma busca
-- semântica que KnowledgeChunk. departmentId null = "compartilhada" (mesmo
-- critério de MessageTemplate.departmentId).
CREATE TABLE "KnowledgeEntry" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "departmentId" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KnowledgeEntry_accountId_idx" ON "KnowledgeEntry"("accountId");

CREATE INDEX "KnowledgeEntry_departmentId_idx" ON "KnowledgeEntry"("departmentId");

ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
