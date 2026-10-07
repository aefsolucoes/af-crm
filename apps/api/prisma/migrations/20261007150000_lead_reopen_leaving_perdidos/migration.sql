-- Card Perdido que sai do funil "Perdidos" (mover na tela, em massa,
-- automação, IA) volta a ficar Aberto sozinho, com nota no card (Fabio
-- 07/10, Jean: foi movido de Perdidos pra Pré-Analise e continuou Perdido —
-- teve que reabrir na mão pra marcar Perdido de novo). Só na SAÍDA do funil
-- Perdidos: marcar como Perdido (que muda o status antes de mover pro
-- Perdidos) não é afetado.
CREATE OR REPLACE FUNCTION lead_reopen_leaving_perdidos() RETURNS TRIGGER AS $$
DECLARE
  old_pipe TEXT;
  new_pipe TEXT;
BEGIN
  IF NEW."status" = 'LOST' AND NEW."pipelineId" IS DISTINCT FROM OLD."pipelineId" THEN
    SELECT p."name" INTO old_pipe FROM "Pipeline" p WHERE p."id" = OLD."pipelineId";
    SELECT p."name" INTO new_pipe FROM "Pipeline" p WHERE p."id" = NEW."pipelineId";
    IF old_pipe = 'Perdidos' AND new_pipe IS DISTINCT FROM 'Perdidos' THEN
      NEW."status" := 'OPEN';
      NEW."archived" := false;
      INSERT INTO "Note" ("id", "content", "type", "leadId", "createdAt", "updatedAt")
      VALUES (
        'reopen' || replace(gen_random_uuid()::text, '-', ''),
        '🔓 Card reaberto automaticamente: saiu do funil "Perdidos" para "' || COALESCE(new_pipe, '?') || '". Status alterado para "Aberto".'
          || CASE WHEN COALESCE(OLD."lostReason", '') <> '' THEN ' Motivo da perda: ' || OLD."lostReason" ELSE '' END,
        'DATA_EDIT', NEW."id", NOW(), NOW()
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lead_reopen_leaving_perdidos
BEFORE UPDATE ON "Lead"
FOR EACH ROW EXECUTE FUNCTION lead_reopen_leaving_perdidos();
