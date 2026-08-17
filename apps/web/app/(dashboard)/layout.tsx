'use client';
import { useEffect, useRef } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Sidebar } from '@/components/ui/sidebar';
import { ToastContainer } from '@/components/ui/toast';
import { SupportChatButton } from '@/components/ui/support-chat';
import { toast } from '@/components/ui/toast';
import { useAuthStore } from '@/store/auth.store';
import { effectivePermissions, ROUTE_PERMISSION } from '@/lib/permissions';
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
  const pathname = usePathname();
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

  // Barra o acesso direto por URL a áreas sem permissão: manda para a primeira
  // área que o usuário pode acessar.
  useEffect(() => {
    if (!user) return;
    const perms = effectivePermissions(user.role, user.permissions ?? null);
    const rule = ROUTE_PERMISSION.find((r) => pathname.startsWith(r.prefix));
    if (rule && !perms[rule.perm]) {
      const firstAllowed = ROUTE_PERMISSION.find((r) => perms[r.perm]);
      router.replace(firstAllowed ? firstAllowed.prefix : '/login');
    }
  }, [user, pathname, router]);

  // Conecta Socket.io e escuta mensagens. As salas (account_.../user_...) já
  // são decididas pelo SERVIDOR a partir do token de autenticação — não é
  // mais o cliente quem diz "sou a conta X" (isso não podia mais ser
  // confiado depois que o socket passou a receber comandos do Agente de
  // Navegador; ver apps/api/src/websocket/index.ts).
  useEffect(() => {
    const socket = getSocket();
    if (!socket.connected) socket.connect();

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

    // assistant_question — outro colaborador pediu para o assistente perguntar
    // algo a este colaborador (fica pendente no chat dele). Toca som pra avisar.
    function onAssistantQuestion() {
      triggerSound();
    }

    // ai_handoff — a IA que respondia um cliente sozinha se desligou porque
    // ele pediu atendente (ou saiu do escopo do setor). Toca som E mostra
    // toast, porque exige ação do colaborador (não é só uma pendência).
    function onAiHandoff({ leadName }: { leadId: string; leadName?: string }) {
      triggerSound();
      toast(`A IA encerrou o atendimento de ${leadName || 'um cliente'} — o cliente pediu para falar com alguém. Confira a conversa na Inbox.`, 'warning');
    }

    socket.on('new_notification', onNewNotification);
    socket.on('assistant_question', onAssistantQuestion);
    socket.on('ai_handoff', onAiHandoff);

    return () => {
      socket.off('new_notification', onNewNotification);
      socket.off('assistant_question', onAssistantQuestion);
      socket.off('ai_handoff', onAiHandoff);
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
