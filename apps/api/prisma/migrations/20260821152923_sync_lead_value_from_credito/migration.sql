-- DataMigration
-- Backfill: sincroniza Lead.value com customFields.valor_credito nos leads
-- que já tinham o crédito preenchido mas o valor do card desatualizado —
-- mesmo caso que a PATCH /:id/custom-fields passa a evitar daqui pra
-- frente (ver rota). Só toca lead que TEM valor_credito numérico válido e
-- diferente do value atual (evita reescrever quem já estava certo).
UPDATE "Lead"
SET value = ("customFields"->>'valor_credito')::numeric
WHERE "customFields" IS NOT NULL
  AND "customFields"::jsonb ? 'valor_credito'
  AND ("customFields"->>'valor_credito') ~ '^-?[0-9]+(\.[0-9]+)?$'
  AND ("customFields"->>'valor_credito')::numeric IS DISTINCT FROM value;
