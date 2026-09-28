/**
 * Transcrição de áudio de cliente (mensagem de voz do WhatsApp) — ElevenLabs
 * Scribe, mesma chave das ligações (call-recording.service.ts). Pedido do
 * Fabio 28/09: "a IA também transcreva os áudios e saiba interpretá-los".
 * Nunca lança: sem chave, erro ou demora demais → null (o áudio chega normal,
 * só sem transcrição).
 */
export async function transcribeVoiceNote(buffer: Buffer, mimeType: string): Promise<string | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key || !buffer?.length || buffer.length > 25 * 1024 * 1024) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const form = new FormData();
    form.append('model_id', 'scribe_v1');
    form.append('language_code', 'por');
    form.append('tag_audio_events', 'false');
    const ext = mimeType.includes('mpeg') ? 'mp3' : mimeType.includes('ogg') ? 'ogg' : mimeType.includes('webm') ? 'webm' : 'm4a';
    form.append('file', new Blob([buffer], { type: mimeType || 'audio/ogg' }), `audio.${ext}`);
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form, signal: ctrl.signal });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[Transcrição] falhou (${res.status}):`, JSON.stringify(data).slice(0, 200));
      return null;
    }
    const text = String(data.text || '').replace(/\s+/g, ' ').trim();
    return text || null;
  } catch (err: any) {
    console.error('[Transcrição] erro:', err?.name === 'AbortError' ? 'demorou demais' : err?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** "📎 audio-123.ogg — 🎤 texto" → "(áudio) texto" — como a IA lê um áudio
 *  transcrito no histórico. */
export function voiceNoteForAi(content: string): string {
  return content.replace(/^📎 audio-[^\s]+ — 🎤 /, '(áudio) ');
}
