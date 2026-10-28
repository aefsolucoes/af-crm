/* Comissão da A&F (Fabio 28/10). Home Equity é pelo BANCO da proposta que o cliente segue: "o Creditas e Inter é 5%, Santander é 2,5%".
 * Sem banco (ou Financiamento pelo Credimorar, CREDIMORAR_FH): pelo produto — o setor do funil do card: Financiamento Habitacional 1%, Home Equity 5%.
 * Setor sem regra (ex.: Consórcio) cai em 1% — o valor é sempre editável antes de lançar. */
const TAXA_POR_BANCO: Record<string, number> = { INTER: 5, CREDITAS: 5, CREDIMORAR: 2.5 };
export function commissionRatePct(departmentName?: string | null, bank?: string | null): number {
  if (bank && bank in TAXA_POR_BANCO) return TAXA_POR_BANCO[bank];
  return /home equity/i.test(departmentName || '') ? 5 : 1;
}

/** Proposta que o cliente segue: a escolhida (⭐) ou, sem escolha, a mais recente do ÚNICO banco que aprovou (mesma regra da Vistoria). `rows` da mais nova pra mais antiga. */
export function propostaSeguida<T extends { bank: string; chosen?: boolean | null }>(rows: T[]): T | null {
  const chosen = rows.find((r) => r.chosen);
  if (chosen) return chosen;
  return new Set(rows.map((r) => r.bank)).size === 1 ? rows[0] : null;
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
