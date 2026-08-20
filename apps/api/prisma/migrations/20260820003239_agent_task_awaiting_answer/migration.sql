-- AlterEnum
-- ADD VALUE precisa ficar sozinha na migration (sem mais nenhuma instrução
-- no mesmo arquivo) — Postgres não permite usar um valor novo de enum na
-- mesma transação em que ele foi criado.
ALTER TYPE "AgentTaskStatus" ADD VALUE 'AWAITING_ANSWER';
