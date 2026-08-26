-- A tabela Message nunca teve índice nenhum. A Inbox (getConversations) busca,
-- por conversa, a última mensagem (orderBy createdAt desc take 1) e a contagem
-- de não lidas — sem índice, cada uma dessas vira varredura da tabela inteira,
-- repetida por conversa. Foi degradando conforme as mensagens acumularam até a
-- tela travar carregando e cair em "nenhuma conversa".
CREATE INDEX IF NOT EXISTS "Message_leadId_createdAt_idx" ON "Message"("leadId", "createdAt");

-- Contagem de não lidas por conversa (badge azul da Inbox).
CREATE INDEX IF NOT EXISTS "Message_leadId_read_direction_idx" ON "Message"("leadId", "read", "direction");

-- Caminho de RECEBIMENTO: todo webhook/mensagem nova faz
-- findFirst({ where: { externalId } }) pra deduplicar — sem índice, era uma
-- varredura completa por mensagem recebida.
CREATE INDEX IF NOT EXISTS "Message_externalId_idx" ON "Message"("externalId");
