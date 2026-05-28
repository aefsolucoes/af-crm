import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';

export function setupWebSocket(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: {
      // Aceita qualquer origem (frontend pode estar em Cloudflare Pages, domínio próprio, localhost)
      origin: (origin, callback) => {
        callback(null, true);
      },
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    console.log(`[WS] Cliente conectado: ${socket.id}`);

    // Entra na sala global da conta — recebe new_message e new_conversation de qualquer lead
    socket.on('join_account', (accountId: string) => {
      socket.join(`account_${accountId}`);
      console.log(`[WS] Socket ${socket.id} entrou em account_${accountId}`);
    });

    socket.on('leave_account', (accountId: string) => {
      socket.leave(`account_${accountId}`);
    });

    // Sala de lead específico (para o chat aberto)
    socket.on('join_lead', (leadId: string) => {
      socket.join(`lead:${leadId}`);
    });

    socket.on('leave_lead', (leadId: string) => {
      socket.leave(`lead:${leadId}`);
    });

    socket.on('disconnect', () => {
      console.log(`[WS] Cliente desconectado: ${socket.id}`);
    });
  });

  return io;
}
