import { create } from 'zustand';
import api from '@/lib/api';
import { toast } from '@/components/ui/toast';
import { waitForIceGatheringComplete } from '@/lib/webrtc';

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

function cleanup() {
  pc?.close();
  pc = null;
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  if (audioEl) audioEl.srcObject = null;
  waCallId = null;
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
            () => console.log('[Calling] outbound: audio.play() ok'),
            (err) => console.error('[Calling] outbound: audio.play() falhou:', err)
          );
        }
      };
      conn.oniceconnectionstatechange = () => console.log('[Calling] outbound iceConnectionState:', conn.iceConnectionState);
      conn.onicegatheringstatechange = () => console.log('[Calling] outbound iceGatheringState (offer):', conn.iceGatheringState);
      conn.onconnectionstatechange = () => {
        console.log('[Calling] outbound connectionState:', conn.connectionState);
        if (conn.connectionState === 'connected') {
          set({ connectedAt: Date.now(), stage: 'connected' });
        }
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
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      console.log('[Calling] outbound: setRemoteDescription(answer) ok');
    } catch (err) {
      console.error('[Calling] Falha ao aplicar resposta SDP:', err);
    }
  },

  handleCallEnded: (endedWaCallId) => {
    if (endedWaCallId !== waCallId) return;
    cleanup();
    set({ stage: 'idle', leadId: null, leadName: null });
  },
}));
