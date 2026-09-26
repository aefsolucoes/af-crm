'use client';
import { useEffect, useState } from 'react';
import { Mic, MicOff, PhoneOff } from 'lucide-react';

/** Barra de ligação em andamento — puramente visual, sem lógica de WebRTC.
 *  Usada pelo ringer (chamada recebida) e pelo fluxo de ligação feita pelo
 *  CRM (mesma UI pros dois casos). Mostrada tanto em "conectando" (tocando/
 *  negociando) quanto em "conectado" -- silenciar e desligar precisam estar
 *  disponíveis o tempo todo, não só depois que a Meta confirma o estado
 *  "connected" do RTCPeerConnection (esse evento pode demorar ou nem bater
 *  exatamente com o áudio já estar fluindo de verdade).
 *
 *  Não tem mais botão de trocar pra fone/auricular (tentado e removido em
 *  2026-09-24): usava HTMLMediaElement.setSinkId escolhendo o dispositivo de
 *  saída "na tentativa" (rótulo do device, sem garantia entre aparelhos) --
 *  usuário reportou que DEPOIS dessa mudança o áudio parou de sair também no
 *  viva-voz (silêncio total, ligando ou recebendo). Sem like ter um celular
 *  de verdade pra testar, o risco de deixar a ligação muda de novo é maior
 *  que o ganho do botão -- volta pro comportamento simples de antes (o
 *  navegador decide a saída sozinho), que já tinha sido confirmado
 *  funcionando. */
export function ActiveCallBar({
  callerName,
  connectedAt,
  connecting,
  muted,
  onToggleMute,
  onHangup,
}: {
  callerName: string;
  connectedAt: number; // Date.now() de quando conectou (ignorado se connecting)
  connecting?: boolean;
  muted: boolean;
  onToggleMute: () => void;
  onHangup: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);

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
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-4 px-5 py-3 rounded-full shadow-2xl bg-[#111b21] text-white max-w-[calc(100vw-2rem)]">
      {/* max-w-[120px] truncate: nome comprido (empresa+pessoa, comum aqui)
          estourava a largura da barra e quebrava em 2-3 linhas, deixando a
          pilula inteira gigante e torta -- achado real do usuário ("continua
          encolhido", se referindo ao resultado esquisito, não ao texto em
          si). Corta com "..." em vez de quebrar linha, mantém a pilula
          sempre no mesmo formato compacto. */}
      <div className="flex flex-col leading-tight min-w-0">
        <span className="text-sm font-medium truncate max-w-[140px]">{callerName}</span>
        {/* Ligação conectada é gravada e transcrita (vira nota no card e treino da IA). */}
        <span className="text-xs text-emerald-400">
          {connecting ? 'Conectando…' : <><span className="text-red-400">● Gravando</span> · {mm}:{ss}</>}
        </span>
      </div>
      <button
        onClick={onToggleMute}
        title={muted ? 'Ativar microfone' : 'Mudo'}
        className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-colors ${muted ? 'bg-amber-500 hover:bg-amber-600' : 'bg-white/10 hover:bg-white/20'}`}
      >
        {muted ? <MicOff size={16} /> : <Mic size={16} />}
      </button>
      <button
        onClick={onHangup}
        title="Desligar"
        className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center bg-red-600 hover:bg-red-700 transition-colors"
      >
        <PhoneOff size={16} />
      </button>
    </div>
  );
}
