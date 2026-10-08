-- "Valor da venda" (Lead.value) preenchido sozinho a partir da proposta
-- quando está vazio (Fabio 08/10 — a faixa de valor total do funil mostrava
-- 802 de 828 cards do Habitacional sem valor):
--   Home Equity → valor do crédito (customFields.valor_credito)
--   Financiamento Habitacional → valor financiado (valor_credito; se não
--     tiver, valor do imóvel − entrada, só quando os dois existem)
-- Nunca sobrescreve um valor já preenchido. Trigger no banco: vale pra
-- qualquer caminho (proposta por WhatsApp/e-mail, IA, edição, importação).

CREATE OR REPLACE FUNCTION af_parse_money(t TEXT) RETURNS NUMERIC AS $$
DECLARE s TEXT;
BEGIN
  IF t IS NULL THEN RETURN NULL; END IF;
  s := regexp_replace(t, '[^0-9.,]', '', 'g');
  IF s = '' THEN RETURN NULL; END IF;
  IF s ~ ',' OR s ~ '^[0-9]{1,3}(\.[0-9]{3})+$' THEN
    s := replace(replace(s, '.', ''), ',', '.');
  END IF;
  RETURN s::numeric;
EXCEPTION WHEN others THEN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION lead_fill_sale_value() RETURNS TRIGGER AS $$
DECLARE
  dep TEXT;
  v NUMERIC;
  imovel NUMERIC;
  entrada NUMERIC;
BEGIN
  IF COALESCE(NEW."value", 0) > 0 OR NEW."customFields" IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT lower(d."name") INTO dep
    FROM "Pipeline" p LEFT JOIN "Department" d ON d."id" = p."departmentId"
   WHERE p."id" = NEW."pipelineId";
  IF dep IS NULL OR (dep NOT LIKE '%home equity%' AND dep NOT LIKE '%habitacional%') THEN
    RETURN NEW;
  END IF;
  v := af_parse_money(NEW."customFields"->>'valor_credito');
  IF (v IS NULL OR v <= 0) AND dep LIKE '%habitacional%' THEN
    imovel := af_parse_money(NEW."customFields"->>'valor_imovel');
    entrada := af_parse_money(NEW."customFields"->>'valor_entrada');
    IF imovel IS NOT NULL AND entrada IS NOT NULL AND imovel > entrada THEN
      v := imovel - entrada;
    END IF;
  END IF;
  IF v IS NOT NULL AND v > 0 THEN
    NEW."value" := v;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lead_fill_sale_value
BEFORE INSERT OR UPDATE ON "Lead"
FOR EACH ROW EXECUTE FUNCTION lead_fill_sale_value();

-- Completa os cards antigos (sem mexer no updatedAt, pra não bagunçar a ordem).
UPDATE "Lead" SET "updatedAt" = "updatedAt"
 WHERE COALESCE("value", 0) <= 0
   AND ("customFields" ? 'valor_credito' OR ("customFields" ? 'valor_imovel' AND "customFields" ? 'valor_entrada'));
