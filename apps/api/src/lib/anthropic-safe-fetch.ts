/** A API da Anthropic recusa (HTTP 400 "unexpected end of hex escape") o corpo com "metade de emoji" — um .slice(0, N) que corta um par substituto
 *  (😀 = 😀) deixa só \ud83d no JSON. Cada serviço que mandava histórico de conversa cortado caía nisso e a função devolvia null em silêncio
 *  (conferência de documentos da Maria Antônia nunca avaliava, 15/10/2026). Em vez de caçar cada slice, tira os substitutos soltos de TODO corpo enviado
 *  pra api.anthropic.com. */
const LONE_HIGH = /\\u[dD][89abAB][0-9a-fA-F]{2}(?!\\u[dD][c-fC-F][0-9a-fA-F]{2})/g;
const LONE_LOW = /(?<!\\u[dD][89abAB][0-9a-fA-F]{2})\\u[dD][c-fC-F][0-9a-fA-F]{2}/g;

export function stripLoneSurrogates(json: string): string {
  return json.replace(LONE_HIGH, '').replace(LONE_LOW, '');
}

export function installAnthropicSafeFetch(): void {
  const original = globalThis.fetch;
  if (!original || (original as any).__anthropicSafe) return;
  const wrapped = ((input: any, init?: any) => {
    try {
      const url = typeof input === 'string' ? input : input?.url || String(input);
      if (url.includes('api.anthropic.com') && init && typeof init.body === 'string') init = { ...init, body: stripLoneSurrogates(init.body) };
    } catch { /* se algo estranho, manda como veio */ }
    return original(input, init);
  }) as typeof fetch;
  (wrapped as any).__anthropicSafe = true;
  globalThis.fetch = wrapped;
}
