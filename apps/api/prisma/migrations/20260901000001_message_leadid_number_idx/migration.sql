-- Cobre o GROUP BY leadId+whatsappNumberId de getConversations() — monta
-- "todo número que já falou com este lead" pras abas por número da Inbox.
CREATE INDEX IF NOT EXISTS "Message_leadId_whatsappNumberId_idx" ON "Message"("leadId", "whatsappNumberId");
