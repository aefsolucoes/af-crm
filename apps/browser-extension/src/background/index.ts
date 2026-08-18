// Service worker (MV3) — o "corpo" da extensão. Conecta no mesmo socket.io do
// CRM (apps/api/src/websocket/index.ts), se identifica como clientType:
// 'extension', e executa os comandos que a API relaya (agent_command) numa
// aba PRÓPRIA do agente via CDP (apps/browser-extension/src/lib/cdp.ts) — não
// na aba que o usuário estiver olhando (ex.: o CRM), pra não "sequestrar" a
// tela dele. A partir da Fase 1, quem decide os comandos é o Claude (loop em
// apps/api/src/services/browser-agent.service.ts) — aqui continua sendo só o
// cano de execução.
import { io, Socket } from 'socket.io-client';
import { API_URL } from '../lib/config';
import { getStoredAuth, refreshAccessToken } from '../lib/api';
import { getOrCreateAgentTab, screenshot, click, typeText, navigate, scroll, pressKey } from '../lib/cdp';

let socket: Socket | null = null;

type AgentCommand =
  | { type: 'screenshot' }
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'navigate'; url: string }
  | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount: number }
  | { type: 'key'; key: string }
  | { type: 'wait'; seconds: number };

async function executeCommand(cmd: AgentCommand): Promise<Record<string, unknown>> {
  console.log('[Agente de Navegador] comando recebido:', cmd);
  try {
    const tab = await getOrCreateAgentTab();
    if (!tab?.id) return { error: 'Não consegui abrir/reaproveitar a aba do agente' };
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
    if (cmd.type === 'navigate') {
      await navigate(tab.id, cmd.url);
      const data = await screenshot(tab.id);
      return { ok: true, screenshot: data };
    }
    if (cmd.type === 'scroll') {
      await scroll(tab.id, cmd.direction, cmd.amount);
      const data = await screenshot(tab.id);
      return { ok: true, screenshot: data };
    }
    if (cmd.type === 'key') {
      await pressKey(tab.id, cmd.key);
      const data = await screenshot(tab.id);
      return { ok: true, screenshot: data };
    }
    if (cmd.type === 'wait') {
      await new Promise((resolve) => setTimeout(resolve, Math.min(cmd.seconds, 10) * 1000));
      const data = await screenshot(tab.id);
      return { ok: true, screenshot: data };
    }
    return { error: `Comando desconhecido: ${(cmd as { type: string }).type}` };
  } catch (err) {
    console.error('[Agente de Navegador] erro executando comando:', err);
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
    // Rede de segurança: executeCommand já tem seu próprio try/catch, mas
    // isso aqui garante que o ack() SEMPRE é chamado — sem isso, qualquer
    // erro inesperado (fora do que já é tratado) deixaria o servidor esperando
    // os 15s inteiros pra só então desistir, sem nenhuma pista do motivo.
    try {
      const result = await executeCommand(payload);
      console.log('[Agente de Navegador] respondendo:', result);
      ack(result);
    } catch (err) {
      console.error('[Agente de Navegador] erro inesperado no handler:', err);
      ack({ error: err instanceof Error ? err.message : String(err) });
    }
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

// "Despertador": o Chrome suspende o service worker depois de ~30s sem
// atividade — se isso acontecer bem na hora que o access token (1h) precisa
// renovar, ninguém "acorda" pra fazer isso, e a conexão fica morta até
// alguém abrir o popup manualmente. chrome.alarms É um dos poucos eventos
// garantidos a acordar o worker de novo mesmo suspenso (ao contrário de um
// setInterval comum, que morre junto com o worker). A cada disparo, só
// reconecta se REALMENTE estiver desconectado — não interrompe uma tarefa em
// andamento.
const KEEPALIVE_ALARM = 'agent-keepalive';
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  if (socket?.connected) return;
  console.log('[Agente de Navegador] keep-alive: desconectado, tentando reconectar...');
  connectSocket();
});

// Reconecta sozinho quando o Chrome reinicia o service worker (MV3 derruba o
// worker depois de ~30s ocioso; ao acordar de novo por um evento, refaz a
// conexão se já havia login salvo).
connectSocket();
