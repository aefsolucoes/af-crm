/* Comissão da A&F por produto (Fabio 28/10: "comissão de financiamento hab é de 1% e de home equity é de 5%"). O produto é o setor
 * do funil do card. Setor sem regra (ex.: Consórcio) cai em 1% — o valor é sempre editável antes de lançar. */
export function commissionRatePct(departmentName?: string | null): number {
  return /home equity/i.test(departmentName || '') ? 5 : 1;
}

/** Comissão arredondada em centavos. */
export function commissionAmount(baseAmount: number, ratePct: number): number {
  return Math.round(baseAmount * ratePct) / 100;
}

/** Valor do crédito vindo do card: aceita "500000" (normalizado pelo front) e "356.424,37" (digitado em formato BR). */
export function parseCreditValue(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  const s = String(raw ?? '').replace(/[^\d,.-]/g, '');
  if (!s) return 0;
  if (s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
  return parseFloat(s) || 0;
}
