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
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

    // Nota 1 — ding alto
    const o1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    o1.connect(g1);
    g1.connect(ctx.destination);
    o1.type = 'sine';
    o1.frequency.setValueAtTime(880, ctx.currentTime);
    o1.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.12);
    g1.gain.setValueAtTime(0.35, ctx.currentTime);
    g1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o1.start(ctx.currentTime);
    o1.stop(ctx.currentTime + 0.35);

    // Nota 2 — ding baixo (eco)
    const o2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    o2.connect(g2);
    g2.connect(ctx.destination);
    o2.type = 'sine';
    o2.frequency.setValueAtTime(660, ctx.currentTime + 0.18);
    o2.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.38);
    g2.gain.setValueAtTime(0.2, ctx.currentTime + 0.18);
    g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    o2.start(ctx.currentTime + 0.18);
    o2.stop(ctx.currentTime + 0.5);
  } catch {
    // Web Audio API não disponível — ignora silenciosamente
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

  // Escuta mensagens WhatsApp via Socket.io e toca som
  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();

    function onNewMessage(msg: { channel?: string; direction?: string }) {
      // Só toca para mensagens INBOUND do WhatsApp
      if (msg?.direction === 'INBOUND' && msg?.channel === 'WHATSAPP') {
        const now = Date.now();
        // Evita tocar várias vezes em menos de 2 segundos
        if (now - lastSoundRef.current > 2000) {
          lastSoundRef.current = now;
          playNotificationSound();
        }
      }
    }

    function onNewConversation() {
      const now = Date.now();
      if (now - lastSoundRef.current > 2000) {
        lastSoundRef.current = now;
        playNotificationSound();
      }
    }

    socket.on('new_message', onNewMessage);
    socket.on('new_conversation', onNewConversation);

    return () => {
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
