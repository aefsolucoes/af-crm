'use client';
import { useEffect, useState } from 'react';
import { Mic, MicOff, PhoneOff } from 'lucide-react';

/** Barra de ligação em andamento — puramente visual, sem lógica de WebRTC.
 *  Usada pelo ringer (chamada recebida) e, futuramente, pelo fluxo de
 *  ligação feita pelo CRM (mesma UI pros dois casos). */
export function ActiveCallBar({
  callerName,
  connectedAt,
  muted,
  onToggleMute,
  onHangup,
}: {
  callerName: string;
  connectedAt: number; // Date.now() de quando conectou
  muted: boolean;
  onToggleMute: () => void;
  onHangup: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const tick = () => setElapsed(Math.floor((Date.now() - connectedAt) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [connectedAt]);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-4 px-5 py-3 rounded-full shadow-2xl bg-[#111b21] text-white">
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-medium">{callerName}</span>
        <span className="text-xs text-emerald-400">{mm}:{ss}</span>
      </div>
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
