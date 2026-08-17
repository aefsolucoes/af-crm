// Ponte com o Chrome DevTools Protocol via chrome.debugger — é como a
// extensão "vê" (screenshot) e "age" (clique/digitação) na aba real do
// usuário. Anexar o debugger faz o Chrome mostrar a faixa amarela "uma
// extensão está depurando esta aba" — isso é esperado e intencional (dá
// transparência de que algo está automatizando aquela aba).
const CDP_VERSION = '1.3';
const attachedTabs = new Set<number>();

function sendCommand<T = unknown>(
  tabId: number,
  method: string,
  params?: Record<string, unknown>
): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(result as T);
    });
  });
}

async function ensureAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return;
  await new Promise<void>((resolve, reject) => {
    chrome.debugger.attach({ tabId }, CDP_VERSION, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
  attachedTabs.add(tabId);
}

// Se o usuário fechar a faixa amarela manualmente (ou fechar a aba), o Chrome
// desanexa sozinho — atualiza o registro pra não achar que ainda está anexado.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) attachedTabs.delete(source.tabId);
});

export async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
