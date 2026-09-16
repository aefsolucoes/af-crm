import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtemp, readFile, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ffmpegPath = require('ffmpeg-static') as string;

const execFileAsync = promisify(execFile);

/**
 * Converte um áudio gravado no navegador (webm/opus no Chrome, mp4/aac no
 * Safari, ogg/opus no Firefox — o MediaRecorder grava em formatos diferentes
 * por navegador) pro formato que o WhatsApp aceita de verdade pra voz: Ogg/
 * Opus mono 16kHz.
 *
 * Roda no SERVIDOR (ffmpeg real via ffmpeg-static), não no navegador. A
 * versão anterior usava ffmpeg.wasm no cliente (lib/audio-transcode.ts no
 * front, já removido) e às vezes "terminava" sem lançar erro nenhum, só que
 * com um arquivo inválido — a Meta recusava o envio com erro 131053
 * ("mimetype declarado não bate com o conteúdo real"), já dentro da
 * conversa com o cliente. Rodar server-side com um binário de ffmpeg de
 * verdade é muito mais confiável (testado localmente antes de subir: gera
 * um Ogg/Opus válido de verdade, verificável com `ffmpeg -i`) — e ainda
 * confere o resultado antes de devolver.
 */
export async function transcodeToOggOpus(buffer: Buffer, sourceMimeType: string): Promise<Buffer> {
  const ext = sourceMimeType.includes('mp4') ? 'mp4'
    : sourceMimeType.includes('ogg') ? 'ogg'
    : sourceMimeType.includes('webm') ? 'webm'
    : 'bin';

  const dir = await mkdtemp(path.join(tmpdir(), 'af-audio-'));
  const inputPath = path.join(dir, `input.${ext}`);
  const outputPath = path.join(dir, 'output.ogg');
  try {
    await writeFile(inputPath, buffer);
    await execFileAsync(ffmpegPath, [
      '-y', '-i', inputPath,
      '-c:a', 'libopus', '-b:a', '32k', '-ar', '16000', '-ac', '1',
      outputPath,
    ], { timeout: 30_000 });

    const out = await readFile(outputPath);
    // Um Ogg/Opus válido sempre tem pelo menos o cabeçalho do container —
    // arquivo vazio/quase vazio significa que algo deu errado mesmo sem o
    // ffmpeg lançar erro (não deveria acontecer com o binário real, mas o
    // mesmo pressuposto errado foi o que causou o incidente na versão wasm).
    if (!out || out.length < 200) throw new Error('ffmpeg gerou um arquivo vazio/inválido');
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
