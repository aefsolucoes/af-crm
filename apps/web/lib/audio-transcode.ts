/**
 * Converte um áudio gravado no navegador (webm/opus no Chrome, mp4/aac no
 * Safari, ogg/opus no Firefox — o MediaRecorder grava em formatos diferentes
 * por navegador) pro formato que o WhatsApp aceita de verdade: Ogg/Opus mono
 * 16kHz, o mesmo do áudio de voz nativo do WhatsApp. Sem isso, um áudio
 * gravado no Chrome (webm) é recusado pela API do WhatsApp — não é um bug
 * nosso, é o formato que o navegador entrega.
 *
 * Usa ffmpeg.wasm — carregado só na hora de gravar (nunca no carregamento
 * normal do Inbox). Testado ao vivo (Browser pane) até achar a combinação
 * que funciona de verdade:
 * - `ffmpeg.js` + `814.ffmpeg.js` (o "worker" interno da versão UMD, um
 *   chunk webpack próprio do pacote) ficam commitados em public/ffmpeg/ —
 *   são pequenos (~8KB os dois) — porque `new Worker(url)` do navegador
 *   NUNCA aceita um script de outra origem (nem com CORS liberado, nem como
 *   blob URL o chunk interno resolve certo) — só funciona same-origin.
 *   Confirmado ao vivo: direto do jsdelivr dá "cannot be accessed from
 *   origin"; como blob URL o worker sobe mas o require interno dele quebra
 *   ("Cannot find module 'blob:...'"). Só same-origin funcionou.
 * - O núcleo (ffmpeg-core.wasm, ~31MB) esse sim vem do jsdelivr via blob URL
 *   — não é carregado com `new Worker()`, é `importScripts`/`import()` de
 *   dentro do worker, que aceita origem cruzada normal. Pesado demais pra
 *   guardar no git pra sempre.
 */
import type { FFmpeg as FFmpegType } from '@ffmpeg/ffmpeg';

declare global {
  interface Window {
    FFmpegWASM?: { FFmpeg: new () => FFmpegType };
  }
}

const CORE_VERSION = '0.12.10';

function loadScriptOnce(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[data-src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') { resolve(); return; }
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error(`Falha ao carregar ${src}`)));
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.dataset.src = src;
    script.onload = () => { script.dataset.loaded = '1'; resolve(); };
    script.onerror = () => reject(new Error(`Falha ao carregar ${src}`));
    document.head.appendChild(script);
  });
}

let ffmpegPromise: Promise<FFmpegType> | null = null;

async function getFFmpeg(): Promise<FFmpegType> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      if (!window.FFmpegWASM) {
        await loadScriptOnce('/ffmpeg/ffmpeg.js');
      }
      if (!window.FFmpegWASM) throw new Error('ffmpeg.wasm não carregou (FFmpegWASM ausente)');
      const { toBlobURL } = await import('@ffmpeg/util');
      const ffmpeg = new window.FFmpegWASM.FFmpeg();
      const coreBase = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`;
      await ffmpeg.load({
        coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      return ffmpeg;
    })().catch((err) => {
      ffmpegPromise = null; // deixa tentar de novo na próxima gravação, em vez de ficar travado num erro
      throw err;
    });
  }
  return ffmpegPromise;
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('webm')) return 'webm';
  return 'bin';
}

/** Recebe o blob cru do MediaRecorder + o mimeType que ele reportou, devolve
 *  um Blob "audio/ogg" (Opus, mono, 16kHz) pronto pra mandar pro WhatsApp. */
export async function transcodeToWhatsAppOgg(blob: Blob, sourceMimeType: string): Promise<Blob> {
  const { fetchFile } = await import('@ffmpeg/util');
  const ffmpeg = await getFFmpeg();
  const ext = extensionFor(sourceMimeType);
  const inputName = `input.${ext}`;
  const outputName = 'output.ogg';
  await ffmpeg.writeFile(inputName, await fetchFile(blob));
  try {
    await ffmpeg.exec(['-i', inputName, '-c:a', 'libopus', '-b:a', '32k', '-ar', '16000', '-ac', '1', outputName]);
    const data = await ffmpeg.readFile(outputName);
    // O tipo de retorno do ffmpeg.wasm (Uint8Array<ArrayBufferLike>) não bate
    // exatamente com o que o Blob espera nessa versão do TS/lib DOM — o valor
    // em si é um Uint8Array normal em tempo de execução.
    return new Blob([data as unknown as BlobPart], { type: 'audio/ogg' });
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}
