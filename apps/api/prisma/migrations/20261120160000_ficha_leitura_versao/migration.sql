-- Leitura guardada da ficha (Fabio 20/11): vale só com a mesma regra de leitura (versao) e o mesmo arquivo (tamanho — versão nova do arquivo no Drive muda o tamanho)
ALTER TABLE "FichaLeitura" ADD COLUMN "versao" TEXT NOT NULL DEFAULT '';
ALTER TABLE "FichaLeitura" ADD COLUMN "tamanho" INTEGER NOT NULL DEFAULT 0;
