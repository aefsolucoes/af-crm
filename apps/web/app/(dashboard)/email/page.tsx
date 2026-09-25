'use client';
import { Topbar } from '@/components/ui/topbar';
import { EmailInbox } from '@/components/email/email-inbox';

export default function EmailPage() {
  return (
    <div className="flex flex-col h-full">
      <Topbar title="E-mail" subtitle="Caixa da empresa e o seu e-mail — respostas de clientes também caem na conversa do card" />
      <EmailInbox />
    </div>
  );
}
