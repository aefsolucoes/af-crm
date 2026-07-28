/**
 * Cliente da Voyage AI — gera "embeddings" (vetores de significado) para a Base
 * de Conhecimento. A chave vem da variável de ambiente VOYAGE_API_KEY (setada no
 * Railway). O modelo pode ser trocado via VOYAGE_MODEL.
 */

const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = process.env.VOYAGE_MODEL || 'voyage-3.5';
const MAX_BATCH = 32; // itens por chamada — lotes menores evitam limites de tamanho/taxa

export function isVoyageConfigured(): boolean {
  return !!process.env.VOYAGE_API_KEY;
}

async function callVoyage(inputs: string[], inputType: 'document' | 'query', attempt = 0): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error('VOYAGE_API_KEY não configurada');

  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ input: inputs, model: VOYAGE_MODEL, input_type: inputType }),
  });

  // Limite de taxa (429) ou erro temporário (5xx): espera e tenta de novo (backoff).
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, Math.min(1500 * 2 ** attempt, 12000)));
    return callVoyage(inputs, inputType, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Voyage ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  // Garante a ordem original (a API devolve com o campo index).
  return data.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

/** Embeddings de vários trechos (documentos), em lotes. */
export async function embedDocuments(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    out.push(...(await callVoyage(texts.slice(i, i + MAX_BATCH), 'document')));
  }
  return out;
}

/** Embedding de uma pergunta (query). */
export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await callVoyage([text], 'query');
  return vec;
}
