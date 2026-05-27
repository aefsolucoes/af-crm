import 'dotenv/config';
import express from 'express';
import http from 'http';
import cors from 'cors';
import { setupWebSocket } from './websocket';
import { startMessageWorker } from './workers/message.worker';

import authRoutes from './routes/auth';
import leadRoutes from './routes/leads';
import contactRoutes from './routes/contacts';
import messageRoutes from './routes/messages';
import taskRoutes from './routes/tasks';
import pipelineRoutes from './routes/pipelines';
import reportRoutes from './routes/reports';
import webhookRoutes from './routes/webhooks';
import settingsRoutes from './routes/settings';
import whatsappQrRoutes from './routes/whatsapp-qr';
import fieldRoutes from './routes/fields';
import noteRoutes from './routes/notes';
import userRoutes from './routes/users';
import { setBaileysIO, restoreActiveSessions } from './services/baileys.service';

const app = express();
const httpServer = http.createServer(app);

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origin.endsWith('.netlify.app')) return cb(null, true);
    if (origin.endsWith('.pages.dev')) return cb(null, true);
    if (origin.endsWith('.aefsolucoesfinanceiras.com.br')) return cb(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(express.json());

const io = setupWebSocket(httpServer);
app.set('io', io);
setBaileysIO(io);

app.use('/api/auth', authRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/contacts', contactRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/pipelines', pipelineRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/whatsapp-qr', whatsappQrRoutes);
app.use('/api/fields', fieldRoutes);
app.use('/api/notes', noteRoutes);
app.use('/api/users', userRoutes);

app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0.0', features: ['whatsapp', 'settings', 'qr'] }));

const PORT = parseInt(process.env.PORT || '3001', 10);

try {
  startMessageWorker();
  console.log('[Worker] Message worker iniciado');
} catch (err) {
  console.warn('[Worker] Redis não disponível, worker desabilitado:', err);
}

httpServer.listen(PORT, () => {
  console.log(`🚀 API AF CRM rodando em http://localhost:${PORT}`);
  // Restore WhatsApp QR sessions after restart
  restoreActiveSessions().catch(console.error);
});
