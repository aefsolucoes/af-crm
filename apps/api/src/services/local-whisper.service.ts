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

/** Só liga com LOCAL_WHISPER=on (variável do Railway): o modelo ocupa memória do servidor — liga depois de medir. */
export function localWhisperAvailable(): boolean {
  return process.env.LOCAL_WHISPER === 'on';
}

/** Transcreve um áudio de voz (OGG/Opus) no servidor. Fila de 1. */
export function transcribeLocally(buffer: Buffer, mimeType: string): Promise<string | null> {
  if (!localWhisperAvailable() || !buffer?.length || buffer.length > 8 * 1024 * 1024) return Promise.resolve(null);
  if (!/ogg|opus/i.test(mimeType || '')) return Promise.resolve(null); // só o formato dos áudios de voz do WhatsApp
  const job = queue.then(async () => {
    const t0 = Date.now();
    try {
      const pcm = await decodeOggOpus(buffer);
      if (!pcm || pcm.length < 16000 * 0.4) return null; // vazio ou < 0,4 s
      if (pcm.length / 16000 > MAX_SECONDS) return null;
      const pipe = await getPipeline();
      const run = pipe(pcm, { language: 'portuguese', task: 'transcribe', chunk_length_s: 30 });
      const out: any = await Promise.race([run, new Promise((_, rej) => setTimeout(() => rej(new Error('demorou demais')), TIMEOUT_MS))]);
      const text = String(Array.isArray(out) ? out.map((o: any) => o.text).join(' ') : out?.text || '').replace(/\s+/g, ' ').trim();
      console.log(`[Transcrição local] ${Math.round(pcm.length / 16000)}s de áudio em ${Math.round((Date.now() - t0) / 1000)}s: ${text.length} caracteres`);
      return text || null;
    } catch (e: any) {
      console.error('[Transcrição local] erro:', e?.message);
      return null;
    }
  });
  queue = job.catch(() => null);
  return job as Promise<string | null>;
}
