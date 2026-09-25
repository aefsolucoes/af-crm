-- Quando o lead entrou na etapa atual — base das automações "X dias na
-- etapa" (ex.: lembrete de documentação só depois de 3 dias em Aguardando
-- Documentação). Mantido por trigger no próprio banco, então vale pra
-- QUALQUER caminho que troque a etapa (tela, automação, IA, formulário,
-- SalesBot, mover em massa), sem depender de cada um lembrar de gravar.
ALTER TABLE "Lead" ADD COLUMN "stageEnteredAt" TIMESTAMP(3);

-- Cards que já existem: última troca de etapa registrada, senão a criação.
UPDATE "Lead" l SET "stageEnteredAt" = COALESCE(
  (SELECT MAX(a."createdAt") FROM "ActivityLog" a WHERE a."leadId" = l."id" AND a."action" IN ('lead_stage_changed', 'lead_pipeline_changed', 'leads_bulk_moved')),
  l."createdAt"
);

CREATE OR REPLACE FUNCTION lead_set_stage_entered_at() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."stageEnteredAt" := COALESCE(NEW."stageEnteredAt", NOW());
  ELSIF NEW."stageId" IS DISTINCT FROM OLD."stageId" THEN
    NEW."stageEnteredAt" := NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lead_stage_entered_at
BEFORE INSERT OR UPDATE ON "Lead"
FOR EACH ROW EXECUTE FUNCTION lead_set_stage_entered_at();
