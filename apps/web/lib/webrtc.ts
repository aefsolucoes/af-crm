import api from './api';

/** Espera a coleta de candidatos ICE terminar antes de usar o SDP local —
 *  sem isso, o SDP mandado pra Meta (pre-accept/accept/connect) não tem
 *  NENHUM candidato ainda (createAnswer()/createOffer() + setLocalDescription()
 *  retornam antes da coleta assíncrona terminar), a Meta não acha como
 *  alcançar o navegador e a chamada nunca conecta de verdade. Usado pelos
 *  dois lados (atender uma ligação recebida e fazer uma ligação) — mesma
 *  exigência da Meta nos dois casos. Timeout de segurança: em redes que
 *  nunca fecham a coleta (raro), segue com o que já foi juntado em vez de
 *  travar pra sempre. */
export function waitForIceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', check);
      pc.removeEventListener('icecandidate', onCandidate);
      resolve();
    };
    const check = () => {
      console.log('[Calling] iceGatheringState:', pc.iceGatheringState);
      if (pc.iceGatheringState === 'complete') finish();
    };
    // Já tendo o endereço público (candidato "srflx" do STUN), não precisa
    // esperar o resto: a Meta conecta com ele (e descobre o caminho na hora,
    // como se viu no diagnóstico — "prflx"). Antes esperava até 4s aqui, o
    // que atrasava o celular começar a tocar.
    const onCandidate = (e: RTCPeerConnectionIceEvent) => {
      if (e.candidate && / typ srflx /.test(` ${e.candidate.candidate} `)) setTimeout(finish, 250);
    };
    pc.addEventListener('icegatheringstatechange', check);
    pc.addEventListener('icecandidate', onCandidate);
    setTimeout(finish, 2000);
  });
}

/** Stream do cliente pro <audio>: a Meta às vezes manda a faixa sem "stream" (event.streams vazio) — aí o <audio> ficava sem nada e a ligação muda. */
export function remoteStreamFrom(event: RTCTrackEvent): MediaStream {
  return event.streams[0] || new MediaStream([event.track]);
}

/** Diagnóstico da ligação (26/09, "tá com delay e não escutamos quem atende"; 06/11 também na RECEBIDA, "atendeu e ficou mudo"): manda pro
 *  servidor se está chegando áudio do cliente, se o nosso microfone está saindo, o atraso da rede e se o <audio> está tocando. Só loga
 *  ([Calling][diag] no Railway) — nunca atrapalha a ligação. */
export async function sendCallDiag(pc: RTCPeerConnection | null, waCallId: string | null, audioEl: HTMLAudioElement | null, tag: string, dir: 'in' | 'out' = 'out'): Promise<void> {
  if (!pc || !waCallId) return;
  try {
    const stats = await pc.getStats();
    const out: Record<string, unknown> = { tag, dir, ice: pc.iceConnectionState, conn: pc.connectionState };
    const byId = new Map<string, any>();
    stats.forEach((r: any) => byId.set(r.id, r));
    stats.forEach((r: any) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        out.inbound = { packets: r.packetsReceived, lost: r.packetsLost, jitterMs: Math.round((r.jitter || 0) * 1000), level: r.audioLevel, energy: r.totalAudioEnergy, jbDelayMs: r.jitterBufferEmittedCount ? Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) : undefined };
      }
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.outbound = { packets: r.packetsSent };
      if (r.type === 'media-source' && r.kind === 'audio') out.mic = { level: r.audioLevel, energy: r.totalAudioEnergy };
      if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') {
        out.rttMs = r.currentRoundTripTime !== undefined ? Math.round(r.currentRoundTripTime * 1000) : undefined;
        out.local = byId.get(r.localCandidateId)?.candidateType;
        out.remote = byId.get(r.remoteCandidateId)?.candidateType;
        out.protocol = byId.get(r.localCandidateId)?.protocol;
      }
    });
    if (audioEl) out.audio = { paused: audioEl.paused, muted: audioEl.muted, volume: audioEl.volume, hasStream: !!audioEl.srcObject, readyState: audioEl.readyState };
    api.post(`/api/calls/${encodeURIComponent(waCallId)}/diag`, out).catch(() => {});
  } catch { /* diagnóstico nunca atrapalha a ligação */ }
}
