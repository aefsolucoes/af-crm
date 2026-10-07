-- Estrela só em Prospecção, Follow Up e Lead Sem Retorno (Fabio 07/10: "os
-- clientes que não estiverem em prospecção, follow up e lead sem retorno não
-- deverão estar com a estrelinha"). Trigger no banco, igual ao
-- stageEnteredAt: vale pra QUALQUER caminho (mover na tela, automação, IA,
-- formulário, estrela automática, clicar na estrela), sem depender de cada um.
CREATE OR REPLACE FUNCTION lead_star_only_early_stages() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."starred" AND NOT EXISTS (
    SELECT 1 FROM "Stage" s
    WHERE s."id" = NEW."stageId" AND lower(s."name") ~ '^(prospec|follow ?up|lead sem retorno)'
  ) THEN
    NEW."starred" := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lead_star_only_early_stages
BEFORE INSERT OR UPDATE ON "Lead"
FOR EACH ROW EXECUTE FUNCTION lead_star_only_early_stages();

-- Cards que já estão com estrela fora desses estágios.
UPDATE "Lead" l SET "starred" = false
WHERE l."starred" = true AND NOT EXISTS (
  SELECT 1 FROM "Stage" s
  WHERE s."id" = l."stageId" AND lower(s."name") ~ '^(prospec|follow ?up|lead sem retorno)'
);
