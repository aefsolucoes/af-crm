/** Nome de cliente (Lead/Contact) sempre em CAIXA ALTA, não importa como
 *  chegou — digitado num formulário, perfil do WhatsApp, cartão de contato
 *  compartilhado, importação de CSV, ou ferramenta do assistente de IA.
 *  Regra pedida pra manter os cards padronizados, mesmo que o colaborador
 *  (ou o cliente, via WhatsApp) escreva em caixa baixa/mista. */
export function normalizeClientName(name: string): string {
  return name.trim().toUpperCase();
}

/** Nome que dá pra usar pra chamar o cliente: só letras (com acento),
 *  espaço, apóstrofo, hífen e ponto. Com número, %, emoji, "_" e afins não é
 *  nome de verdade (perfil do WhatsApp, telefone) — aí não chama pelo nome
 *  (Fabio 08/10: a IA chamou um cliente de "53999257733"). */
export function isCallableName(raw: unknown): boolean {
  const s = String(raw ?? '').trim();
  if (!s || /[^\p{L}\s'.-]/u.test(s)) return false;
  return s.split(/\s+/)[0].replace(/[.'-]/g, '').length >= 2;
}

/** Primeiro nome (Capitalizado) do primeiro candidato que é nome de verdade; null se nenhum é. */
export function callableFirstName(...raws: unknown[]): string | null {
  for (const raw of raws) {
    if (!isCallableName(raw)) continue;
    const w = String(raw).trim().split(/\s+/)[0];
    return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  }
  return null;
}
