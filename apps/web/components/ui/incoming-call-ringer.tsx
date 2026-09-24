'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Phone, PhoneOff } from 'lucide-react';
import { getSocket } from '@/lib/socket';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth.store';
import { ActiveCallBar } from '@/components/ui/active-call-bar';
import { waitForIceGatheringComplete } from '@/lib/webrtc';
import { playTone, SoundKey } from '@/lib/sounds';

interface IncomingCallEvent {
  callId: string;
  waCallId: string;
  leadId: string | null;
  leadName: string;
  contactPhone: string;
  sdp: string;
}

type Stage = 'ringing' | 'connecting' | 'connected';

/** Ringer global de chamadas do WhatsApp — mesmo padrão do
 *  <ContractingLeadAlert />: componente autocontido, montado uma vez no
 *  layout, próprio listener de socket, próprio estado de fila. Toca pra
 *  conta inteira (time pequeno, sem fila/roteamento — quem atender primeiro
 *  atende); quando alguém atende, os outros param de tocar sozinhos.
 *
 *  Fase 1 (só chamada recebida) — não tem fluxo de ligar pro cliente ainda. */
export function IncomingCallRinger() {
  const router = useRouter();
  const myUserId = useAuthStore((s) => s.user?.id);
  const [queue, setQueue] = useState<IncomingCallEvent[]>([]);
  const [active, setActive] = useState<{ call: IncomingCallEvent; stage: Stage; muted: boolean; connectedAt: number } | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const acceptSentRef = useRef(false);
  const ringToneRef = useRef<{ ctx: AudioContext; stop: () => void } | null>(null);

  const current = queue[0] || null;

  const stopRingtone = useCallback(() => {
    if (ringToneRef.current) {
      ringToneRef.current.stop();
      ringToneRef.current.ctx.close().catch(() => {});
      ringToneRef.current = null;
    }
  }, []);

  const startRingtone = useCallback(() => {
    stopRingtone();
    try {
      const key = (localStorage.getItem('af_call_ringtone') as SoundKey) || 'whatsapp';
      if (key === 'none') return;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      let stopped = false;
      const playCycle = () => { if (!stopped) playTone(key, ctx); };
      playCycle();
      const id = setInterval(playCycle, 1600);
      ringToneRef.current = { ctx, stop: () => { stopped = true; clearInterval(id); } };
    } catch {
      // fallback silencioso
    }
  }, [stopRingtone]);

  useEffect(() => {
    if (current && !active) startRingtone();
    else stopRingtone();
    return stopRingtone;
  }, [current, active, startRingtone, stopRingtone]);

  const cleanupPeerConnection = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (audioElRef.current) audioElRef.current.srcObject = null;
    acceptSentRef.current = false;
  }, []);

  const endActiveCall = useCallback((waCallId: string) => {
    cleanupPeerConnection();
    setActive((a) => (a?.call.waCallId === waCallId ? null : a));
  }, [cleanupPeerConnection]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();

    function onIncomingCall(data: IncomingCallEvent) {
      if (!data?.waCallId) return;
      setQueue((q) => (q.some((x) => x.waCallId === data.waCallId) || active?.call.waCallId === data.waCallId ? q : [...q, data]));
    }

    function onCallAnsweredBy({ waCallId, byUserId }: { waCallId: string; byUserId?: string }) {
      if (byUserId === myUserId) return; // fomos nós — já tratado no fluxo de Atender
      setQueue((q) => q.filter((c) => c.waCallId !== waCallId));
    }

    function onCallEnded({ waCallId }: { waCallId: string }) {
      setQueue((q) => q.filter((c) => c.waCallId !== waCallId));
      endActiveCall(waCallId);
    }

    socket.on('incoming_call', onIncomingCall);
    socket.on('call_answered_by', onCallAnsweredBy);
    socket.on('call_ended', onCallEnded);
    return () => {
      socket.off('incoming_call', onIncomingCall);
      socket.off('call_answered_by', onCallAnsweredBy);
      socket.off('call_ended', onCallEnded);
    };
  }, [myUserId, active, endActiveCall]);

  const dismissCurrent = useCallback(() => setQueue((q) => q.slice(1)), []);

  const reject = useCallback(async () => {
    if (!current) return;
    const call = current;
    dismissCurrent();
    try { await api.post(`/api/calls/${call.waCallId}/reject`); } catch { /* melhor esforço */ }
  }, [current, dismissCurrent]);

  const answer = useCallback(async () => {
    if (!current) return;
    const call = current;
    dismissCurrent();
    setActive({ call, stage: 'connecting', muted: false, connectedAt: 0 });

    try {
      const localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = localStream;

      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pcRef.current = pc;

      localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      pc.ontrack = (event) => {
        if (audioElRef.current) audioElRef.current.srcObject = event.streams[0];
      };
      pc.oniceconnectionstatechange = () => console.log('[Calling] iceConnectionState:', pc.iceConnectionState);
      pc.onconnectionstatechange = () => {
        console.log('[Calling] connectionState:', pc.connectionState);
        if (pc.connectionState === 'connected' && !acceptSentRef.current) {
          acceptSentRef.current = true;
          api.post(`/api/calls/${call.waCallId}/accept`, { sdpAnswer: pc.localDescription?.sdp })
            .then(() => setActive((a) => (a?.call.waCallId === call.waCallId ? { ...a, stage: 'connected', connectedAt: Date.now() } : a)))
            .catch((err) => { console.error('[Calling] Falha ao confirmar accept:', err); endActiveCall(call.waCallId); });
        }
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          endActiveCall(call.waCallId);
          api.post(`/api/calls/${call.waCallId}/terminate`).catch(() => {});
        }
      };

      await pc.setRemoteDescription({ type: 'offer', sdp: call.sdp });
      const answerSdp = await pc.createAnswer();
      await pc.setLocalDescription(answerSdp);
      // Espera juntar TODOS os candidatos ICE antes de mandar o SDP pra Meta
      // — ver comentário em waitForIceGatheringComplete.
      await waitForIceGatheringComplete(pc);
      const localSdp = pc.localDescription?.sdp || answerSdp.sdp;

      await api.post(`/api/calls/${call.waCallId}/pre-accept`, { sdpAnswer: localSdp });
    } catch (err) {
      console.error('[Calling] Falha ao atender:', err);
      cleanupPeerConnection();
      setActive(null);
      try { await api.post(`/api/calls/${call.waCallId}/reject`); } catch { /* melhor esforço */ }
    }
  }, [current, dismissCurrent, cleanupPeerConnection, endActiveCall]);

  const hangup = useCallback(async () => {
    if (!active) return;
    const waCallId = active.call.waCallId;
    endActiveCall(waCallId);
    try { await api.post(`/api/calls/${waCallId}/terminate`); } catch { /* melhor esforço */ }
  }, [active, endActiveCall]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) return;
    const next = !active?.muted;
    localStreamRef.current.getAudioTracks().forEach((t) => { t.enabled = !next; });
    setActive((a) => (a ? { ...a, muted: next } : a));
  }, [active]);

  const goToLead = useCallback(() => {
    const leadId = current?.leadId || active?.call.leadId;
    if (leadId) router.push(`/inbox?leadId=${leadId}`);
  }, [current, active, router]);

  return (
    <>
      <audio ref={audioElRef} autoPlay />

      {current && !active && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-0 md:p-4 bg-black/50">
          <div className="app-column-surface rounded-none md:rounded-2xl shadow-2xl w-full h-full md:w-80 md:h-auto flex flex-col items-center justify-center gap-4 p-8">
            <div className="w-20 h-20 rounded-full bg-[#3b82f6]/15 flex items-center justify-center animate-pulse">
              <Phone size={32} className="text-[#3b82f6]" />
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold">{current.leadName}</p>
              <p className="text-sm text-slate-400">Ligação de WhatsApp recebida</p>
              {queue.length > 1 && <p className="text-xs text-slate-400 mt-1">+{queue.length - 1} outra(s) na fila</p>}
            </div>
            <button onClick={goToLead} className="text-xs text-[#3b82f6] hover:underline">Ver conversa</button>
            <div className="flex items-center gap-6 mt-2">
              <button
                onClick={reject}
                title="Recusar"
                className="w-14 h-14 rounded-full bg-red-600 hover:bg-red-700 text-white flex items-center justify-center shadow-lg transition-colors"
              >
                <PhoneOff size={22} />
              </button>
              <button
                onClick={answer}
                title="Atender"
                className="w-14 h-14 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center shadow-lg transition-colors"
              >
                <Phone size={22} />
              </button>
            </div>
          </div>
        </div>
      )}

      {active && (
        <ActiveCallBar
          callerName={active.call.leadName}
          connectedAt={active.connectedAt}
          connecting={active.stage === 'connecting'}
          muted={active.muted}
          onToggleMute={toggleMute}
          onHangup={hangup}
        />
      )}
    </>
  );
}
