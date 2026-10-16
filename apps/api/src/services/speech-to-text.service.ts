/**
 * Transcrição de áudio de cliente (mensagem de voz do WhatsApp) — ElevenLabs
 * Scribe, mesma chave das ligações (call-recording.service.ts). Pedido do
 * Fabio 28/09: "a IA também transcreva os áudios e saiba interpretá-los".
 * Nunca lança: sem chave, erro ou demora demais → null (o áudio chega normal,
 * só sem transcrição).
 */
let elevenSemCreditoAte = 0;

/** ElevenLabs primeiro; se não tem chave, deu erro ou acabou o crédito (16/10: plano gratuito estourou), a RESERVA é o Whisper rodando no próprio servidor (local-whisper.service). */
export async function transcribeVoiceNote(buffer: Buffer, mimeType: string): Promise<string | null> {
  const viaEleven = await transcribeElevenLabs(buffer, mimeType);
  if (viaEleven) return viaEleven;
  try {
    const { transcribeLocally } = require('./local-whisper.service') as typeof import('./local-whisper.service');
    return await transcribeLocally(buffer, mimeType);
  } catch { return null; }
}

async function transcribeElevenLabs(buffer: Buffer, mimeType: string): Promise<string | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key || !buffer?.length || buffer.length > 25 * 1024 * 1024) return null;
  if (Date.now() < elevenSemCreditoAte) return null; // crédito acabou há pouco: nem tenta (1 h)
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
      if (/quota|credit|exceeded|limit/i.test(JSON.stringify(data)) || res.status === 401 || res.status === 429) elevenSemCreditoAte = Date.now() + 3_600_000;
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

// ─── Áudios que ficaram sem texto (crédito do ElevenLabs acabou, 16/10): relê e transcreve, um por vez, só dos últimos 3 dias ───
const tentados = new Set<string>();
let reprocessando = false;
export async function backfillVoiceTranscripts(): Promise<void> {
  if (reprocessando) return;
  reprocessando = true;
  try {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const prisma = (backfillPrisma ||= new PrismaClient());
    const msgs = await prisma.message.findMany({
      where: { direction: 'INBOUND', channel: 'WHATSAPP', createdAt: { gte: new Date(Date.now() - 3 * 86_400_000) }, content: { startsWith: '📎 audio-' }, NOT: { content: { contains: ' — 🎤 ' } } },
      orderBy: { createdAt: 'desc' }, take: 30,
      select: { id: true, content: true, lead: { select: { accountId: true } }, attachments: { select: { mimeType: true, driveFileId: true, data: true } } },
    });
    let feitos = 0;
    for (const m of msgs) {
      if (feitos >= 2) break; // poucos por rodada: o servidor continua atendendo
      if (tentados.has(m.id)) continue;
      tentados.add(m.id);
      const att = m.attachments[0];
      if (!att || !/ogg|opus|audio/i.test(att.mimeType || '')) continue;
      let buf: Buffer | null = att.data && att.data.length ? Buffer.from(att.data) : null;
      if (!buf && att.driveFileId) {
        try { const { downloadDriveFile } = require('./google.service') as typeof import('./google.service'); buf = Buffer.from(await downloadDriveFile(m.lead.accountId, att.driveFileId, att.mimeType) as any); } catch { buf = null; }
      }
      if (!buf?.length) continue;
      const txt = await transcribeVoiceNote(buf, att.mimeType);
      if (!txt) continue;
      await prisma.message.update({ where: { id: m.id }, data: { content: `${m.content.trim()} — 🎤 ${txt}` } });
      feitos++;
      console.log(`[Transcrição] áudio antigo transcrito (${txt.length} caracteres)`);
    }
  } catch (e: any) {
    console.error('[Transcrição] reprocessar áudios:', e?.message);
  } finally {
    reprocessando = false;
  }
}
let backfillPrisma: import('@prisma/client').PrismaClient | null = null;
