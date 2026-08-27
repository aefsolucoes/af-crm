import { PrismaClient } from '@prisma/client';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import { listKnowledgeFiles, downloadDriveFile, ocrDriveFileToText, uploadFile, trashDriveItem } from './google.service';
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
    let stage = 'download';
    try {
      const buffer = await downloadDriveFile(accountId, df.id, df.mimeType);
      stage = 'leitura do texto';
      let text = await extractDocumentText(buffer, df.mimeType, df.name);

      // PDF sem texto extraível → provável escaneado. Tenta OCR via Google Drive
      // (converte para Google Doc com OCR e lê o texto). Reaproveita a conexão do Drive.
      if (!text.trim() && df.mimeType === 'application/pdf') {
        stage = 'OCR (Google Drive)';
        text = await ocrDriveFileToText(accountId, df.id).catch(() => '');
      }

      if (!text.trim()) {
        throw new Error('Nenhum texto extraído. Se for um PDF escaneado, o OCR não conseguiu ler — melhore a qualidade do scan ou salve o conteúdo como Word/Google Doc.');
      }

      stage = 'indexação (Voyage)';
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
      const msg = `Falha na etapa "${stage}": ${String(err?.message || err)}`.slice(0, 500);
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

// ─── Aprender com as conversas do WhatsApp ────────────────────────────────────
// Analisa uma amostra de conversas recentes e pede pro Claude extrair PADRÕES
// de atendimento (dúvidas comuns, como a equipe responde, objeções) — nunca
// dado de cliente específico (nome, telefone, valor do caso etc). O resultado
// vira um documento na própria pasta da Base de Conhecimento e é indexado
// normalmente pelo syncKnowledgeBase, então passa a valer pras respostas do
// assistente como qualquer outro material da base.

export interface LearnResult {
  leadsAnalisados: number;
  documentoCriado: string;
  chunksIndexados: number;
}

const LEARN_DOC_NAME = 'Padroes de Atendimento - WhatsApp (gerado pelo assistente).txt';

export async function learnFromWhatsAppConversations(accountId: string): Promise<LearnResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada.');
  if (!isVoyageConfigured()) throw new Error('VOYAGE_API_KEY não configurada — necessária pra indexar o resultado na Base de Conhecimento.');

  const cfg = await prisma.agentConfig.findUnique({ where: { accountId } });
  if (!cfg?.knowledgeFolderId) throw new Error('Nenhuma pasta de Base de Conhecimento configurada (Configurações → Agente IA).');

  // Amostra: conversas reais mais recentemente ativas (sem grupo, com pelo
  // menos uma troca de mensagens de verdade em cada lado).
  const leads = await prisma.lead.findMany({
    where: { accountId, archived: false, isGroup: false, messages: { some: {} } },
    orderBy: { updatedAt: 'desc' },
    take: 40,
    select: { messages: { orderBy: { createdAt: 'asc' }, take: 20, select: { direction: true, content: true } } },
  });
  const comMensagens = leads.filter((l) => l.messages.length >= 2);
  if (comMensagens.length === 0) throw new Error('Não encontrei conversas com mensagens suficientes para aprender.');

  const transcript = comMensagens
    .map((l, i) => `--- Conversa ${i + 1} ---\n` + l.messages.map((m) => `${m.direction === 'INBOUND' ? 'Cliente' : 'Equipe'}: ${m.content}`).join('\n'))
    .join('\n\n')
    .slice(0, 180000); // teto de segurança pro tamanho do prompt

  const systemPrompt = `Você analisa conversas de WhatsApp entre uma equipe de atendimento (financiamento habitacional e consórcio) e clientes, para extrair PADRÕES ÚTEIS de atendimento — dúvidas comuns e como a equipe costuma responder bem, objeções e como são contornadas, informações que costumam ser pedidas.

REGRA ABSOLUTA: o texto que você gerar NUNCA pode conter nome de cliente, telefone, CPF, endereço, valor específico de um caso, ou qualquer outro dado que identifique uma pessoa ou negociação específica. Generalize tudo — em vez de "João perguntou sobre a taxa do apartamento de R$ 350.000", escreva "Quando o cliente pergunta sobre a taxa de juros, a equipe costuma explicar...". Se não conseguir generalizar algum trecho com segurança, IGNORE esse trecho por completo.

Organize a saída em markdown, com um título por tema (ex.: "## Dúvidas sobre taxas", "## Objeções sobre valor de entrada"), cada um com um resumo do padrão de pergunta e de como a equipe respondeu bem. Seja objetivo — isso vai virar material de consulta para o assistente de IA do CRM responder dúvidas parecidas no futuro. Responda só com o markdown, sem comentário antes ou depois.`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: `Aqui estão as conversas:\n\n${transcript}` }],
    }),
  });
  if (!response.ok) throw new Error(`Erro ao analisar conversas: ${response.status} ${(await response.text()).slice(0, 300)}`);
  const data = await response.json() as { content: { type: string; text?: string }[] };
  const patterns = data.content?.find((b) => b.type === 'text')?.text?.trim();
  if (!patterns) throw new Error('Não consegui extrair nenhum padrão das conversas.');

  // Remove a versão anterior (se houver) pra não acumular duplicatas a cada execução.
  const existingFiles = await listKnowledgeFiles(accountId, cfg.knowledgeFolderId);
  const prev = existingFiles.find((f) => f.name === LEARN_DOC_NAME);
  if (prev) await trashDriveItem(accountId, prev.id).catch(() => {});

  await uploadFile(accountId, {
    name: LEARN_DOC_NAME,
    mimeType: 'text/plain',
    data: Buffer.from(patterns, 'utf-8'),
    parentId: cfg.knowledgeFolderId,
  });

  const syncResult = await syncKnowledgeBase(accountId);

  return { leadsAnalisados: comMensagens.length, documentoCriado: LEARN_DOC_NAME, chunksIndexados: syncResult.totalChunks };
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

/**
 * Roda syncKnowledgeBase para TODA conta que tem uma pasta configurada —
 * chamada num intervalo (ver index.ts), pra ninguém precisar clicar em
 * "Sincronizar" toda vez que sobe um arquivo novo na pasta do Drive. Segura
 * (idempotente): syncKnowledgeBase já pula arquivo que não mudou desde a
 * última vez (por modifiedTime), então rodar de novo em cima do que já
 * estava sincronizado não reprocessa/reembeda à toa. Uma conta falhando
 * (Drive desconectado, sem crédito de embedding etc) não impede as outras.
 */
export async function syncAllKnowledgeBases(): Promise<void> {
  const configs = await prisma.agentConfig.findMany({
    where: { knowledgeFolderId: { not: null } },
    select: { accountId: true },
  });
  for (const cfg of configs) {
    try {
      const result = await syncKnowledgeBase(cfg.accountId);
      if (result.indexed > 0 || result.failed > 0) {
        console.log(`[Base de Conhecimento] Sync automático accountId=${cfg.accountId}: ${result.indexed} indexados, ${result.skipped} sem mudança, ${result.failed} falhas`);
      }
    } catch (err) {
      console.error(`[Base de Conhecimento] Sync automático falhou para accountId=${cfg.accountId}:`, (err as any)?.message);
    }
  }
}

