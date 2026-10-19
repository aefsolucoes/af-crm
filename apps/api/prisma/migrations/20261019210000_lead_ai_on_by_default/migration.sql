-- Fabio 19/10/2026: "deixe sempre a IA ligada para qualquer cliente que entrar". Só muda o padrão de leads NOVOS; não mexe nos existentes.
ALTER TABLE "Lead" ALTER COLUMN "aiAutoReplyActive" SET DEFAULT true;
