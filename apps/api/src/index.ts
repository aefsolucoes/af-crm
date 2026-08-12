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
import aiRoutes from './routes/ai';
import knowledgeRoutes from './routes/knowledge';
import financeRoutes from './routes/finance';
import googleRoutes from './routes/google';
import dashboardNoteRoutes from './routes/dashboard-notes';
import importRoutes from './routes/import';
import messageTemplateRoutes from './routes/message-templates';
import departmentRoutes from './routes/departments';
import { setBaileysIO, restoreActiveSessions } from './services/baileys.service';
import { archiveOldAttachmentsAllAccounts } from './services/google.service';
import { generateRecurringTransactions } from './routes/finance';

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
// Limite elevado para permitir envio de documentos/imagens em base64 pela Inbox
app.use(express.json({ limit: '30mb' }));

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
app.use('/api/ai', aiRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/google', googleRoutes);
app.use('/api/dashboard-notes', dashboardNoteRoutes);
app.use('/api/import', importRoutes);
app.use('/api/message-templates', messageTemplateRoutes);
app.use('/api/departments', departmentRoutes);

app.get('/health', (_, res) => res.json({ status: 'ok', version: '2.0.0', features: ['whatsapp', 'settings', 'qr'] }));

// Política de Privacidade — URL pública para uso no Meta Developer Console
app.get('/privacidade', (_, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Política de Privacidade — A&F Soluções Financeiras</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1e293b;background:#f8fafc}
    .container{max-width:760px;margin:0 auto;padding:48px 24px}
    .logo{display:flex;align-items:center;gap:12px;margin-bottom:40px}
    .logo-icon{width:44px;height:44px;background:linear-gradient(135deg,#1e3a5f,#2d6a9f);border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:18px}
    h1{font-size:28px;font-weight:700;color:#1e3a5f;margin-bottom:8px}
    .sub{color:#64748b;font-size:14px;margin-bottom:36px}
    .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:32px;margin-bottom:24px}
    h2{font-size:17px;font-weight:700;color:#1e3a5f;margin-bottom:12px}
    p,li{font-size:14px;color:#475569;line-height:1.7;margin-bottom:8px}
    ul{padding-left:20px}
    .footer{text-align:center;color:#94a3b8;font-size:13px;margin-top:40px}
    a{color:#2d6a9f}
  </style>
</head>
<body>
<div class="container">
  <div class="logo">
    <div class="logo-icon">A&amp;F</div>
    <span style="font-size:20px;font-weight:700;color:#1e3a5f">A&amp;F Soluções Financeiras</span>
  </div>
  <h1>Política de Privacidade</h1>
  <p class="sub">Última atualização: maio de 2026</p>

  <div class="card">
    <h2>1. Quem somos</h2>
    <p>A <strong>A&amp;F Soluções Financeiras</strong> é especializada em crédito imobiliário e financiamentos. Esta política descreve como coletamos, usamos e protegemos seus dados em conformidade com a LGPD (Lei nº 13.709/2018).</p>
    <p>Contato: <a href="mailto:credimobcc@gmail.com">credimobcc@gmail.com</a></p>
  </div>

  <div class="card">
    <h2>2. Dados coletados</h2>
    <ul>
      <li>Nome completo e CPF</li>
      <li>Número de telefone e e-mail</li>
      <li>Data de nascimento e renda mensal</li>
      <li>Informações sobre imóvel de interesse</li>
      <li>Mensagens trocadas via WhatsApp e outros canais</li>
    </ul>
  </div>

  <div class="card">
    <h2>3. Finalidade</h2>
    <ul>
      <li>Análise de crédito e viabilidade de financiamento</li>
      <li>Comunicação sobre propostas e negociações</li>
      <li>Cumprimento de obrigações legais e regulatórias</li>
    </ul>
  </div>

  <div class="card">
    <h2>4. Compartilhamento</h2>
    <p>Não vendemos seus dados. Compartilhamos apenas com instituições financeiras parceiras (para análise de crédito), órgãos reguladores (quando exigido por lei) e parceiros de tecnologia sob contrato de confidencialidade.</p>
  </div>

  <div class="card">
    <h2>5. Segurança</h2>
    <p>Dados armazenados em servidores seguros com criptografia. Adotamos medidas técnicas para proteger suas informações contra acesso não autorizado.</p>
  </div>

  <div class="card">
    <h2>6. Seus direitos (LGPD)</h2>
    <ul>
      <li>Acessar, corrigir ou excluir seus dados</li>
      <li>Revogar consentimento a qualquer momento</li>
      <li>Solicitar portabilidade dos dados</li>
    </ul>
    <p style="margin-top:10px">Contato: <a href="mailto:credimobcc@gmail.com">credimobcc@gmail.com</a></p>
  </div>

  <div class="card">
    <h2>7. WhatsApp Business API</h2>
    <p>Utilizamos a API oficial do WhatsApp Business (Meta) para comunicação. As mensagens seguem as políticas da Meta disponíveis em <a href="https://www.whatsapp.com/legal/privacy-policy" target="_blank">whatsapp.com/legal</a>.</p>
  </div>

  <div class="footer">
    <p>&copy; 2026 A&amp;F Soluções Financeiras. Todos os direitos reservados.</p>
  </div>
</div>
</body>
</html>`);
});

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

  // Válvula de segurança do disco: arquiva no Drive só os anexos com 30+ dias,
  // numa pasta técnica separada — nunca mexe na organização manual do usuário.
  // Primeira rodada 10min após o boot (não compete com a restauração de sessões
  // acima); depois repete a cada 6h. Nunca derruba o processo se falhar.
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  setTimeout(() => {
    archiveOldAttachmentsAllAccounts().catch((err) => console.error('[Drive] Arquivamento automático (boot):', err?.message));
    generateRecurringTransactions().catch((err) => console.error('[Financeiro] Lançamentos fixos (boot):', err?.message));
    setInterval(() => {
      archiveOldAttachmentsAllAccounts().catch((err) => console.error('[Drive] Arquivamento automático:', err?.message));
      generateRecurringTransactions().catch((err) => console.error('[Financeiro] Lançamentos fixos:', err?.message));
    }, SIX_HOURS);
  }, 10 * 60 * 1000);
});
