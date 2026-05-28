'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/ui/sidebar';
import { ToastContainer } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth.store';
import { getSocket } from '@/lib/socket';

// Gera som de notificação via Web Audio API (sem arquivo externo)
function playNotificationSound() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    const play = (freq: number, startAt: number, duration: number, volume: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + startAt);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.75, ctx.currentTime + startAt + duration);
      gain.gain.setValueAtTime(volume, ctx.currentTime + startAt);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + startAt + duration);
      osc.start(ctx.currentTime + startAt);
      osc.stop(ctx.currentTime + startAt + duration);
    };

    // Três dings — estilo notificação WhatsApp
    play(1200, 0.00, 0.15, 0.4);
    play(1000, 0.18, 0.15, 0.3);
    play(800,  0.36, 0.20, 0.2);

    // Fecha o contexto após o som terminar
    setTimeout(() => ctx.close().catch(() => {}), 800);
  } catch {
    // fallback silencioso
  }
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, init } = useAuthStore();
  const router = useRouter();
  const lastSoundRef = useRef<number>(0);

  useEffect(() => {
    init();
  }, [init]);

  useEffect(() => {
    if (!user && typeof window !== 'undefined') {
      const token = localStorage.getItem('af_access_token');
      if (!token) router.replace('/login');
    }
  }, [user, router]);

  // Conecta Socket.io na sala da conta e escuta mensagens
  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();

    // Entra na sala da conta para receber notificações globais
    const accountId = typeof window !== 'undefined'
      ? JSON.parse(localStorage.getItem('af_user') || '{}')?.accountId
      : null;

    function joinAccount() {
      if (accountId) {
        socket.emit('join_account', accountId);
        console.log('[WS] Entrou na sala account_' + accountId);
      }
    }

    // Entra imediatamente se já conectado, ou quando conectar
    if (socket.connected) joinAccount();
    socket.on('connect', joinAccount);

    function triggerSound() {
      const now = Date.now();
      if (now - lastSoundRef.current > 2000) {
        lastSoundRef.current = now;
        playNotificationSound();
      }
    }

    // new_message vem da sala da conta (global) ou da sala do lead
    function onNewMessage(msg: { channel?: string; direction?: string }) {
      if (msg?.direction === 'INBOUND') triggerSound();
    }

    // new_conversation: novo lead chegou via WhatsApp
    function onNewConversation() {
      triggerSound();
    }

    socket.on('new_message', onNewMessage);
    socket.on('new_conversation', onNewConversation);

    return () => {
      socket.off('connect', joinAccount);
      socket.off('new_message', onNewMessage);
      socket.off('new_conversation', onNewConversation);
    };
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        {children}
      </main>
      <ToastContainer />
    </div>
  );
}
