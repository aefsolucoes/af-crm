import { useEffect, useState } from 'react';
import { login, verifyCode, clearAuth, type StoredUser } from '../lib/api';

type Status = { user: StoredUser | null; connected: boolean };

function getStatus(): Promise<Status> {
  return chrome.runtime.sendMessage({ type: 'GET_STATUS' });
}

function notifyAuthUpdated(): Promise<unknown> {
  return chrome.runtime.sendMessage({ type: 'AUTH_UPDATED' });
}

export function Popup() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>({ user: null, connected: false });

  // Formulário de login
  const [step, setStep] = useState<'credentials' | 'code'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function refreshStatus() {
    const s = await getStatus();
    setStatus(s);
    setLoading(false);
  }

  useEffect(() => {
    refreshStatus();
    // Enquanto o popup estiver aberto, confere de novo a cada 2s — o socket
    // pode levar um instante pra conectar depois do login.
    const id = setInterval(refreshStatus, 2000);
    return () => clearInterval(id);
  }, []);

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const result = await login(email.trim(), password);
      if (result.requiresCode) {
        setStep('code');
      } else {
        await notifyAuthUpdated();
        await refreshStatus();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao entrar');
    } finally {
      setBusy(false);
    }
  }

  async function handleCode(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await verifyCode(email.trim(), code.trim());
      await notifyAuthUpdated();
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Código inválido');
    } finally {
      setBusy(false);
    }
  }

  async function handleLogout() {
    await clearAuth();
    await notifyAuthUpdated();
    await refreshStatus();
    setStep('credentials');
    setEmail('');
    setPassword('');
    setCode('');
  }

  if (loading) {
    return <div style={s.wrap}>Carregando...</div>;
  }

  if (status.user) {
    return (
      <div style={s.wrap}>
        <h3 style={s.title}>Agente de Navegador</h3>
        <div style={s.row}>
          <span style={{ ...s.dot, background: status.connected ? '#00a884' : '#e0453e' }} />
          <span style={s.small}>{status.connected ? 'Conectado ao CRM' : 'Desconectado — reconectando...'}</span>
        </div>
        <p style={s.small}>Logado como <strong>{status.user.name}</strong></p>
        <p style={{ ...s.small, color: '#8696a0' }}>
          Fase 0 — sem IA ainda. Use as rotas de teste (<code>/api/browser-agent/test/*</code>) pra
          comandar clique/digitação/screenshot na aba ativa.
        </p>
        <button style={s.buttonSecondary} onClick={handleLogout}>Sair</button>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      <h3 style={s.title}>Agente de Navegador</h3>
      <p style={{ ...s.small, color: '#8696a0' }}>Entre com a mesma conta do CRM.</p>
      {step === 'credentials' ? (
        <form onSubmit={handleCredentials} style={s.form}>
          <input
            type="email"
            placeholder="E-mail"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            style={s.input}
          />
          <input
            type="password"
            placeholder="Senha"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={s.input}
          />
          {error && <p style={s.error}>{error}</p>}
          <button type="submit" disabled={busy} style={s.button}>
            {busy ? 'Entrando...' : 'Entrar'}
          </button>
        </form>
      ) : (
        <form onSubmit={handleCode} style={s.form}>
          <p style={s.small}>Enviamos um código para {email}.</p>
          <input
            type="text"
            placeholder="Código de 6 dígitos"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            style={s.input}
          />
          {error && <p style={s.error}>{error}</p>}
          <button type="submit" disabled={busy} style={s.button}>
            {busy ? 'Confirmando...' : 'Confirmar'}
          </button>
        </form>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  wrap: { fontFamily: 'system-ui, sans-serif', padding: 16, background: '#111b21', color: '#e9edef', minHeight: 120 },
  title: { margin: '0 0 8px', fontSize: 15 },
  small: { fontSize: 12, margin: '4px 0' },
  row: { display: 'flex', alignItems: 'center', gap: 6, margin: '6px 0' },
  dot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  form: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 },
  input: {
    padding: '8px 10px', borderRadius: 8, border: '1px solid #2a3942',
    background: '#202c33', color: '#e9edef', fontSize: 13, outline: 'none',
  },
  button: {
    padding: '8px 10px', borderRadius: 8, border: 'none',
    background: '#00a884', color: '#111b21', fontWeight: 600, fontSize: 13, cursor: 'pointer',
  },
  buttonSecondary: {
    padding: '8px 10px', borderRadius: 8, border: '1px solid #2a3942',
    background: 'transparent', color: '#e9edef', fontSize: 13, cursor: 'pointer', marginTop: 8,
  },
  error: { color: '#e0453e', fontSize: 12, margin: 0 },
};
