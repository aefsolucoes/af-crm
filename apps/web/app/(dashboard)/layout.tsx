'use client';
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter, usePathname } from 'next/navigation';
import { Sidebar } from '@/components/ui/sidebar';
import { ToastContainer } from '@/components/ui/toast';
import { toast } from '@/components/ui/toast';
import { GoogleDriveAlert } from '@/components/ui/google-drive-alert';
import { ContractingLeadAlert } from '@/components/ui/contracting-lead-alert';
import { IncomingCallRinger } from '@/components/ui/incoming-call-ringer';
import { OutboundCallBar } from '@/components/ui/outbound-call-bar';
import { useAuthStore } from '@/store/auth.store';
import { effectivePermissions, ROUTE_PERMISSION } from '@/lib/permissions';
import { getSocket } from '@/lib/socket';
import { playSoundOnce, SoundKey } from '@/lib/sounds';

const playNotificationSound = playSoundOnce;

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, init } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
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
        if (saved !== 'none') playNotificationSound(saved as SoundKey);
      }
    }

    // new_notification — evento exclusivo para som/badge (não duplica mensagem
    // no chat). Dispara pra mensagem recebida E enviada (o backend não
    // distingue) — só toca som pra quem CHEGA (INBOUND); usuário reportou que
    // tocava até quando ele mesmo mandava uma mensagem.
    function onNewNotification({ message }: { leadId: string; message?: { direction?: string } }) {
      if (message?.direction === 'INBOUND') triggerSound();
    }

    // ai_handoff — a IA que respondia um cliente sozinha se desligou porque
    // ele pediu atendente (ou saiu do escopo do setor). Toca som E mostra
    // toast, porque exige ação do colaborador (não é só uma pendência).
    function onAiHandoff({ leadName, reason }: { leadId: string; leadName?: string; reason?: string | null }) {
      triggerSound();
      toast(reason
        ? `A IA repassou ${leadName || 'um cliente'} pra equipe: ${reason}. Confira a conversa na Inbox.`
        : `A IA encerrou o atendimento de ${leadName || 'um cliente'} — o cliente pediu para falar com alguém. Confira a conversa na Inbox.`, 'warning');
    }

    // contracting_lead — cliente fechado entrou no funil de contratação. Só
    // toca o som aqui; o popup com os links é o <ContractingLeadAlert />.
    function onContractingLead() { triggerSound(); }

    // site_lead_created — lead novo chegou pelo formulário do site (campanha
    // do Meta Ads). Não é mensagem (new_notification não toca som pra isso),
    // então precisa de aviso próprio — mesmo padrão do ai_handoff.
    function onSiteLeadCreated({ leadName, department }: { leadId: string; leadName?: string; department?: string }) {
      triggerSound();
      toast(`Novo lead do site: ${leadName || 'Cliente'}${department ? ` — ${department}` : ''}`, 'success');
    }

    // lead_merged — dois cards viraram um só (Inbox/Funil → "Unificar
    // duplicados"). Sem isso, quem está com a Inbox/Funil aberto continuava
    // vendo o estado de antes do merge até recarregar a página manualmente
    // (reportado como "o card sumiu" — na verdade os dados foram pro card
    // mantido, só a tela não tinha atualizado).
    function onLeadMerged() {
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    }

    socket.on('new_notification', onNewNotification);
    socket.on('ai_handoff', onAiHandoff);
    socket.on('contracting_lead', onContractingLead);
    socket.on('site_lead_created', onSiteLeadCreated);
    socket.on('lead_merged', onLeadMerged);

    return () => {
      socket.off('new_notification', onNewNotification);
      socket.off('ai_handoff', onAiHandoff);
      socket.off('contracting_lead', onContractingLead);
      socket.off('site_lead_created', onSiteLeadCreated);
      socket.off('lead_merged', onLeadMerged);
    };
  }, [queryClient]);

  return (
    <div className="flex h-screen overflow-hidden app-bg-surface">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        {children}
      </main>
      <ToastContainer />
      <GoogleDriveAlert />
      <ContractingLeadAlert />
      <IncomingCallRinger />
      <OutboundCallBar />
    </div>
  );
}
