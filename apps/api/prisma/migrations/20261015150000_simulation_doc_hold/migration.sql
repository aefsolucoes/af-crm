-- Simulação em PDF segura (hold) até o aviso de aprovação sair: o PDF pronto fica guardado e vai logo depois do texto.
ALTER TABLE "SimulationDocRequest" ADD COLUMN "hold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "pdf" BYTEA;
