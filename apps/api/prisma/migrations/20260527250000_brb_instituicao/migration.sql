-- Adiciona BRB às opções do campo Instituição (select)
UPDATE "FieldDefinition"
SET options = ARRAY['Caixa', 'Bradesco', 'Itaú', 'Santander', 'BB', 'BRB', 'Inter', 'Outro']
WHERE key = 'instituicao';
