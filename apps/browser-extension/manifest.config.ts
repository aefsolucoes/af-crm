import { defineManifest } from '@crxjs/vite-plugin';

// Manifest V3. Fase 0 (esqueleto): login + tirar screenshot + clicar/digitar
// na aba ativa via CDP, comandado manualmente pela API pra provar que o cano
// funciona — ainda sem o Claude decidindo nada.
export default defineManifest({
  manifest_version: 3,
  name: 'AF CRM — Agente de Navegador',
  description: 'A IA do AF CRM controla o Chrome pra automatizar tarefas em sites externos (ex.: emitir certidão no ONR) — sempre com aprovação humana antes de qualquer passo sensível.',
  version: '0.0.1',
  action: {
    default_popup: 'src/popup/index.html',
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  permissions: [
    'debugger', // Chrome DevTools Protocol — screenshot, clique, digitação na aba real
    'tabs', // saber qual é a aba ativa
    'storage', // guardar o token de login (chrome.storage.local)
  ],
  // Precisa poder conversar com a API em qualquer ambiente (produção, local).
  host_permissions: [
    'https://af-crm-production.up.railway.app/*',
    'http://localhost:3001/*',
  ],
});
