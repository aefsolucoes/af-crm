/**
 * Transcrição de áudio de cliente RODANDO NO PRÓPRIO SERVIDOR do CRM (Fabio 16/10: o crédito do ElevenLabs acabou e os áudios ficaram sem texto — "não tem como o próprio CRM fazer isso?").
 * Whisper (modelo aberto, via @huggingface/transformers + onnxruntime) com o decodificador Ogg/Opus em WASM (sem ffmpeg). Só serve de RESERVA do ElevenLabs (speech-to-text.service):
 * sem custo por áudio, um pouco menos preciso. Carrega o modelo na 1ª vez (baixa uma vez e guarda em disco) e processa UM áudio por vez (fila), pra não estourar a memória da API.
 * Nunca lança: qualquer problema → null.
 */
const MODEL = process.env.LOCAL_WHISPER_MODEL || 'onnx-community/whisper-base';
const MAX_SECONDS = 150; // áudio de WhatsApp acima disso (2min30) não vale o custo de CPU
const TIMEOUT_MS = 120_000;

// import() de verdade (o tsc em CommonJS trocaria por require e quebraria nos pacotes só-ESM)
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;

let pipePromise: Promise<any> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function getPipeline(): Promise<any> {
  if (!pipePromise) {
    pipePromise = (async () => {
      const tf: any = await esmImport('@huggingface/transformers');
      tf.env.cacheDir = process.env.LOCAL_WHISPER_CACHE || '/tmp/whisper-cache';
      return tf.pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8' });
    })().catch((e) => { pipePromise = null; throw e; });
  }
  return pipePromise;
}

/** OGG/Opus (áudio de voz do WhatsApp) → PCM mono 16 kHz em Float32. */
async function decodeOggOpus(buffer: Buffer): Promise<Float32Array | null> {
  const { OggOpusDecoder } = await esmImport('ogg-opus-decoder');
  const dec = new OggOpusDecoder();
  await dec.ready;
  try {
    const out = await dec.decodeFile(new Uint8Array(buffer));
    const canais: Float32Array[] = out.channelData;
    if (!canais?.length || !out.samplesDecoded) return null;
    const n = canais[0].length;
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (const c of canais) s += c[i]; mono[i] = s / canais.length; }
    const de: number = out.sampleRate || 48000;
    if (de === 16000) return mono;
    const razao = de / 16000, len = Math.floor(n / razao);
    const res = new Float32Array(len);
    for (let i = 0; i < len; i++) { // média das amostras de cada janela (filtro simples contra aliasing)
      const a = Math.floor(i * razao), b = Math.min(n, Math.floor((i + 1) * razao));
      let s = 0; for (let k = a; k < b; k++) s += mono[k];
      res[i] = s / Math.max(1, b - a);
    }
    return res;
  } finally { dec.free(); }
}

/** Memória livre do container (cgroup; sem cgroup, a do sistema) em MB. O modelo + onnxruntime pedem ~1 GB de folga: sem isso NÃO carrega (estourar a memória derrubaria a API toda). */
function memoriaLivreMB(): number | null {
  try {
    const fs = require('fs') as typeof import('fs');
    const lim = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (lim === 'max') return Math.round((require('os') as typeof import('os')).freemem() / 1048576);
    const usado = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
    return Math.round((Number(lim) - usado) / 1048576);
  } catch { return Math.round((require('os') as typeof import('os')).freemem() / 1048576); }
}
let avisouMemoria = false;

/** Corta laços de repetição do Whisper: a mesma palavra 4+ vezes seguidas vira 1, e um trecho de até 6 palavras repetido 3+ vezes vira 1. Pura (testável). */
export function limparRepeticoes(raw: string): string {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/(^|\s)(\S+)(?:\s+\2){3,}(?=\s|$)/gi, '$1$2');
  for (let n = 6; n >= 2; n--) t = t.replace(new RegExp(`((?:\\S+\\s+){${n - 1}}\\S+)(?:\\s+\\1){2,}`, 'gi'), '$1');
  return t.trim();
}

/** Só liga com LOCAL_WHISPER=on (variável do Railway): o modelo ocupa memória do servidor — liga depois de medir. */
export function localWhisperAvailable(): boolean {
  return process.env.LOCAL_WHISPER === 'on';
}

/** Transcreve um áudio de voz (OGG/Opus) no servidor. Fila de 1. */
export function transcribeLocally(buffer: Buffer, mimeType: string, opts: { maxWaitMs?: number } = {}): Promise<string | null> {
  if (!localWhisperAvailable() || !buffer?.length || buffer.length > 8 * 1024 * 1024) return Promise.resolve(null);
  if (!/ogg|opus/i.test(mimeType || '')) return Promise.resolve(null); // só o formato dos áudios de voz do WhatsApp
  const job = queue.then(async () => {
    const t0 = Date.now();
    try {
      const pcm = await decodeOggOpus(buffer);
      if (!pcm || pcm.length < 16000 * 0.4) return null; // vazio ou < 0,4 s
      if (pcm.length / 16000 > MAX_SECONDS) return null;
      if (!pipePromise) { // 1ª carga: confere a folga de memória antes
        const livre = memoriaLivreMB();
        if (livre !== null && livre < 1100) { if (!avisouMemoria) { avisouMemoria = true; console.warn(`[Transcrição local] memória livre ${livre} MB — não carrego o modelo (precisa de ~1100 MB de folga)`); } return null; }
      }
      const pipe = await getPipeline();
      const seg = pcm.length / 16000;
      // Whisper às vezes entra em laço ("a a a a…") e gera texto de 900 caracteres pra 10 s de áudio (16/10): teto de tokens proporcional à duração + penalidade de repetição.
      const run = pipe(pcm, { language: 'portuguese', task: 'transcribe', chunk_length_s: 30, max_new_tokens: Math.max(48, Math.ceil(seg * 7)), repetition_penalty: 1.1, no_repeat_ngram_size: 4 });
      const out: any = await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('demorou demais')), TIMEOUT_MS))]);
      const text = limparRepeticoes(String(Array.isArray(out) ? out.map((o: any) => o.text).join(' ') : out?.text || ''));
      console.log(`[Transcrição local] ${Math.round(pcm.length / 16000)}s de áudio em ${Math.round((Date.now() - t0) / 1000)}s: ${text.length} caracteres (memória livre ${memoriaLivreMB() ?? 'n/d'} MB)`);
      return text || null;
    } catch (e: any) {
      console.error('[Transcrição local] erro:', e?.message);
      return null;
    }
  });
  queue = job.catch(() => null);
  if (opts.maxWaitMs) return Promise.race([job as Promise<string | null>, new Promise<null>((r) => setTimeout(() => r(null), opts.maxWaitMs))]); // na chegada da mensagem: se demorar, segue sem texto e o reprocessamento termina depois
  return job as Promise<string | null>;
}
