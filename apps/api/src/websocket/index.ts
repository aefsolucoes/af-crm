import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';

interface SocketAuthPayload {
  id: string;
  accountId: string;
  role: string;
}

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

  // Autenticação por JWT no handshake — o servidor decide as salas a partir
  // do token, o cliente não escolhe mais (antes disso, qualquer socket podia
  // entrar em `account_<qualquerId>`/`user_<qualquerId>` só sabendo o cuid,
  // sem provar nada).
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('Token não fornecido'));
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET!) as SocketAuthPayload;
      socket.data.user = payload;
      next();
    } catch {
      next(new Error('Token inválido ou expirado'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as SocketAuthPayload;
    console.log(`[WS] Cliente conectado: ${socket.id} (user=${user.id})`);

    // Salas globais — automáticas, o próprio token já prova quem é a
    // conta/usuário (antes disso dependia do cliente emitir join_account/
    // join_user com o id "de bom-mor", sem checagem nenhuma).
    socket.join(`account_${user.accountId}`);
    socket.join(`user_${user.id}`);

    // Sala de lead específico (para o chat aberto) — mantém como estava,
    // não precisa de dono provado (só filtra o que aquela aba recebe).
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
