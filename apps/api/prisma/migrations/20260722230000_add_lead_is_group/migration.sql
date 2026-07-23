-- Marca conversas de grupo do WhatsApp (aba "Grupos" na Inbox)
ALTER TABLE "Lead" ADD COLUMN "isGroup" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: leads cujo contato tem JID de grupo (@g.us) são grupos
UPDATE "Lead" l
SET "isGroup" = true
FROM "Contact" c
WHERE l."contactId" = c."id"
  AND c."whatsappPhone" LIKE '%@g.us';
