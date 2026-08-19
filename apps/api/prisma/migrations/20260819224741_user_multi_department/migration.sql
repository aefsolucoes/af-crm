-- Usuário passa a poder pertencer a MAIS DE UM setor. Reescrito à mão (não
-- confiar no drop+add gerado automaticamente, que perderia os vínculos já
-- cadastrados): adiciona a coluna nova, faz o backfill a partir da antiga,
-- só then dropa a antiga.

-- AddColumn (nova, ainda vazia)
ALTER TABLE "User" ADD COLUMN "departmentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill: quem já tinha um setor definido vira um array de 1 elemento;
-- quem não tinha (NULL) vira array vazio, mesmo comportamento de "sem
-- restrição" que já existe hoje.
UPDATE "User" SET "departmentIds" = ARRAY["departmentId"] WHERE "departmentId" IS NOT NULL;

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_departmentId_fkey";

-- DropColumn (antiga, já sem uso depois do backfill acima)
ALTER TABLE "User" DROP COLUMN "departmentId";
