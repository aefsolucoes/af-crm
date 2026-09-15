import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { syncKnowledgeBase, listKnowledgeEntries, createKnowledgeEntry, updateKnowledgeEntry, deleteKnowledgeEntry } from '../services/knowledge.service';
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

// ─── Entradas manuais (correções/fatos digitados direto, sem Drive) ──────────
// "Um lugar pra ir ajustando as respostas — o que deveria ter sido dito" —
// participam da mesma busca semântica que os documentos do Drive
// (searchKnowledge), com a diferença de poderem ser escopadas por setor.

// GET /api/knowledge/entries
router.get('/entries', async (req: AuthRequest, res: Response) => {
  try {
    const entries = await listKnowledgeEntries(req.user!.accountId);
    res.json(entries);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar as entradas da base de conhecimento' });
  }
});

// POST /api/knowledge/entries
router.post('/entries', async (req: AuthRequest, res: Response) => {
  try {
    const { title, content, departmentId } = req.body as { title?: string; content?: string; departmentId?: string | null };
    const entry = await createKnowledgeEntry(req.user!.accountId, { title: title || '', content: content || '', departmentId: departmentId || null });
    res.status(201).json(entry);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao criar a entrada' });
  }
});

// PUT /api/knowledge/entries/:id
router.put('/entries/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { title, content, departmentId } = req.body as { title?: string; content?: string; departmentId?: string | null };
    const entry = await updateKnowledgeEntry(req.params.id, req.user!.accountId, { title: title || '', content: content || '', departmentId: departmentId || null });
    if (!entry) return res.status(404).json({ error: 'Entrada não encontrada' });
    res.json(entry);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao atualizar a entrada' });
  }
});

// DELETE /api/knowledge/entries/:id
router.delete('/entries/:id', async (req: AuthRequest, res: Response) => {
  try {
    const ok = await deleteKnowledgeEntry(req.params.id, req.user!.accountId);
    if (!ok) return res.status(404).json({ error: 'Entrada não encontrada' });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Erro ao apagar a entrada' });
  }
});

export default router;
