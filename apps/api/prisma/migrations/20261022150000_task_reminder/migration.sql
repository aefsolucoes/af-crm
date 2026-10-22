-- Push de tarefa na hora do vencimento. Tarefas que já venceram antes desta migração não avisam (evita enxurrada).
ALTER TABLE "Task" ADD COLUMN "reminderSentAt" TIMESTAMP(3);
UPDATE "Task" SET "reminderSentAt" = NOW() WHERE "dueAt" <= NOW() OR "done" = true;
