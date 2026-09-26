import { create } from 'zustand';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { waitForIceGatheringComplete } from '@/lib/webrtc';
import { startRingbackTone } from '@/lib/sounds';

export type OutboundCallStage = 'idle' | 'checking' | 'confirm' | 'connecting' | 'connected';

/** Estado de WebRTC (RTCPeerConnection, MediaStream, o waCallId em curso) —
 *  fica em variáveis de módulo, não dentro do Zustand: nunca é lido de forma
 *  reativa (só usado dentro das próprias ações abaixo), então não precisa
 *  disparar re-render — é só a versão "singleton global" do useRef que essa
 *  lógica tinha antes, quando morava dentro do ChatWindow. */
let pc: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
let waCallId: string | null = null;
let audioEl: HTMLAudioElement | null = null;
// Toque de "chamando" (tuuu... tuuu...) enquanto o cliente ainda não
// atendeu -- achado real do usuário: sem esse som, ligar parecia
// travado/mudo, sem confirmação nenhuma de que a chamada estava tocando do
// outro lado de verdade.
let stopRingback: (() => void) | null = null;
// Diagnóstico (26/09, "tá com delay e não escutamos quem atende"): durante a
// ligação manda pro servidor, a cada 5s, se está chegando áudio do cliente,
// o atraso da rede e se o <audio> está tocando.
let diagTimer: ReturnType<typeof setInterval> | null = null;

async function sendDiag(tag: string) {
  if (!pc || !waCallId) return;
  try {
    const stats = await pc.getStats();
    const out: Record<string, unknown> = { tag, ice: pc.iceConnectionState, conn: pc.connectionState };
    const byId = new Map<string, any>();
    stats.forEach((r: any) => byId.set(r.id, r));
    stats.forEach((r: any) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        out.inbound = { packets: r.packetsReceived, lost: r.packetsLost, jitterMs: Math.round((r.jitter || 0) * 1000), level: r.audioLevel, energy: r.totalAudioEnergy, jbDelayMs: r.jitterBufferEmittedCount ? Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) : undefined };
      }
      if (r.type === 'outbound-rtp' && r.kind === 'audio') out.outbound = { packets: r.packetsSent };
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

function cleanup() {
  if (diagTimer) { clearInterval(diagTimer); diagTimer = null; }
  pc?.close();
  pc = null;
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  if (audioEl) audioEl.srcObject = null;
  waCallId = null;
  stopRingback?.();
  stopRingback = null;
}

interface OutboundCallState {
  stage: OutboundCallStage;
  leadId: string | null;
  /** Capturado uma única vez, quando a ligação começa a ser preparada —
   *  ACHADO REAL (2026-09-24): antes disso vinha direto da conversa
   *  aberta no momento (prop `leadName` do ChatWindow), então trocar de
   *  conversa NO MEIO de uma ligação trocava o nome mostrado na barra
   *  fixa, mesmo a ligação continuando com o cliente original. */
  leadName: string | null;
  targetPhone: string | null;
  muted: boolean;
  connectedAt: number;
  registerAudioEl: (el: HTMLAudioElement | null) => void;
  checkAndCall: (leadId: string, leadName: string) => Promise<void>;
  confirmCall: () => Promise<void>;
  dismiss: () => void;
  hangup: () => Promise<void>;
  toggleMute: () => void;
  handleCallAnswered: (waCallId: string, sdp: string) => Promise<void>;
  handleCallAccepted: (waCallId: string) => void;
  handleCallRinging: (waCallId: string) => void;
  handleCallEnded: (endedWaCallId: string) => void;
}

export const useOutboundCallStore = create<OutboundCallState>((set, get) => ({
  stage: 'idle',
  leadId: null,
  leadName: null,
  targetPhone: null,
  muted: false,
  connectedAt: 0,

  registerAudioEl: (el) => { audioEl = el; },

  // Botão único (pedido real do usuário 2026-09-24): sem popup intermediário
  // de "pedir permissão" -- o botão "Ligar" já nasce verde/cinza (cor vem de
  // uma checagem própria no ChatWindow, ao abrir a conversa) e, se ainda não
  // tem permissão, clicar já PEDE a permissão na hora, sem diálogo no meio.
  checkAndCall: async (leadId, leadName) => {
    if (get().stage !== 'idle') return; // já tem uma ligação em curso (qualquer conversa)
    set({ stage: 'checking', leadId, leadName });
    try {
      const { data } = await api.get('/api/calls/permission-state', { params: { leadId } });
      if (data.permitted) {
        // Ainda mostra o popup de confirmação (estilo WhatsApp: "Ligar pra
        // Fulano (número)?") antes de discar de verdade -- só o pedido de
        // permissão que deixou de ter uma tela própria.
        set({ targetPhone: data.phone || null, stage: 'confirm' });
        return;
      }
      // Botão âmbar ("Aguardando"): já tem pedido recente em aberto -- o
      // clique só re-verifica. Mandar de novo batia no limite da Meta
      // (1/dia, 2/semana) e mostrava o erro #138009 cru pro usuário.
      if (data.canRequest === false) {
        toast('Pedido de permissão já enviado — ainda aguardando o cliente aceitar.', 'warning');
        set({ stage: 'idle', leadId: null, leadName: null });
        return;
      }
      try {
        await api.post('/api/calls/permission-request', { leadId });
        toast('Esse cliente ainda não autorizou ligação — pedido de permissão enviado pra ele.', 'success');
      } catch (err: any) {
        toast(err?.response?.data?.error || 'Não foi possível pedir permissão pra ligar', 'error');
      }
      set({ stage: 'idle', leadId: null, leadName: null });
    } catch {
      set({ stage: 'idle', leadId: null, leadName: null });
      toast('Não foi possível verificar a permissão de ligação', 'error');
    }
  },

  dismiss: () => set({ stage: 'idle', leadId: null, leadName: null, targetPhone: null }),

  confirmCall: async () => {
    const { leadId } = get();
    if (!leadId) return;
    set({ stage: 'connecting' });
    // O "tum tum" NÃO começa mais aqui: só quando a Meta avisa que o celular
    // do cliente está tocando (handleCallRinging) — antes tocava 3-5s antes.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStream = stream;

      const conn = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pc = conn;
      stream.getTracks().forEach((t) => conn.addTrack(t, stream));
      console.log('[Calling] outbound: microfone ok, tracks locais:', stream.getAudioTracks().map((t) => ({ label: t.label, enabled: t.enabled, muted: t.muted, readyState: t.readyState })));
      conn.ontrack = (event) => {
        console.log('[Calling] outbound ontrack: stream remoto recebido', event.streams[0]?.id, event.track.kind, event.track.readyState, event.track.muted);
        if (audioEl) {
          audioEl.srcObject = event.streams[0];
          audioEl.play().then(
            () => { console.log('[Calling] outbound: audio.play() ok'); sendDiag('play-ok'); },
            (err) => { console.error('[Calling] outbound: audio.play() falhou:', err); sendDiag(`play-falhou: ${err?.name || err}`); }
          );
        }
      };
      conn.oniceconnectionstatechange = () => console.log('[Calling] outbound iceConnectionState:', conn.iceConnectionState);
      conn.onicegatheringstatechange = () => console.log('[Calling] outbound iceGatheringState (offer):', conn.iceGatheringState);
      conn.onconnectionstatechange = () => {
        // 'connected' aqui NÃO quer dizer que o cliente atendeu: o áudio se
        // conecta já enquanto o celular dele toca. Quem marca "atendeu" é o
        // status ACCEPTED da Meta (handleCallAccepted).
        console.log('[Calling] outbound connectionState:', conn.connectionState);
        if (conn.connectionState === 'failed' || conn.connectionState === 'closed') {
          const endedId = waCallId;
          cleanup();
          set({ stage: 'idle', leadId: null, leadName: null });
          if (endedId) api.post(`/api/calls/${endedId}/terminate`).catch(() => {});
        }
      };

      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      await waitForIceGatheringComplete(conn);
      const sdp = conn.localDescription?.sdp || offer.sdp;

      const { data } = await api.post('/api/calls/outbound', { leadId, sdpOffer: sdp });
      if (!data.ok) {
        cleanup();
        set({ stage: 'idle', leadId: null, leadName: null });
        // Raro (janela entre checar e ligar de verdade) -- a permissão que
        // parecia concedida não valeu mais na hora H. Sem popup: já refaz o
        // pedido sozinho, igual o botão "Ligar" cinza faria.
        if (data.needsPermission) {
          api.post('/api/calls/permission-request', { leadId }).catch(() => {});
          toast('A permissão pra ligar expirou — pedido novo enviado pro cliente.', 'warning');
        } else {
          toast('Não foi possível ligar', 'error');
        }
        return;
      }
      waCallId = data.waCallId;
      // Reserva: se o aviso de "tocando" não chegar em 6s, toca mesmo assim
      // (melhor que ficar em silêncio sem saber se está chamando).
      setTimeout(() => { if (waCallId === data.waCallId && get().stage === 'connecting' && !stopRingback) stopRingback = startRingbackTone(); }, 6000);
      if (diagTimer) clearInterval(diagTimer);
      diagTimer = setInterval(() => sendDiag('tick'), 5000);
    } catch (err) {
      console.error('[Calling] Falha ao ligar:', err);
      cleanup();
      set({ stage: 'idle', leadId: null, leadName: null });
      toast('Não foi possível acessar o microfone', 'error');
    }
  },

  hangup: async () => {
    const endedId = waCallId;
    cleanup();
    set({ stage: 'idle', leadId: null, leadName: null });
    if (endedId) {
      try { await api.post(`/api/calls/${endedId}/terminate`); } catch { /* melhor esforço */ }
    }
  },

  toggleMute: () => {
    if (!localStream) return;
    const next = !get().muted;
    localStream.getAudioTracks().forEach((t) => { t.enabled = !next; });
    set({ muted: next });
  },

  handleCallAnswered: async (answeredWaCallId, sdp) => {
    console.log('[Calling] outbound: call_answered recebido do socket', answeredWaCallId, 'esperado:', waCallId, 'sdp bytes:', sdp?.length);
    if (answeredWaCallId !== waCallId || !pc) {
      console.warn('[Calling] outbound: call_answered ignorado (waCallId não bate ou sem PC ativo)');
      return;
    }
    // Esse SDP chega quando o celular do cliente COMEÇA A TOCAR (achado
    // real 2026-09-25: parar o "tuuu" e ligar o cronômetro aqui fazia os
    // dois acontecerem antes do cliente atender). Só prepara o áudio; o
    // "atendeu" é o status ACCEPTED (handleCallAccepted).
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      console.log('[Calling] outbound: setRemoteDescription(answer) ok');
    } catch (err) {
      console.error('[Calling] Falha ao aplicar resposta SDP:', err);
    }
  },

  handleCallRinging: (ringingWaCallId) => {
    // Pode chegar um instante antes da resposta do POST (waCallId ainda
    // vazio) — como só existe uma ligação de saída por vez, vale o estágio.
    if (get().stage !== 'connecting' || (waCallId && ringingWaCallId !== waCallId) || stopRingback) return;
    stopRingback = startRingbackTone();
  },

  handleCallAccepted: (acceptedWaCallId) => {
    if (acceptedWaCallId !== waCallId) return;
    stopRingback?.();
    stopRingback = null;
    set({ connectedAt: Date.now(), stage: 'connected' });
  },

  handleCallEnded: (endedWaCallId) => {
    if (endedWaCallId !== waCallId) return;
    cleanup();
    set({ stage: 'idle', leadId: null, leadName: null });
  },
}));
