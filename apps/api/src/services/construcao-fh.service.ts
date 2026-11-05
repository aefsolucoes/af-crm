/** CONSTRUÇÃO NO FINANCIAMENTO HABITACIONAL (Fabio 05/11, Cleide: "é construção; para financiamento de construção é somente a CAIXA e para financiamento acima de 200 mil").
 *  Compra de terreno/lote + obra, ou construção em terreno próprio: só pela CAIXA e só com valor FINANCIADO acima de R$ 200 mil — abaixo disso a A&F não faz em nenhum banco.
 *  Credimorar (Bradesco/Santander), Inter e Itaú do FH não rodam nesses casos (nem sozinhos nem pelo botão). Puras (testáveis). */

export const CONSTRUCAO_MIN_FINANCIADO = 200_000;

const sem = (t: unknown) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const CONSTRUCAO_RX = /\b(terreno|lote|construc\w*|construir|obra)\b/; // texto já sem acento
const brNum = (v: unknown) => { const s = String(v ?? '').replace(/[^\d.,]/g, ''); const n = Number(/,\d{1,2}$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s.replace(/[.,](?=\d{3}\b)/g, '')); return Number.isFinite(n) ? n : 0; };

/** A proposta (ou o card) é de construção? Olha o tipo do imóvel / finalidade / modalidade da proposta e os campos do card. */
export function ehConstrucaoFh(proposta: string, cf: Record<string, any> = {}): boolean {
  for (const linha of String(proposta || '').replace(/[*_]/g, '').split('\n')) {
    const m = /^\s*(tipo( de| do)? im[oó]vel|tipo|finalidade|modalidade|objetivo|opera[cç][aã]o)\s*:\s*(.+)$/i.exec(linha);
    if (m && CONSTRUCAO_RX.test(sem(m[3]))) return true;
  }
  return [cf.finalidade, cf.imovel_tipo, cf.tipo_imovel, cf.modalidade].some((v) => v && CONSTRUCAO_RX.test(sem(v)));
}

/** Valor financiado da proposta: "Valor financiado", senão o card (valor_credito), senão imóvel − entrada. */
export function financiadoFh(proposta: string, cf: Record<string, any> = {}): number {
  const txt = String(proposta || '').replace(/[*_]/g, '');
  const pega = (rx: RegExp) => brNum(rx.exec(txt)?.[1]);
  const direto = pega(/valor financiado\s*:\s*([^\n]+)/i) || brNum(cf.valor_credito);
  if (direto > 0) return direto;
  const imovel = pega(/valor (?:de compra e venda|do im[oó]vel)\s*:\s*([^\n]+)/i) || brNum(cf.valor_imovel);
  const entrada = pega(/(?:valor de )?entrada(?: \/ fgts)?\s*:\s*([^\n]+)/i) || brNum(cf.valor_entrada);
  return imovel > 0 ? Math.max(0, imovel - entrada) : 0;
}

const brl = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Anotação/aviso pra equipe quando a proposta é de construção. */
export function textoConstrucao(financiado: number): string {
  return financiado > CONSTRUCAO_MIN_FINANCIADO
    ? `🏗️ Proposta de CONSTRUÇÃO (terreno/lote + obra): no Financiamento, construção é só pela CAIXA (regra da A&F). Não rodei Credimorar (Bradesco/Santander), Inter nem Itaú. Financiado: ${brl(financiado)} — para seguir, use "Análise CAIXA" no card.`
    : `🏗️ Proposta de CONSTRUÇÃO (terreno/lote + obra) com financiado de ${financiado > 0 ? brl(financiado) : 'valor não informado'}: construção só pela CAIXA e com financiado acima de ${brl(CONSTRUCAO_MIN_FINANCIADO)} — abaixo disso a A&F não faz em nenhum banco. Não rodei nenhum banco.`;
}
