// Service worker (MV3) — o "corpo" da extensão. Conecta no mesmo socket.io do
// CRM (apps/api/src/websocket/index.ts), se identifica como clientType:
// 'extension', e executa os comandos que a API relaya (agent_command) na aba
// ativa via CDP (apps/browser-extension/src/lib/cdp.ts). Fase 0: comandos são
// disparados manualmente pela API (rotas de teste) — nenhuma decisão de IA
// ainda passa por aqui, só o cano de execução.
import { io, Socket } from 'socket.io-client';
import { API_URL } from '../lib/config';
import { getStoredAuth, refreshAccessToken } from '../lib/api';
import { getActiveTab, screenshot, click, typeText } from '../lib/cdp';

let socket: Socket | null = null;

type AgentCommand =
  | { type: 'screenshot' }
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string };

async function executeCommand(cmd: AgentCommand): Promise<Record<string, unknown>> {
  const tab = await getActiveTab();
  if (!tab?.id) return { error: 'Nenhuma aba ativa encontrada' };
  try {
    if (cmd.type === 'screenshot') {
      const data = await screenshot(tab.id);
      return { ok: true, screenshot: data };
    }
    if (cmd.type === 'click') {
      await click(tab.id, cmd.x, cmd.y);
      const data = await screenshot(tab.id);
      return { ok: true, screenshot: data };
    }
    if (cmd.type === 'type') {
      await typeText(tab.id, cmd.text);
      const data = await screenshot(tab.id);
      return { ok: true, screenshot: data };
    }
    return { error: `Comando desconhecido: ${(cmd as { type: string }).type}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function connectSocket() {
  const auth = await getStoredAuth();
  if (!auth) {
    socket?.disconnect();
    socket = null;
    return;
  }

  if (socket) socket.disconnect();

  socket = io(API_URL, {
    autoConnect: true,
    // Service worker (MV3) não tem XMLHttpRequest — só fetch/WebSocket. O
    // transporte padrão do socket.io-client tenta "polling" primeiro (usa
    // XHR por baixo) e só depois sobe pra WebSocket; sem XHR, isso falha
    // direto com "xhr poll error" e nunca chega a tentar WebSocket. Forçando
    // websocket como único transporte, pula o polling inteiro.
    transports: ['websocket'],
    // Função (não objeto): reavalia o token guardado a cada tentativa de
    // conexão — importante porque o access token expira em 1h e é renovado
    // à parte (ver 'connect_error' abaixo).
    auth: async (cb) => {
      const current = await getStoredAuth();
      cb({ token: current?.accessToken, clientType: 'extension' });
    },
  });

  socket.on('connect', () => {
    console.log('[Agente de Navegador] conectado ao CRM:', socket?.id);
  });

  socket.on('disconnect', (reason) => {
    console.log('[Agente de Navegador] desconectado:', reason);
  });

  // Token expirado (access token dura só 1h) — tenta renovar com o refresh
  // token e reconecta. Se o refresh também falhar, o socket fica sem
  // reconectar sozinho até o usuário logar de novo pelo popup.
  socket.on('connect_error', async (err) => {
    console.warn('[Agente de Navegador] erro de conexão:', err.message);
    const newToken = await refreshAccessToken();
    if (newToken) socket?.connect();
  });

  socket.on('agent_command', async (payload: AgentCommand, ack: (result: unknown) => void) => {
    const result = await executeCommand(payload);
    ack(result);
  });
}

// Popup pede status / avisa que o login mudou.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'AUTH_UPDATED') {
    connectSocket().then(() => sendResponse({ ok: true }));
    return true; // resposta assíncrona
  }
  if (message?.type === 'GET_STATUS') {
    getStoredAuth().then((auth) => {
      sendResponse({ user: auth?.user ?? null, connected: !!socket?.connected });
    });
    return true;
  }
  return false;
});

// Reconecta sozinho quando o Chrome reinicia o service worker (MV3 derruba o
// worker depois de ~30s ocioso; ao acordar de novo por um evento, refaz a
// conexão se já havia login salvo).
connectSocket();
