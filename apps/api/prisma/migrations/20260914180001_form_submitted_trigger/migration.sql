-- AlterEnum
-- ADD VALUE precisa ficar sozinha na migration (sem mais nenhuma instrução
-- no mesmo arquivo) — Postgres não permite usar um valor novo de enum na
-- mesma transação em que ele foi criado. Mesmo padrão já usado em
-- 20260820003239_agent_task_awaiting_answer.
ALTER TYPE "AutomationTrigger" ADD VALUE 'FORM_SUBMITTED';
