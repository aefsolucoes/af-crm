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
