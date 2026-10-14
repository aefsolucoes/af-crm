-- Fabio 14/10: "tire aquela regra da estrelinha" e "desmarque as estrelinhas".
-- Sai o trigger que zerava a estrela fora de Prospecção/Follow Up/Lead Sem Retorno (a estrela volta a ser manual, em qualquer etapa) e todas as
-- estrelas que existiam são desmarcadas. A estrela automática (HE > R$150 mil, FH > R$300 mil) foi removida do código.
DROP TRIGGER IF EXISTS lead_star_only_early_stages ON "Lead";
DROP FUNCTION IF EXISTS lead_star_only_early_stages();
UPDATE "Lead" SET "starred" = false WHERE "starred" = true;
