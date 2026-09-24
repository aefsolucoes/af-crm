'use client';
import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, PhoneOff, Volume2, Ear } from 'lucide-react';

/** Troca a saída de áudio entre viva-voz (alto-falante) e fone de ouvido
 *  (auricular) -- só existe em celular (o botão que chama isso é `md:hidden`
 *  no JSX abaixo). Achado real do usuário: em celular a ligação SEMPRE saía
 *  no viva-voz, sem opção de usar o fone/auricular como uma ligação normal.
 *
 *  Não existe uma API padrão da Web pra "forçar auricular" -- só dá pra
 *  ESCOLHER entre os dispositivos de saída de áudio que o navegador expõe
 *  (HTMLMediaElement.setSinkId, ainda sem suporte no Safari/iOS -- funciona
 *  em Chrome/Android). Por isso: se o navegador não suporta, o botão nem
 *  aparece (feature-detect); se suporta mas os rótulos dos dispositivos não
 *  derem pra identificar qual é qual, tenta o 2º dispositivo da lista como
 *  aproximação (normalmente o auricular vem depois do alto-falante). */
async function pickAudioOutputDeviceId(wantSpeaker: boolean): Promise<string | null> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((d) => d.kind === 'audiooutput');
    if (!outputs.length) return null;
    const bySpeakerLabel = outputs.find((d) => /speaker|alto.?falante|viva.?voz/i.test(d.label));
    const byEarpieceLabel = outputs.find((d) => /earpiece|receiver|fone|auricular/i.test(d.label));
    if (wantSpeaker) return bySpeakerLabel?.deviceId ?? outputs[0]?.deviceId ?? null;
    return byEarpieceLabel?.deviceId ?? outputs[1]?.deviceId ?? outputs[0]?.deviceId ?? null;
  } catch (err) {
    console.error('[Calling] Falha ao listar saídas de áudio:', err);
    return null;
  }
}

/** Barra de ligação em andamento — puramente visual, sem lógica de WebRTC
 *  (exceto o botão de viva-voz/fone, que mexe direto no elemento <audio>
 *  via ref, já que a saída de áudio é uma propriedade do próprio elemento).
 *  Usada pelo ringer (chamada recebida) e pelo fluxo de ligação feita pelo
 *  CRM (mesma UI pros dois casos). Mostrada tanto em "conectando" (tocando/
 *  negociando) quanto em "conectado" -- silenciar e desligar precisam estar
 *  disponíveis o tempo todo, não só depois que a Meta confirma o estado
 *  "connected" do RTCPeerConnection (esse evento pode demorar ou nem bater
 *  exatamente com o áudio já estar fluindo de verdade). */
export function ActiveCallBar({
  callerName,
  connectedAt,
  connecting,
  muted,
  onToggleMute,
  onHangup,
  audioElRef,
}: {
  callerName: string;
  connectedAt: number; // Date.now() de quando conectou (ignorado se connecting)
  connecting?: boolean;
  muted: boolean;
  onToggleMute: () => void;
  onHangup: () => void;
  /** Elemento <audio> de verdade tocando a ligação — só usado pelo botão de
   *  viva-voz/fone (celular). Sem isso, o botão não aparece. */
  audioElRef?: React.RefObject<HTMLAudioElement | null>;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [onSpeaker, setOnSpeaker] = useState(true); // viva-voz é o padrão atual do navegador
  const supportsSinkId = typeof window !== 'undefined' && !!(HTMLMediaElement.prototype as any).setSinkId;
  async function toggleSpeaker() {
    const audioEl = audioElRef?.current as any;
    if (!audioEl?.setSinkId) return;
    const next = !onSpeaker;
    const deviceId = await pickAudioOutputDeviceId(next);
    if (deviceId === null) return;
    try {
      await audioEl.setSinkId(deviceId);
      setOnSpeaker(next);
    } catch (err) {
      console.error('[Calling] Falha ao trocar saída de áudio:', err);
    }
  }

  useEffect(() => {
    if (connecting) return;
    const tick = () => setElapsed(Math.floor((Date.now() - connectedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [connectedAt, connecting]);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-4 px-5 py-3 rounded-full shadow-2xl bg-[#111b21] text-white">
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-medium">{callerName}</span>
        <span className="text-xs text-emerald-400">{connecting ? 'Conectando…' : `${mm}:${ss}`}</span>
      </div>
      {supportsSinkId && audioElRef && (
        <button
          onClick={toggleSpeaker}
          title={onSpeaker ? 'Usar fone/auricular' : 'Usar viva-voz'}
          className="md:hidden w-9 h-9 rounded-full flex items-center justify-center transition-colors bg-white/10 hover:bg-white/20"
        >
          {onSpeaker ? <Volume2 size={16} /> : <Ear size={16} />}
        </button>
      )}
      <button
        onClick={onToggleMute}
        title={muted ? 'Ativar microfone' : 'Mudo'}
        className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${muted ? 'bg-amber-500 hover:bg-amber-600' : 'bg-white/10 hover:bg-white/20'}`}
      >
        {muted ? <MicOff size={16} /> : <Mic size={16} />}
      </button>
      <button
        onClick={onHangup}
        title="Desligar"
        className="w-9 h-9 rounded-full flex items-center justify-center bg-red-600 hover:bg-red-700 transition-colors"
      >
        <PhoneOff size={16} />
      </button>
    </div>
  );
}
