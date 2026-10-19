-- "Recebi sua proposta certinha" (regras "Entrada em Pré-Análise …") só pra proposta NOVA: não repete quando o card volta à Pré-Análise
-- (reaberto/movido à mão) com a análise já rodada ou o mesmo aviso já enviado (Fabio 19/10, Mara). O motor lê config.onlyForNewProposal.
UPDATE "AutomationRule"
SET "actions" = (
  SELECT jsonb_agg(
    CASE
      WHEN a->>'type' = 'send_message' AND a->'config'->>'message' LIKE '%Recebi sua proposta certinha%'
        THEN jsonb_set(a, '{config,onlyForNewProposal}', 'true'::jsonb)
      ELSE a
    END
  )
  FROM jsonb_array_elements("actions"::jsonb) AS a
)
WHERE "trigger" = 'STAGE_CHANGE' AND "actions"::text LIKE '%Recebi sua proposta certinha%';
