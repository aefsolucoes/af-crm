import { Server as HttpServer } from 'http';
import { Server } from 'socket.io';

export function setupWebSocket(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: { origin: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000', methods: ['GET', 'POST'] },
  });

  io.on('connection', (socket) => {
    console.log(`[WS] Cliente conectado: ${socket.id}`);

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
