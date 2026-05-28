-- AlterEnum: adiciona DATA_EDIT ao NoteType
ALTER TYPE "NoteType" ADD VALUE IF NOT EXISTS 'DATA_EDIT';

-- AlterTable: adiciona userId e updatedAt à Note
ALTER TABLE "Note" ADD COLUMN IF NOT EXISTS "userId" TEXT;
ALTER TABLE "Note" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT NOW();

-- AddForeignKey: Note.userId → User.id (opcional)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Note_userId_fkey'
  ) THEN
    ALTER TABLE "Note" ADD CONSTRAINT "Note_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
