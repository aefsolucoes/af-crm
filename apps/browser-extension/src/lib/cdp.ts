// Ponte com o Chrome DevTools Protocol via chrome.debugger — é como a
// extensão "vê" (screenshot) e "age" (clique/digitação) na aba real do
// usuário. Anexar o debugger faz o Chrome mostrar a faixa amarela "uma
// extensão está depurando esta aba" — isso é esperado e intencional (dá
// transparência de que algo está automatizando aquela aba).
const CDP_VERSION = '1.3';
const attachedTabs = new Set<number>();

// Sem isso, um chrome.debugger.attach/sendCommand que nunca chama o callback
// (ex.: aba que não aceita debugger) trava o comando pra sempre — o único
// sintoma lá fora era "Extensão não respondeu a tempo" sem dizer POR QUE.
// Com o timeout aqui dentro, a extensão mesma detecta e devolve um erro
// específico bem mais rápido que os 15s do lado do servidor.
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
  if (attachedTabs.has(tabId)) {
    console.log(`[Agente de Navegador] debugger já anexado na aba ${tabId}`);
    return;
  }
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
}

// Se o usuário fechar a faixa amarela manualmente (ou fechar a aba), o Chrome
// desanexa sozinho — atualiza o registro pra não achar que ainda está anexado.
chrome.debugger.onDetach.addListener((source, reason) => {
  console.log(`[Agente de Navegador] debugger desanexado da aba ${source.tabId}: ${reason}`);
  if (source.tabId != null) attachedTabs.delete(source.tabId);
});

export async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  console.log('[Agente de Navegador] aba ativa:', tab ? `#${tab.id} ${tab.url}` : 'NENHUMA');
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
// simples e confiável pra Fase 0. Limitação conhecida: alguns componentes
// controlados por JS que dependem de eventos de teclado (keydown/keyup) podem
// não reagir a isso; se aparecer esse caso na Fase 3 (ONR), trocamos por
// Input.dispatchKeyEvent por caractere.
export async function typeText(tabId: number, text: string): Promise<void> {
  await ensureAttached(tabId);
  await sendCommand(tabId, 'Input.insertText', { text });
}
