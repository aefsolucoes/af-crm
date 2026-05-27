import { Worker, Queue } from 'bullmq';
import IORedis from 'ioredis';

let connection: IORedis | null = null;
let redisAvailable = false;

export function getRedisConnection() {
  if (!connection) {
    connection = new IORedis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: () => null, // não reconecta automaticamente
    });
    connection.on('error', () => {
      redisAvailable = false;
    });
    connection.on('connect', () => {
      redisAvailable = true;
    });
  }
  return connection;
}

export let messageQueue: Queue | null = null;

export function startMessageWorker() {
  const conn = getRedisConnection();

  conn.connect().then(() => {
    redisAvailable = true;
    messageQueue = new Queue('messages', { connection: conn as any });

    const worker = new Worker(
      'messages',
      async (job) => {
        const { channel, content, leadId } = job.data;
        console.log(`[Worker] Enviando mensagem via ${channel} para lead ${leadId}: ${content}`);
      },
      { connection: conn as any }
    );

    worker.on('completed', (job) => {
      console.log(`[Worker] Job ${job.id} concluído`);
    });

    worker.on('failed', (job, err) => {
      console.error(`[Worker] Job ${job?.id} falhou:`, err);
    });

    console.log('[Worker] Message worker iniciado com Redis');
    return worker;
  }).catch(() => {
    console.warn('[Worker] Redis não disponível — worker desabilitado. Mensagens não serão enfileiradas.');
  });
}
