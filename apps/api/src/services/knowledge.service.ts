import { PrismaClient } from '@prisma/client';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import { listKnowledgeFiles, downloadDriveFile } from './google.service';
import { embedDocuments, embedQuery, isVoyageConfigured } from './voyage.service';

const prisma = new PrismaClient();

/**
 * Serviço da Base de Conhecimento (treinamento do assistente).
 * Responsável por transformar os documentos da pasta do Drive em TEXTO e
 * quebrá-lo em pedaços indexáveis. NÃO lida com dados de cliente — só material
 * genérico da empresa (processos, normativos, passo a passo).
 */

/**
 * Extrai texto puro de um documento. Suporta PDF (digital), Word .docx e Google
 * Docs (já exportado como texto). PDFs escaneados (imagem) retornam pouco/nenhum
 * texto — precisariam de OCR, que fica para uma etapa futura.
 */
export async function extractDocumentText(buffer: Buffer, mimeType: string, fileName = ''): Promise<string> {
  try {
    if (mimeType === 'application/pdf') {
      const data = await pdf(buffer);
      return (data.text || '').trim();
    }
    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const { value } = await mammoth.extractRawText({ buffer });
      return (value || '').trim();
    }
    // Google Docs já vem exportado como text/plain; .txt e afins entram aqui.
    if (mimeType === 'application/vnd.google-apps.document' || mimeType.startsWith('text/')) {
      return buffer.toString('utf-8').trim();
    }
    // .doc legado e formatos desconhecidos: melhor esforço como texto.
    return buffer.toString('utf-8').trim();
  } catch (err) {
    console.error(`[Knowledge] Falha ao extrair texto de "${fileName}" (${mimeType}):`, err);
    return '';
  }
}

/**
 * Quebra o texto em pedaços de ~maxChars com sobreposição (overlap), cortando de
 * preferência em quebra de parágrafo/frase para não partir uma ideia no meio.
 * Cada pedaço é uma "unidade" que será indexada e recuperada na busca.
 */
export function chunkText(text: string, maxChars = 1200, overlap = 200): string[] {
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const chunks: string[] = [];
  const minCut = Math.floor(maxChars * 0.5);
  let start = 0;

  while (start < clean.length) {
    let end = Math.min(start + maxChars, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const paraBreak = window.lastIndexOf('\n\n');
      const sentBreak = Math.max(
        window.lastIndexOf('. '), window.lastIndexOf('.\n'),
        window.lastIndexOf('! '), window.lastIndexOf('? '),
      );
      const spaceBreak = window.lastIndexOf(' ');
      const cut =
        paraBreak >= minCut ? paraBreak :
        sentBreak >= minCut ? sentBreak + 1 :
        spaceBreak >= minCut ? spaceBreak :
        window.length;
      end = start + cut;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

// ─── Sincronização (Drive → texto → pedaços → Voyage → tabela) ───────────────

export interface SyncResult {
  indexed: number;   // arquivos (re)indexados
  skipped: number;   // já estavam em dia (não mudaram)
  removed: number;   // sumiram da pasta e foram apagados da base
  failed: number;    // deram erro
  totalChunks: number;
}

/**
 * Sincroniza a Base de Conhecimento com a pasta do Drive configurada:
 * indexa arquivos novos/alterados, pula os que não mudaram e remove os que
 * saíram da pasta. Reprocessa só o necessário (compara modifiedTime).
 */
export async function syncKnowledgeBase(accountId: string): Promise<SyncResult> {
  if (!isVoyageConfigured()) throw new Error('VOYAGE_API_KEY não configurada — defina a chave da Voyage no ambiente.');

  const cfg = await prisma.agentConfig.findUnique({ where: { accountId } });
  const folderId = cfg?.knowledgeFolderId;
  if (!folderId) throw new Error('Nenhuma pasta de base de conhecimento configurada.');

  const driveFiles = await listKnowledgeFiles(accountId, folderId);
  const driveIds = new Set(driveFiles.map((f) => f.id));

  const existing = await prisma.knowledgeFile.findMany({ where: { accountId } });
  const byDriveId = new Map(existing.map((f) => [f.driveFileId, f]));

  let indexed = 0, skipped = 0, failed = 0, totalChunks = 0;

  for (const df of driveFiles) {
    const prev = byDriveId.get(df.id);
    if (prev && prev.status === 'indexed' && prev.modifiedTime === df.modifiedTime) {
      skipped++;
      totalChunks += prev.chunkCount;
      continue;
    }
    try {
      const buffer = await downloadDriveFile(accountId, df.id, df.mimeType);
      const text = await extractDocumentText(buffer, df.mimeType, df.name);
      const pieces = chunkText(text);
      const embeddings = pieces.length ? await embedDocuments(pieces) : [];

      const file = await prisma.knowledgeFile.upsert({
        where: { accountId_driveFileId: { accountId, driveFileId: df.id } },
        create: {
          accountId, driveFileId: df.id, name: df.name, mimeType: df.mimeType,
          modifiedTime: df.modifiedTime, status: 'indexed', chunkCount: pieces.length, indexedAt: new Date(),
        },
        update: {
          name: df.name, mimeType: df.mimeType, modifiedTime: df.modifiedTime,
          status: 'indexed', chunkCount: pieces.length, indexedAt: new Date(), error: null,
        },
      });

      await prisma.knowledgeChunk.deleteMany({ where: { fileId: file.id } });
      if (pieces.length) {
        await prisma.knowledgeChunk.createMany({
          data: pieces.map((content, i) => ({ accountId, fileId: file.id, chunkIndex: i, content, embedding: embeddings[i] })),
        });
      }
      indexed++;
      totalChunks += pieces.length;
    } catch (err: any) {
      failed++;
      const msg = String(err?.message || err).slice(0, 500);
      await prisma.knowledgeFile.upsert({
        where: { accountId_driveFileId: { accountId, driveFileId: df.id } },
        create: { accountId, driveFileId: df.id, name: df.name, mimeType: df.mimeType, modifiedTime: df.modifiedTime, status: 'error', error: msg },
        update: { status: 'error', error: msg },
      }).catch(() => {});
    }
  }

  // Arquivos que saíram da pasta → removidos da base (chunks caem por cascade).
  const toRemove = existing.filter((f) => !driveIds.has(f.driveFileId));
  let removed = 0;
  if (toRemove.length) {
    await prisma.knowledgeFile.deleteMany({ where: { id: { in: toRemove.map((f) => f.id) } } });
    removed = toRemove.length;
  }

  invalidateKnowledgeCache(accountId);
  return { indexed, skipped, removed, failed, totalChunks };
}

// ─── Busca (recupera os trechos mais relevantes para uma pergunta) ───────────

interface CachedChunk { content: string; fileName: string; embedding: number[]; }
// Cache em memória por conta — recarregado após cada sincronização. Evita puxar
// todos os vetores do banco a cada pergunta.
const chunkCache = new Map<string, CachedChunk[]>();

export function invalidateKnowledgeCache(accountId: string): void {
  chunkCache.delete(accountId);
}

async function loadChunks(accountId: string): Promise<CachedChunk[]> {
  const cached = chunkCache.get(accountId);
  if (cached) return cached;
  const rows = await prisma.knowledgeChunk.findMany({
    where: { accountId },
    select: { content: true, embedding: true, file: { select: { name: true } } },
  });
  const chunks = rows.map((r) => ({ content: r.content, fileName: r.file.name, embedding: r.embedding }));
  chunkCache.set(accountId, chunks);
  return chunks;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

export interface KnowledgeHit { content: string; fileName: string; score: number; }

/** Retorna os trechos mais relevantes da base para a pergunta (ou [] se a base está vazia / Voyage não configurada). */
export async function searchKnowledge(accountId: string, query: string, topK = 6): Promise<KnowledgeHit[]> {
  if (!isVoyageConfigured() || !query.trim()) return [];
  const chunks = await loadChunks(accountId);
  if (chunks.length === 0) return [];

  const qv = await embedQuery(query);
  const scored = chunks.map((c) => ({ content: c.content, fileName: c.fileName, score: cosine(qv, c.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  // Corta ruído: só trechos com similaridade minimamente relevante.
  return scored.filter((s) => s.score > 0.3).slice(0, topK);
}

