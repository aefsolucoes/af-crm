-- Templates (Respostas rápidas) também passam a ter setor — null = "compartilhado"
-- (todo mundo vê, como já era antes dos departamentos existirem).
ALTER TABLE "MessageTemplate" ADD COLUMN "departmentId" TEXT;
ALTER TABLE "MessageTemplate" ADD CONSTRAINT "MessageTemplate_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "MessageTemplate_departmentId_idx" ON "MessageTemplate"("departmentId");
