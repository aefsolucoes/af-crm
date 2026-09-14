-- Marcação "importante/prioridade" no lead (estrela no card do Kanban)
ALTER TABLE "Lead" ADD COLUMN "starred" BOOLEAN NOT NULL DEFAULT false;
