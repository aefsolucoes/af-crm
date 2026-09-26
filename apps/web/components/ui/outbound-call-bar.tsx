'use client';
import { useEffect } from 'react';
import { X, Phone } from 'lucide-react';
import { useOutboundCallStore } from '@/store/outbound-call.store';
import { getSocket } from '@/lib/socket';
import { Avatar } from '@/components/ui/avatar';
import { ActiveCallBar } from '@/components/ui/active-call-bar';

/** "5561985243606" → "+55 (61) 98524-3606". */
function formatPhoneDisplay(phone: string | null | undefined): string {
  if (!phone) return '';
  const d = phone.replace(/\D/g, '');
  if (d.length === 13 && d.startsWith('55')) {
    return `+55 (${d.slice(2, 4)}) ${d.slice(4, 9)}-${d.slice(9)}`;
  }
  return `+${d}`;
}

/** Ligação FEITA pelo CRM (fluxo outbound) — global, montado uma vez no
 *  layout do dashboard (igual o <IncomingCallRinger /> já é pro fluxo de
 *  receber ligação). ACHADO REAL (2026-09-24): antes disso, todo esse
 *  estado (RTCPeerConnection, nome de quem tá sendo chamado etc.) vivia
 *  dentro do ChatWindow — trocar de conversa no meio de uma ligação trocava
 *  o nome mostrado na barra (pegava o da conversa aberta agora, não o de
 *  quem realmente estava sendo chamado) e, se o usuário saísse da Inbox,
 *  a ligação em si sumia. Agora é um Zustand store global (store/
 *  outbound-call.store.ts) — esse componente só monta a UI por cima dele. */
export function OutboundCallBar() {
  const { stage, leadName, targetPhone, muted, connectedAt, registerAudioEl, confirmCall, dismiss, hangup, toggleMute, handleCallAnswered, handleCallAccepted, handleCallEnded } = useOutboundCallStore();

  useEffect(() => {
    const socket = getSocket();
    const onAnswered = ({ waCallId, sdp }: { waCallId: string; sdp: string }) => handleCallAnswered(waCallId, sdp);
    const onAccepted = ({ waCallId }: { waCallId: string }) => handleCallAccepted(waCallId);
    const onRinging = ({ waCallId }: { waCallId: string }) => useOutboundCallStore.getState().handleCallRinging(waCallId);
    const onEnded = ({ waCallId }: { waCallId: string }) => handleCallEnded(waCallId);
    socket.on('call_answered', onAnswered);
    socket.on('call_accepted', onAccepted);
    socket.on('call_ringing', onRinging);
    socket.on('call_ended', onEnded);
    return () => {
      socket.off('call_answered', onAnswered);
      socket.off('call_accepted', onAccepted);
      socket.off('call_ringing', onRinging);
      socket.off('call_ended', onEnded);
    };
  }, [handleCallAnswered, handleCallAccepted, handleCallEnded]);

  return (
    <>
      <audio ref={(el) => registerAudioEl(el)} autoPlay />

      {/* Popup de confirmação antes de ligar de verdade — estilo WhatsApp.
          Não tem mais popup de "pedir permissão" (achado real do usuário
          2026-09-24): o botão "Ligar" do cabeçalho já pede a permissão
          direto ao clicar quando ainda não tem, sem diálogo no meio -- só
          quando JÁ está permitido é que chega aqui, pra confirmar antes de
          discar de verdade. */}
      {stage === 'confirm' && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/50" onClick={dismiss}>
          {/* Fundo escuro sólido, NÃO app-column-surface -- essa classe é
              translúcida sobre a cor de fundo customizável da Inbox
              (--app-column-bg-rgb, BRANCA por padrão), então o texto claro
              deste popup (pensado pra fundo escuro) ficava ilegível/invisível
              em cima dela -- achado real do usuário (o "X" de cancelar
              sumia). Um popup de confirmação precisa de contraste garantido,
              não pode depender do tema/wallpaper de quem está usando. */}
          <div
            className="bg-[#233138] rounded-2xl shadow-2xl w-full max-w-xs flex flex-col items-center gap-4 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <Avatar name={leadName || ''} size="lg" />
            <div className="text-center">
              <p className="text-base font-semibold text-[#e9edef]">{leadName}</p>
              {targetPhone && <p className="text-sm text-[#8696a0] mt-0.5">{formatPhoneDisplay(targetPhone)}</p>}
              <p className="text-xs text-[#8696a0] mt-2">Ligar pra esse cliente pelo WhatsApp?</p>
            </div>
            <div className="flex items-center gap-6 mt-1">
              <button
                onClick={dismiss}
                title="Cancelar"
                className="w-12 h-12 rounded-full bg-white/10 hover:bg-white/20 text-[#e9edef] flex items-center justify-center transition-colors"
              >
                <X size={20} />
              </button>
              <button
                onClick={confirmCall}
                title="Ligar"
                className="w-14 h-14 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center shadow-lg transition-colors"
              >
                <Phone size={22} />
              </button>
            </div>
          </div>
        </div>
      )}

      {(stage === 'connecting' || stage === 'connected') && (
        <ActiveCallBar
          callerName={leadName || ''}
          connectedAt={connectedAt}
          connecting={stage === 'connecting'}
          muted={muted}
          onToggleMute={toggleMute}
          onHangup={hangup}
        />
      )}
    </>
  );
}
