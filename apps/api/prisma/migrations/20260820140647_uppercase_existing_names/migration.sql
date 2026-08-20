-- DataMigration
-- Backfill: aplica a regra "nome de cliente sempre em CAIXA ALTA" nos
-- cadastros que já existiam antes dessa regra entrar em vigor (o código
-- já normaliza tudo daqui pra frente — ver apps/api/src/lib/text.ts).
--
-- Exclusões deliberadas (mesmas do código):
-- - Lead.isGroup = true — nome de GRUPO do WhatsApp, não é "nome de cliente".
-- - Contact.whatsappPhone terminando em '@g.us' — mesmo caso, do lado do contato.
-- - Contact.whatsappPhone começando com 'self:' — a conversa "📝 Você (...)"
--   consigo mesmo, não é cliente nenhum (ver getOrCreateSelfLead).
--
-- name != UPPER(name) evita atualizar linha que já está em maiúscula.

UPDATE "Lead"
SET name = UPPER(name)
WHERE "isGroup" = false AND name != UPPER(name);

UPDATE "Contact"
SET name = UPPER(name)
WHERE (
  "whatsappPhone" IS NULL
  OR ("whatsappPhone" NOT LIKE '%@g.us' AND "whatsappPhone" NOT LIKE 'self:%')
)
AND name != UPPER(name);
