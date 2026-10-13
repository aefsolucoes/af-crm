-- Aviso vermelho quando a Meta bloqueia o envio por pagamento / conta restrita /
-- token inválido (Fabio 13/10). Estado guardado na própria config do WhatsApp:
-- alertCode = código do erro da Meta (131042, 131031, 190) ou 999000 (a Meta
-- informa conta bloqueada na checagem de saúde); null = sem alerta.
ALTER TABLE "WhatsAppConfig" ADD COLUMN "alertCode" INTEGER;
ALTER TABLE "WhatsAppConfig" ADD COLUMN "alertMessage" TEXT;
ALTER TABLE "WhatsAppConfig" ADD COLUMN "alertAt" TIMESTAMP(3);
ALTER TABLE "WhatsAppConfig" ADD COLUMN "alertPushAt" TIMESTAMP(3);
