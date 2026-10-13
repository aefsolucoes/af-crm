-- "Valor da venda" (Lead.value) ACOMPANHA o valor do crédito (Home Equity / Financiamento Habitacional): quando o crédito do card muda
-- por qualquer caminho (proposta do site por e-mail/WhatsApp, IA, edição, importação), o valor da venda muda junto — desde que ele vinha
-- acompanhando o crédito (vazio ou igual ao crédito anterior). Valor da venda editado à mão (diferente do crédito) é respeitado.
-- Antes: o trigger lead_fill_sale_value só preenchia valor VAZIO; um card que nasceu da simulação (crédito R$ 250.000) e depois recebeu a
-- proposta com crédito de R$ 150.000 ficava com Valor da venda R$ 250.000 (Rafaela Andrade, 13/10 — Fabio: "valor de venda deveria
-- aparecer o valor de crédito").

CREATE OR REPLACE FUNCTION lead_sale_value_follows_credit() RETURNS TRIGGER AS $$
DECLARE
  dep TEXT;
  vold NUMERIC;
  vnew NUMERIC;
BEGIN
  IF NEW."customFields" IS NULL THEN
    RETURN NEW;
  END IF;
  vnew := af_parse_money(NEW."customFields"->>'valor_credito');
  vold := af_parse_money(OLD."customFields"->>'valor_credito');
  IF vnew IS NULL OR vnew <= 0 OR vnew IS NOT DISTINCT FROM vold THEN
    RETURN NEW;
  END IF;
  SELECT lower(d."name") INTO dep
    FROM "Pipeline" p LEFT JOIN "Department" d ON d."id" = p."departmentId"
   WHERE p."id" = NEW."pipelineId";
  IF dep IS NULL OR (dep NOT LIKE '%home equity%' AND dep NOT LIKE '%habitacional%') THEN
    RETURN NEW;
  END IF;
  -- O valor da venda vinha acompanhando o crédito (vazio ou igual ao crédito antigo) e esta mesma edição não mexeu nele: acompanha.
  IF (COALESCE(OLD."value", 0) = 0 OR OLD."value" = vold) AND NEW."value" IS NOT DISTINCT FROM OLD."value" THEN
    NEW."value" := vnew;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS lead_sale_value_follows_credit_trg ON "Lead";
CREATE TRIGGER lead_sale_value_follows_credit_trg
  BEFORE UPDATE OF "customFields" ON "Lead"
  FOR EACH ROW EXECUTE FUNCTION lead_sale_value_follows_credit();
