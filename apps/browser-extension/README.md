# Agente de Navegador — extensão Chrome (Fase 0)

Esqueleto sem IA ainda: prova que o cano existe (extensão ⇄ API ⇄ Chrome real
via CDP). Quem decide "qual ação" nesta fase é você, testando com `curl`
contra as rotas de teste — o loop de decisão do Claude entra na Fase 1.

## Rodar em modo desenvolvedor

```bash
npm install --workspace=apps/browser-extension   # (ou na raiz do monorepo, hoisted)
npm run build --workspace=apps/browser-extension
```

Isso gera `apps/browser-extension/dist/`. No Chrome:

1. `chrome://extensions`
2. Ativar "Modo do desenvolvedor" (canto superior direito)
3. "Carregar sem compactação" → selecionar a pasta `apps/browser-extension/dist`
4. Clicar no ícone da extensão (puzzle piece → fixar) → abre o popup → logar com a mesma conta do CRM

Depois de qualquer mudança no código, rode `npm run build` de novo e clique no
botão de recarregar (↻) do card da extensão em `chrome://extensions`.

## Testar manualmente (sem IA)

Com a extensão logada e uma aba qualquer ativa, comande pela API (usando seu
próprio token do CRM, `Authorization: Bearer <access token>`):

```bash
curl -X POST https://af-crm-production.up.railway.app/api/browser-agent/test/screenshot \
  -H "Authorization: Bearer $TOKEN"

curl -X POST https://af-crm-production.up.railway.app/api/browser-agent/test/click \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"x": 100, "y": 200}'

curl -X POST https://af-crm-production.up.railway.app/api/browser-agent/test/type \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text": "teste"}'
```

Cada resposta traz `{ok: true, screenshot: "<base64 PNG>"}` — dá pra colar o
base64 num conversor online pra ver a tela capturada.

Ao anexar o `chrome.debugger`, o Chrome mostra uma faixa amarela avisando que
a aba está sendo controlada por uma extensão — isso é esperado.

## Permissão necessária

Só usuários com a permissão `browser_agent` conseguem chamar as rotas
(`Configurações → Usuários` no CRM). Por padrão só Admin tem.
