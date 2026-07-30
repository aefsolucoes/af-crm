'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth.store';
import api from '@/lib/api';
import { LayoutDashboard, MailCheck, ArrowLeft } from 'lucide-react';

function errMsg(e: unknown, fallback: string) {
  const r = e as { response?: { data?: { error?: string } } };
  return r?.response?.data?.error || fallback;
}

export default function LoginPage() {
  const [step, setStep] = useState<'credentials' | 'code'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const { setAuth } = useAuthStore();
  const router = useRouter();

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setInfo('');
    setLoading(true);
    try {
      const { data } = await api.post('/api/auth/login', { email, password });
      if (data.requiresCode) {
        setStep('code');
        setCode('');
        setInfo(`Enviamos um código de 6 dígitos para ${data.email || email}.`);
      } else {
        setAuth(data.user, data.accessToken, data.refreshToken);
        router.push('/dashboard');
      }
    } catch (err) {
      setError(errMsg(err, 'E-mail ou senha inválidos. Tente novamente.'));
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { data } = await api.post('/api/auth/verify-code', { email, code: code.trim() });
      setAuth(data.user, data.accessToken, data.refreshToken);
      router.push('/dashboard');
    } catch (err) {
      setError(errMsg(err, 'Código inválido.'));
    } finally {
      setLoading(false);
    }
  }

  async function handleResend() {
    setError('');
    setInfo('');
    setResending(true);
    try {
      await api.post('/api/auth/login', { email, password });
      setCode('');
      setInfo('Novo código enviado para o seu e-mail.');
    } catch (err) {
      setError(errMsg(err, 'Não consegui reenviar o código.'));
    } finally {
      setResending(false);
    }
  }

  function backToLogin() {
    setStep('credentials');
    setCode('');
    setError('');
    setInfo('');
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-af-navy via-af-blue to-af-mid flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-white/10 rounded-2xl mb-4">
            <LayoutDashboard size={32} className="text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">AF CRM</h1>
          <p className="text-slate-300 text-sm mt-1">A&F Soluções Financeiras</p>
        </div>

        {/* Card */}
        <div className="bg-white rounded-2xl shadow-2xl p-8">
          {step === 'credentials' ? (
            <>
              <h2 className="text-xl font-semibold text-slate-900 mb-6">Entrar na sua conta</h2>
              <form onSubmit={handleCredentials} className="space-y-4">
                <Input
                  id="email"
                  type="email"
                  label="E-mail"
                  placeholder="seu@email.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
                <Input
                  id="password"
                  type="password"
                  label="Senha"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />

                {error && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
                )}

                <Button type="submit" loading={loading} className="w-full" size="lg">
                  Entrar
                </Button>
              </form>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-2">
                <MailCheck size={22} className="text-af-accent" />
                <h2 className="text-xl font-semibold text-slate-900">Confirme o código</h2>
              </div>
              <p className="text-sm text-slate-500 mb-5">
                {info || `Enviamos um código de 6 dígitos para ${email}.`}
              </p>
              <form onSubmit={handleVerify} className="space-y-4">
                <Input
                  id="code"
                  type="text"
                  label="Código de acesso"
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  className="text-center text-2xl tracking-[0.4em] font-semibold"
                />

                {error && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
                )}

                <Button type="submit" loading={loading} className="w-full" size="lg" disabled={code.length < 4}>
                  Entrar
                </Button>
              </form>

              <div className="flex items-center justify-between mt-5 text-sm">
                <button
                  onClick={backToLogin}
                  className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-700"
                >
                  <ArrowLeft size={14} /> Voltar
                </button>
                <button
                  onClick={handleResend}
                  disabled={resending}
                  className="text-af-accent font-medium hover:underline disabled:opacity-50"
                >
                  {resending ? 'Reenviando…' : 'Reenviar código'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
