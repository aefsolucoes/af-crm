-- Leitura de cada documento pela ficha de cadastro (Fabio 20/11): a ficha relida só manda pra IA o arquivo que ainda não leu
CREATE TABLE "FichaLeitura" (
    "leadId" TEXT NOT NULL,
    "driveFileId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "leitura" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FichaLeitura_pkey" PRIMARY KEY ("leadId","driveFileId")
);
