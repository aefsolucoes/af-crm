-- Lista de números de WhatsApp (+ "API" pro pseudo-canal API Oficial) que o
-- usuário pode enxergar — substitui o par whatsAppNumberId/operatesApiOficial
-- (seletor único) por uma lista, permitindo marcar mais de um.
ALTER TABLE "User" ADD COLUMN "whatsAppNumberIds" TEXT[] NOT NULL DEFAULT '{}';

-- Preserva o que já estava configurado: quem tinha "API Oficial" marcado vira
-- ['API']; quem tinha um número QR marcado vira [aquele id]; quem não tinha
-- nada marcado continua sem restrição (lista vazia).
UPDATE "User" SET "whatsAppNumberIds" =
  CASE
    WHEN "operatesApiOficial" THEN ARRAY['API']
    WHEN "whatsAppNumberId" IS NOT NULL THEN ARRAY["whatsAppNumberId"]
    ELSE ARRAY[]::TEXT[]
  END
WHERE "operatesApiOficial" = true OR "whatsAppNumberId" IS NOT NULL;
