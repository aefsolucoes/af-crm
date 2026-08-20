-- DataMigration
-- Consolida os dois campos duplicados de "pasta do cliente no Drive" que
-- existiam no cadastro do lead: "Pasta Drive" (key pasta_drive, campo
-- semeado desde o início) e "Pasta no Drive" (key link_pasta_drive, criado
-- automaticamente pelo assistente/Agente de Navegador na primeira vez que
-- precisou salvar um link — é esse que o código de verdade lê e escreve,
-- ver DRIVE_LINK_FIELD_KEY em apps/api/src/routes/ai.ts). Mantém só
-- link_pasta_drive.

-- 1) Leads que só tinham o campo antigo preenchido: copia o valor pro novo
-- (não sobrescreve quem já tinha algo em link_pasta_drive).
UPDATE "Lead"
SET "customFields" = jsonb_set(
  "customFields"::jsonb,
  '{link_pasta_drive}',
  "customFields"::jsonb -> 'pasta_drive'
)
WHERE "customFields" IS NOT NULL
  AND "customFields"::jsonb ? 'pasta_drive'
  AND COALESCE("customFields"::jsonb ->> 'pasta_drive', '') != ''
  AND COALESCE("customFields"::jsonb ->> 'link_pasta_drive', '') = '';

-- 2) Remove a chave antiga de customFields em todo mundo — não é mais lida
-- por lugar nenhum do código.
UPDATE "Lead"
SET "customFields" = "customFields"::jsonb - 'pasta_drive'
WHERE "customFields" IS NOT NULL AND "customFields"::jsonb ? 'pasta_drive';

-- 3) Remove a definição de campo duplicada — só "Pasta no Drive" continua
-- aparecendo no cadastro do lead.
DELETE FROM "FieldDefinition" WHERE key = 'pasta_drive';
