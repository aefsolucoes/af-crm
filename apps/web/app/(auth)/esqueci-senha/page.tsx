'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { LayoutDashboard, MailCheck, ArrowLeft } from 'lucide-react';

/** "Esqueci minha senha": manda um link de redefinição pro e-mail (vale 30 min). */
export default function EsqueciSenhaPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.post('/api/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      const r = err as { response?: { data?: { error?: string } } };
      setError(r?.response?.data?.error || 'Não consegui mandar o link. Tente de novo.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-af-navy via-af-blue to-af-mid flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white/10 rounded-2xl mb-4">
            <LayoutDashboard size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">AF CRM</h1>
          <p className="text-slate-300 text-sm mt-1">A&F Soluções Financeiras</p>
        </div>

        <div className="bg-white rounded-2xl shadow-2xl p-8">
          {sent ? (
            <>
              <div className="flex items-center gap-2 mb-2">
                <MailCheck size={22} className="text-af-accent" />
                <h2 className="text-xl font-semibold text-slate-900">Confira seu e-mail</h2>
              </div>
              <p className="text-sm text-slate-500">
                Se <b className="text-slate-700">{email}</b> tiver conta no CRM, enviamos um link pra criar uma senha nova. Ele vale por 30 minutos.
              </p>
              <p className="text-xs text-slate-400 mt-3">Não chegou? Olhe o spam ou peça de novo daqui a 1 minuto.</p>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold text-slate-900 mb-2">Esqueci minha senha</h2>
              <p className="text-sm text-slate-500 mb-5">Informe o e-mail da sua conta que mandamos um link pra você criar uma senha nova.</p>
              <form onSubmit={handleSubmit} className="space-y-4">
                <Input
                  id="email"
                  type="email"
                  label="E-mail"
                  placeholder="seu@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  autoFocus
                />
                {error && <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}
                <Button type="submit" loading={loading} className="w-full" size="lg">Mandar link</Button>
              </form>
            </>
          )}
          <Link href="/login" className="inline-flex items-center gap-1 mt-5 text-sm text-slate-500 hover:text-slate-700">
            <ArrowLeft size={14} /> Voltar pro login
          </Link>
        </div>
      </div>
    </div>
  );
}
