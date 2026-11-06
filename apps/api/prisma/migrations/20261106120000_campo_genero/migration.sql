-- Campo "Gênero" (genero_1) no card, preenchido pelas propostas do site
INSERT INTO "FieldDefinition" ("id", "accountId", "tab", "name", "key", "type", "options", "order")
SELECT 'fd_genero_' || a."id", a."id", 'Principal', 'Gênero', 'genero_1', 'TEXT', ARRAY[]::TEXT[], 13
FROM "Account" a
WHERE NOT EXISTS (SELECT 1 FROM "FieldDefinition" f WHERE f."accountId" = a."id" AND f."key" = 'genero_1');
