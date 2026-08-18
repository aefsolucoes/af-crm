// Ponte com o Chrome DevTools Protocol via chrome.debugger — é como a
// extensão "vê" (screenshot) e "age" (clique/digitação/navegação) na aba real
// do usuário. Anexar o debugger faz o Chrome mostrar a faixa amarela "uma
// extensão está depurando esta aba" — isso é esperado e intencional (dá
// transparência de que algo está automatizando aquela aba).
const CDP_VERSION = '1.3';
const attachedTabs = new Set<number>();

// Precisa bater com VIEWPORT em apps/api/src/services/browser-agent.service.ts
// — as coordenadas x,y que o Claude decide são relativas ao tamanho da
// screenshot, então o viewport real da aba tem que ser SEMPRE esse mesmo
// tamanho, senão um clique em (400,300) cai num lugar diferente do que a IA
// via na imagem.
const VIEWPORT = { width: 1280, height: 800 };

// Sem isso, um chrome.debugger.attach/sendCommand que nunca chama o callback
// (ex.: aba que não aceita debugger) trava o comando pra sempre — o único
// sintoma lá fora era "Extensão não respondeu a tempo" sem dizer POR QUE.
// Com o timeout aqui dentro, a extensão mesma detecta e devolve um erro
// específico bem mais rápido que os 20s do lado do servidor.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout (${ms}ms) em: ${label}`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

function sendCommand<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>
): Promise<T> {
  console.log(`[Agente de Navegador] CDP ${method}`, params ?? '');
  const p = new Promise<T>((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result as T);
    });
  });
  return withTimeout(p, 8000, `sendCommand ${method}`);
}

async function ensureAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  console.log(`[Agente de Navegador] anexando debugger na aba ${tabId}...`);
  const p = new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
  await withTimeout(p, 8000, 'chrome.debugger.attach');
  attachedTabs.add(tabId);
  console.log(`[Agente de Navegador] debugger anexado na aba ${tabId}`);
  // Fixa o tamanho da viewport logo depois de anexar — garante que toda
  // screenshot daqui pra frente tem o MESMO tamanho que o Claude espera.
  try {
    await sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  } catch (err) {
    console.warn('[Agente de Navegador] não consegui fixar o viewport:', err);
  }
}

// Se o usuário fechar a faixa amarela manualmente (ou fechar a aba), o Chrome
// desanexa sozinho — atualiza o registro pra não achar que ainda está anexado.
chrome.debugger.onDetach.addListener((source, reason) => {
  console.log(`[Agente de Navegador] debugger desanexado da aba ${source.tabId}: ${reason}`);
  if (source.tabId != null) attachedTabs.delete(source.tabId);
});

const AGENT_TAB_KEY = 'agentTabId';

// Aba PRÓPRIA do agente — nunca a "aba ativa no momento". Antes disso usava
// chrome.tabs.query({active:true}), que pegava QUALQUER aba que o usuário
// estivesse olhando — na prática, quase sempre a própria aba do CRM (onde a
// pessoa está acompanhando a tarefa), fazendo o agente "sequestrar" a tela do
// CRM e navegar ela pra fora. Agora ele cria (ou reaproveita) uma aba dele
// mesmo, aberta em SEGUNDO PLANO (active:false) — não tira o foco de onde o
// usuário está. Guardado em chrome.storage.session (não uma variável comum)
// pra sobreviver se o service worker for suspenso/reiniciado no meio da tarefa.
export async function getOrCreateAgentTab(): Promise<chrome.tabs.Tab> {
  const stored = await chrome.storage.session.get(AGENT_TAB_KEY);
  const existingId = stored[AGENT_TAB_KEY] as number | undefined;
  if (existingId) {
    try {
      const tab = await chrome.tabs.get(existingId);
      if (tab?.id) {
        console.log(`[Agente de Navegador] reaproveitando aba própria #${tab.id}`);
        return tab;
      }
    } catch {
      console.log('[Agente de Navegador] aba própria anterior não existe mais, criando uma nova');
    }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  await chrome.storage.session.set({ [AGENT_TAB_KEY]: tab.id });
  console.log(`[Agente de Navegador] aba própria criada: #${tab.id}`);
  return tab;
}

export async function screenshot(tabId: number): Promise<string> {
  await ensureAttached(tabId);
  const { data } = await sendCommand<{ data: string }>(tabId, 'Page.captureScreenshot', { format: 'png' });
  return data; // base64 PNG, sem o prefixo "data:image/png;base64,"
}

export async function click(tabId: number, x: number, y: number): Promise<void> {
  await ensureAttached(tabId);
  const base = { x, y, button: 'left' as const, clickCount: 1 };
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
}

// Insere texto direto no elemento focado (não simula tecla por tecla) — mais
// simples e confiável pra Fase 0/1. Limitação conhecida: alguns componentes
// controlados por JS que dependem de eventos de teclado (keydown/keyup) podem
// não reagir a isso; se aparecer esse caso na Fase 3 (ONR), trocamos por
// Input.dispatchKeyEvent por caractere.
export async function typeText(tabId: number, text: string): Promise<void> {
  await ensureAttached(tabId);
  await sendCommand(tabId, 'Input.insertText', { text });
}

export async function navigate(tabId: number, url: string): Promise<void> {
  await ensureAttached(tabId);
  await sendCommand(tabId, 'Page.navigate', { url });
  // Dá um tempo pra página carregar antes do caller tirar a screenshot —
  // sem isso, a primeira imagem que a IA vê é a página ainda em branco.
  // Pra páginas mais lentas que isso, a IA tem a ferramenta browser_wait.
  await new Promise((resolve) => setTimeout(resolve, 1200));
}

export async function scroll(tabId: number, direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void> {
  await ensureAttached(tabId);
  let deltaX = 0;
  let deltaY = 0;
  if (direction === 'down') deltaY = amount;
  else if (direction === 'up') deltaY = -amount;
  else if (direction === 'right') deltaX = amount;
  else deltaX = -amount;
  await sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: VIEWPORT.width / 2,
    y: VIEWPORT.height / 2,
    deltaX,
    deltaY,
  });
}

// Conjunto pequeno de teclas especiais suficiente pra Fase 1 — se precisar de
// mais no futuro (ex.: teclas com modificador), estender esta tabela.
const KEY_MAP: Record<string, { keyCode: number; code: string }> = {
  Enter: { keyCode: 13, code: 'Enter' },
  Tab: { keyCode: 9, code: 'Tab' },
  Escape: { keyCode: 27, code: 'Escape' },
  Backspace: { keyCode: 8, code: 'Backspace' },
  ArrowUp: { keyCode: 38, code: 'ArrowUp' },
  ArrowDown: { keyCode: 40, code: 'ArrowDown' },
  ArrowLeft: { keyCode: 37, code: 'ArrowLeft' },
  ArrowRight: { keyCode: 39, code: 'ArrowRight' },
};

export async function pressKey(tabId: number, key: string): Promise<void> {
  await ensureAttached(tabId);
  const mapped = KEY_MAP[key];
  if (!mapped) throw new Error(`Tecla não suportada: ${key}`);
  const base = {
    key,
    code: mapped.code,
    windowsVirtualKeyCode: mapped.keyCode,
    nativeVirtualKeyCode: mapped.keyCode,
  };
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
