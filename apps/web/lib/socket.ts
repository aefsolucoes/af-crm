import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001', {
      autoConnect: false,
      // Função (não objeto) pra reler o token do localStorage a cada (re)conexão
      // — sem isso, um token trocado depois do refresh ou um reconnect após
      // queda de rede ia continuar mandando o token velho. O servidor agora
      // exige isso pra aceitar a conexão e decide sozinho as salas (account_/
      // user_) a partir do token, em vez de confiar no cliente dizendo quem é.
      auth: (cb) => {
        const token = typeof window !== 'undefined' ? localStorage.getItem('af_access_token') : null;
        cb({ token, clientType: 'web' });
      },
    });
    const s = socket;
    // TEMPO REAL QUE NÃO VOLTAVA (Fabio 26/10: "as mensagens disparam e chegam certinho, mas demoram para aparecer pra mim"): o token de acesso vence em ~1 h e,
    // depois de qualquer queda (deploy reiniciando o servidor, Wi-Fi, celular em segundo plano), o servidor RECUSA a reconexão com o token velho
    // ("Token inválido ou expirado") — e o socket.io NÃO tenta de novo sozinho nesse caso. A tela só atualizava pelo "a cada 60 s" de segurança.
    // Agora: recusa por token → renova o token e reconecta; servidor derrubou → reconecta; voltou pra aba/app → reconecta se estiver caído.
    let lastRefresh = 0;
    s.on('connect_error', async (err) => {
      if (!/token|expirad|inv[aá]lid|auth/i.test(String(err?.message || ''))) return; // queda de rede: o próprio socket.io tenta de novo
      if (Date.now() - lastRefresh < 15_000) return;
      lastRefresh = Date.now();
      const { refreshAccessToken } = await import('./api');
      const token = await refreshAccessToken();
      if (token) setTimeout(() => { if (!s.connected) s.connect(); }, 300);
    });
    s.on('disconnect', (reason) => {
      if (reason === 'io server disconnect') setTimeout(() => { if (!s.connected) s.connect(); }, 1000);
    });
    if (typeof window !== 'undefined') {
      const voltou = () => { if (document.visibilityState === 'visible' && !s.connected && localStorage.getItem('af_access_token')) s.connect(); };
      document.addEventListener('visibilitychange', voltou);
      window.addEventListener('focus', voltou);
      window.addEventListener('online', voltou);
    }
  }
  return socket;
}

export function connectSocket() {
  const s = getSocket();
  if (!s.connected) s.connect();
  return s;
}

export function disconnectSocket() {
  socket?.disconnect();
}
