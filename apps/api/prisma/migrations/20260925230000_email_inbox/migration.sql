-- Caixa de e-mail no CRM: contas IMAP/SMTP (empresa + pessoais) e os
-- e-mails sincronizados delas.
CREATE TABLE "EmailAccount" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "userId" TEXT,
    "address" TEXT NOT NULL,
    "displayName" TEXT,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL DEFAULT 993,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "username" TEXT NOT NULL,
    "passwordEnc" TEXT,
    "syncState" JSONB,
    "lastSyncAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "uid" INTEGER,
    "messageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT,
    "fromName" TEXT,
    "fromAddress" TEXT,
    "toList" JSONB,
    "ccList" JSONB,
    "subject" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "snippet" TEXT,
    "textBody" TEXT,
    "htmlBody" TEXT,
    "attachments" JSONB,
    "seen" BOOLEAN NOT NULL DEFAULT false,
    "leadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailAccount_accountId_address_key" ON "EmailAccount"("accountId", "address");
CREATE INDEX "EmailAccount_userId_idx" ON "EmailAccount"("userId");
CREATE UNIQUE INDEX "EmailMessage_emailAccountId_folder_uid_key" ON "EmailMessage"("emailAccountId", "folder", "uid");
CREATE INDEX "EmailMessage_emailAccountId_folder_date_idx" ON "EmailMessage"("emailAccountId", "folder", "date");
CREATE INDEX "EmailMessage_messageId_idx" ON "EmailMessage"("messageId");
CREATE INDEX "EmailMessage_leadId_idx" ON "EmailMessage"("leadId");

ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
