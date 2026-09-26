'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { LayoutDashboard, CheckCircle2, ArrowLeft } from 'lucide-react';

/** Página do link do e-mail: cria a senha nova (token de uso único, 30 min). */
function RedefinirSenha() {
  const token = useSearchParams().get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (password.length < 8) { setError('A senha precisa ter pelo menos 8 caracteres.'); return; }
    if (password !== confirm) { setError('As duas senhas não são iguais.'); return; }
    setLoading(true);
    try {
      await api.post('/api/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      const r = err as { response?: { data?: { error?: string } } };
      setError(r?.response?.data?.error || 'Não consegui trocar a senha.');
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <>
        <h2 className="text-xl font-semibold text-slate-900 mb-2">Link inválido</h2>
        <p className="text-sm text-slate-500">Abra o link direto do e-mail, ou peça um novo em "Esqueci minha senha".</p>
        <Link href="/esqueci-senha" className="inline-block mt-4 text-sm text-af-accent font-medium hover:underline">Pedir link novo</Link>
      </>
    );
  }

  if (done) {
    return (
      <>
        <div className="flex items-center gap-2 mb-2">
          <CheckCircle2 size={22} className="text-emerald-500" />
          <h2 className="text-xl font-semibold text-slate-900">Senha trocada</h2>
        </div>
        <p className="text-sm text-slate-500 mb-5">Pronto! Agora é só entrar com a senha nova. Se você estava logado em outro aparelho, vai precisar entrar de novo lá.</p>
        <Link href="/login"><Button className="w-full" size="lg">Ir pro login</Button></Link>
      </>
    );
  }

  return (
    <>
      <h2 className="text-xl font-semibold text-slate-900 mb-2">Criar senha nova</h2>
      <p className="text-sm text-slate-500 mb-5">Escolha uma senha com pelo menos 8 caracteres.</p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input id="password" type="password" label="Senha nova" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" autoFocus />
        <Input id="confirm" type="password" label="Repita a senha nova" placeholder="••••••••" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
            {error}
            {error.includes('expirou') && <Link href="/esqueci-senha" className="block mt-1 font-medium underline">Pedir link novo</Link>}
          </div>
        )}
        <Button type="submit" loading={loading} className="w-full" size="lg">Salvar senha nova</Button>
      </form>
    </>
  );
}

export default function RedefinirSenhaPage() {
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
          <Suspense fallback={<p className="text-sm text-slate-400">Carregando...</p>}>
            <RedefinirSenha />
          </Suspense>
          <Link href="/login" className="inline-flex items-center gap-1 mt-5 text-sm text-slate-500 hover:text-slate-700">
            <ArrowLeft size={14} /> Voltar pro login
          </Link>
        </div>
      </div>
    </div>
  );
}
