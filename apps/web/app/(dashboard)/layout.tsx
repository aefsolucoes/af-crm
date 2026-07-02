'use client';
import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/ui/sidebar';
import { ToastContainer } from '@/components/ui/toast';
import { SupportChatButton } from '@/components/ui/support-chat';
import { useAuthStore } from '@/store/auth.store';
import { getSocket } from '@/lib/socket';

type SoundKey = 'whatsapp' | 'ding' | 'pop' | 'chime' | 'bell' | 'soft' | 'alert' | 'none';

// Gera som de notificação via Web Audio API (sem arquivo externo)
function playNotificationSound(key: SoundKey = 'whatsapp') {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    const tone = (freq: number, start: number, dur: number, vol: number, type: OscillatorType = 'sine') => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);
      gain.gain.setValueAtTime(vol, ctx.currentTime + start);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };

    if (key === 'whatsapp') { tone(1200,0,0.15,0.4); tone(1000,0.18,0.15,0.3); tone(800,0.36,0.20,0.2); }
    else if (key === 'ding')  { tone(880, 0, 0.5, 0.4); }
    else if (key === 'pop')   { tone(600,0,0.04,0.5,'square'); tone(400,0.04,0.08,0.3); }
    else if (key === 'chime') { tone(523,0,0.3,0.35); tone(659,0.15,0.3,0.30); tone(784,0.30,0.4,0.25); }
    else if (key === 'bell')  { tone(987,0,0.05,0.5,'square'); tone(1174,0,0.40,0.3); tone(987,0.05,0.35,0.2); }
    else if (key === 'soft')  { tone(440,0,0.6,0.2); tone(550,0.1,0.5,0.15); }
    else if (key === 'alert') { tone(1000,0,0.10,0.5,'square'); tone(1200,0.12,0.10,0.5,'square'); tone(1000,0.24,0.10,0.4,'square'); }

    setTimeout(() => ctx.close().catch(() => {}), 1200);
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
        const saved = localStorage.getItem('af_notification_sound') || 'whatsapp';
        if (saved !== 'none') playNotificationSound(saved as any);
      }
    }

    // new_notification — evento exclusivo para som/badge (não duplica mensagem no chat)
    function onNewNotification() {
      triggerSound();
    }

    socket.on('new_notification', onNewNotification);

    return () => {
      socket.off('connect', joinAccount);
      socket.off('new_notification', onNewNotification);
    };
  }, []);

  return (
    <div className="flex h-screen overflow-hidden app-bg-surface">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        {children}
      </main>
      <ToastContainer />
      <SupportChatButton />
    </div>
  );
}
