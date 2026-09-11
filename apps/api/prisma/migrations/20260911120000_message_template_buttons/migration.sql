-- Botão opcional na Resposta rápida (igual ao dos templates Meta, mas só um
-- tipo por vez: resposta rápida OU link).
ALTER TABLE "MessageTemplate" ADD COLUMN "buttonType" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN "quickReplies" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "MessageTemplate" ADD COLUMN "ctaUrlText" TEXT;
ALTER TABLE "MessageTemplate" ADD COLUMN "ctaUrl" TEXT;
