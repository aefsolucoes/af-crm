-- Registro silencioso de atividade da equipe (mexer em card, responder cliente…).
CREATE TABLE "ActivityLog" (
  "id"        TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "userId"    TEXT,
  "userName"  TEXT NOT NULL,
  "action"    TEXT NOT NULL,
  "leadId"    TEXT,
  "leadName"  TEXT,
  "summary"   TEXT NOT NULL,
  "channel"   TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActivityLog_accountId_createdAt_idx" ON "ActivityLog" ("accountId", "createdAt");
CREATE INDEX "ActivityLog_leadId_idx" ON "ActivityLog" ("leadId");

ALTER TABLE "ActivityLog"
  ADD CONSTRAINT "ActivityLog_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
