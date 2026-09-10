-- Pasta do Drive pra onde vão os anexos do WhatsApp (auto-upload). Quando
-- definida, cada anexo vai pra <esta pasta>/<telefone do cliente>/arquivo
-- (telefone = DDD + número, sem DDI). Sem ela, mantém o comportamento antigo:
-- <pasta-raiz>/WhatsApp — arquivo automático/<nome do cliente>/arquivo.
-- Aditiva e nullable — o admin cola o link em Configurações → Google Drive.
ALTER TABLE "GoogleConnection" ADD COLUMN "whatsappAttachmentsFolderId" TEXT;
ALTER TABLE "GoogleConnection" ADD COLUMN "whatsappAttachmentsFolderName" TEXT;
