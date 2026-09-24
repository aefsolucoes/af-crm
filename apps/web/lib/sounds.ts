// Tons sintetizados via Web Audio API (sem arquivo externo) — compartilhado
// entre a notificação de mensagem nova (layout.tsx), a prévia na tela de
// Configurações → Sons, e o toque de chamada recebida (incoming-call-ringer,
// que toca em loop em vez de uma vez só). Um catálogo único evita 3 cópias
// da mesma lógica de osciladores divergindo aos poucos.

export type SoundKey = 'whatsapp' | 'ding' | 'pop' | 'chime' | 'bell' | 'soft' | 'alert' | 'none';

export const SOUND_OPTIONS: { key: SoundKey; label: string; emoji: string; desc: string }[] = [
  { key: 'whatsapp', label: 'WhatsApp', emoji: '💬', desc: 'Três dings descendentes' },
  { key: 'ding',     label: 'Ding',     emoji: '🔔', desc: 'Um toque limpo e suave' },
  { key: 'pop',      label: 'Pop',      emoji: '🫧', desc: 'Som curto estilo bolha' },
  { key: 'chime',    label: 'Chime',    emoji: '🎵', desc: 'Dois tons harmônicos' },
  { key: 'bell',     label: 'Sino',     emoji: '🔕', desc: 'Sino metálico curto' },
  { key: 'soft',     label: 'Suave',    emoji: '🌙', desc: 'Tom suave e discreto' },
  { key: 'alert',    label: 'Alerta',   emoji: '⚡', desc: 'Toque de atenção' },
  { key: 'none',     label: 'Sem som',  emoji: '🔇', desc: 'Desativar som' },
];

/** Toca um dos padrões de tom no AudioContext dado — não fecha o contexto
 *  (quem chama decide: um tiro só fecha logo depois, um toque em loop
 *  mantém o mesmo contexto entre repetições). */
export function playTone(key: SoundKey, ctx: AudioContext) {
  if (key === 'none') return;

  const tone = (freq: number, start: number, dur: number, vol: number, type: OscillatorType = 'sine') => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
    gain.gain.setValueAtTime(vol, ctx.currentTime + start);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
    osc.start(ctx.currentTime + start);
    osc.stop(ctx.currentTime + start + dur);
  };

  if (key === 'whatsapp') { tone(1200, 0, 0.15, 0.4); tone(1000, 0.18, 0.15, 0.3); tone(800, 0.36, 0.20, 0.2); }
  else if (key === 'ding')  { tone(880, 0, 0.5, 0.4); }
  else if (key === 'pop')   { tone(600, 0, 0.04, 0.5, 'square'); tone(400, 0.04, 0.08, 0.3); }
  else if (key === 'chime') { tone(523, 0, 0.3, 0.35); tone(659, 0.15, 0.3, 0.30); tone(784, 0.30, 0.4, 0.25); }
  else if (key === 'bell')  { tone(987, 0, 0.05, 0.5, 'square'); tone(1174, 0, 0.40, 0.3); tone(987, 0.05, 0.35, 0.2); }
  else if (key === 'soft')  { tone(440, 0, 0.6, 0.2); tone(550, 0.1, 0.5, 0.15); }
  else if (key === 'alert') { tone(1000, 0, 0.10, 0.5, 'square'); tone(1200, 0.12, 0.10, 0.5, 'square'); tone(1000, 0.24, 0.10, 0.4, 'square'); }
}

/** Toca uma vez e fecha o contexto sozinho — uso normal (notificação de
 *  mensagem, prévia "▶ Ouvir" na tela de Configurações). */
export function playSoundOnce(key: SoundKey) {
  if (key === 'none') return;
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    playTone(key, ctx);
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch {
    // fallback silencioso
  }
}
