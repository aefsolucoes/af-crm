-- Pausa dos e-mails automáticos ao Inter (Vania). Nasce LIGADA (DEFAULT true): Fabio pediu a pausa em 17/10.
ALTER TABLE "CreditAutoSetting" ADD COLUMN "pauseInterEmails" BOOLEAN NOT NULL DEFAULT true;
