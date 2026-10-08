-- Card Perdido movido pra QUALQUER estágio fora do funil "Perdidos" volta a
-- ficar Aberto, com nota (Fabio 08/10, Calixto Wolfart: Perdido, a equipe
-- levou até a contratação e o card continuou Perdido). Antes só reabria ao
-- sair do funil Perdidos. Marcar Perdido não é afetado: o status muda antes
-- de o card ir pro Perdidos, sem trocar de estágio no mesmo update.
CREATE OR REPLACE FUNCTION lead_reopen_leaving_perdidos() RETURNS TRIGGER AS $$
DECLARE
  old_pipe TEXT;
  new_pipe TEXT;
  new_stage TEXT;
BEGIN
  IF NEW."status" = 'LOST' AND NEW."stageId" IS DISTINCT FROM OLD."stageId" THEN
    SELECT p."name" INTO old_pipe FROM "Pipeline" p WHERE p."id" = OLD."pipelineId";
    SELECT p."name" INTO new_pipe FROM "Pipeline" p WHERE p."id" = NEW."pipelineId";
    SELECT s."name" INTO new_stage FROM "Stage" s WHERE s."id" = NEW."stageId";
    IF new_pipe IS DISTINCT FROM 'Perdidos' THEN
      NEW."status" := 'OPEN';
      NEW."archived" := false;
      INSERT INTO "Note" ("id", "content", "type", "leadId", "createdAt", "updatedAt")
      VALUES (
        'reopen' || replace(gen_random_uuid()::text, '-', ''),
        '🔓 Card reaberto automaticamente: '
          || CASE WHEN old_pipe = 'Perdidos'
               THEN 'saiu do funil "Perdidos" para "' || COALESCE(new_pipe, '?') || '" (' || COALESCE(new_stage, '?') || ').'
               ELSE 'foi movido para "' || COALESCE(new_pipe, '?') || ' → ' || COALESCE(new_stage, '?') || '" enquanto estava Perdido.' END
          || ' Status alterado para "Aberto".'
          || CASE WHEN COALESCE(OLD."lostReason", '') <> '' THEN ' Motivo da perda: ' || OLD."lostReason" ELSE '' END,
        'DATA_EDIT', NEW."id", NOW(), NOW()
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
