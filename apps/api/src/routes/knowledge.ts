import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { syncKnowledgeBase } from '../services/knowledge.service';
import { isVoyageConfigured } from '../services/voyage.service';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

/** Extrai o ID da pasta de um link do Drive, ou aceita um ID já puro. */
function parseFolderId(input: string): string | null {
  const s = (input || '').trim();
  if (!s) return null;
  const m = s.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{20,}$/.test(s)) return s; // parece um ID puro
  return null;
}

// GET /api/knowledge/status — configuração + lista de arquivos + contagens
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const accountId = req.user!.accountId;
    const cfg = await prisma.agentConfig.findUnique({ where: { accountId } });
    const files = await prisma.knowledgeFile.findMany({
      where: { accountId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, mimeType: true, status: true, chunkCount: true, error: true, indexedAt: true },
    });
    res.json({
      voyageConfigured: isVoyageConfigured(),
      folderId: cfg?.knowledgeFolderId ?? null,
      folderName: cfg?.knowledgeFolderName ?? null,
      files,
      totalChunks: files.reduce((n, f) => n + f.chunkCount, 0),
    });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar a base de conhecimento' });
  }
});

// PUT /api/knowledge/folder — define a pasta do Drive (aceita link ou ID)
router.put('/folder', async (req: AuthRequest, res: Response) => {
  try {
    const { folder, folderName } = req.body as { folder?: string; folderName?: string };
    const folderId = parseFolderId(String(folder || ''));
    if (!folderId) return res.status(400).json({ error: 'Link ou ID de pasta do Drive inválido' });

    const accountId = req.user!.accountId;
    const existing = await prisma.agentConfig.findUnique({ where: { accountId } });
    const cfg = await prisma.agentConfig.upsert({
      where: { accountId },
      update: { knowledgeFolderId: folderId, knowledgeFolderName: folderName?.trim() || null },
      // systemPrompt é obrigatório; se ainda não existe config, cria vazio (o assistente cai no prompt padrão).
      create: { accountId, systemPrompt: existing?.systemPrompt ?? '', knowledgeFolderId: folderId, knowledgeFolderName: folderName?.trim() || null },
    });
    res.json({ folderId: cfg.knowledgeFolderId, folderName: cfg.knowledgeFolderName });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar a pasta da base' });
  }
});

// POST /api/knowledge/sync — sincroniza a base com a pasta do Drive
router.post('/sync', async (req: AuthRequest, res: Response) => {
  try {
    const result = await syncKnowledgeBase(req.user!.accountId);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao sincronizar a base' });
  }
});

export default router;
