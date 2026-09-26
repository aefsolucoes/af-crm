import api from '@/lib/api';

/**
 * Grava uma ligação da equipe feita/atendida pelo CRM — os DOIS lados
 * (microfone de quem está no CRM + áudio do cliente) misturados num arquivo
 * só — e, ao parar, manda pro servidor transcrever e resumir (vira nota no
 * card e material pra IA aprender o jeito da equipe). Nada fica salvo no
 * navegador. Se o navegador não suportar, simplesmente não grava.
 */
export function startCallRecording(local: MediaStream, remote: MediaStream, waCallId: string): () => void {
  try {
    if (typeof MediaRecorder === 'undefined') return () => {};
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = new Ctx();
    ctx.resume().catch(() => {});
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(local).connect(dest);
    ctx.createMediaStreamSource(remote).connect(dest);
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const recorder = new MediaRecorder(dest.stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 });
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      ctx.close().catch(() => {});
      // Ligação de poucos segundos (caiu, ninguém falou) não vale transcrever.
      if (Date.now() - startedAt < 8000 || !chunks.length) return;
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      api.post(`/api/calls/${encodeURIComponent(waCallId)}/recording`, { audioBase64: base64, mimeType: blob.type })
        .catch((err) => console.warn('[Gravação] envio falhou:', err?.message));
    };
    recorder.start(1000);
    return () => { if (recorder.state !== 'inactive') recorder.stop(); };
  } catch (err) {
    console.warn('[Gravação] não deu pra gravar esta ligação:', err);
    return () => {};
  }
}
