/**
 * Opções da aprovação da Creditas (Fabio 14/11): o portal mostra várias "Proposta N" aprovadas (pós ou pré-fixada, prazo solicitado/maior/menor, maior valor/menor parcela).
 * A extensão lê TODAS e manda pro CRM; quem ESCOLHE é o CRM, pelo pedido do card. Funções puras (testáveis) — o uso fica em credit-analysis.service.ts.
 *
 * Regra (Fabio 14/11, Robson):
 *  1. Só pós-fixada (IPCA). Sem nenhuma pós-fixada, vale a pré-fixada pelo mesmo critério.
 *  2. No prazo solicitado (selo "Prazo solicitado"); sem esse selo, a(s) de maior prazo.
 *  3. Alguma cobre o valor pedido (líquido ≥ pedido)? → entre as que cobrem, a de MENOR parcela (= a do tamanho do pedido).
 *     Nenhuma cobre (o banco aprovou menos) → a de MAIOR valor líquido.
 *     Sem pedido no card → a de menor parcela.
 *  Empate: parcelas a menos de 1% uma da outra contam como a MESMA parcela → vale a de maior valor líquido (menor taxa).
 *  Robson: P4 R$ 2.817,96 / P3 R$ 2.819,73 / P5 R$ 2.820,57 (todas abaixo de 2.817,96 + 1%) → P5, R$ 9 mil a mais e 1,70% em vez de 1,83%.
 *  A equipe pode trocar ("Seguir com esta"): a troca fica guardada no card e vale nas próximas conferências.
 */
export interface OpcaoCreditas {
  n: number | null; // "Proposta N" do portal
  selos: string[]; // Pós-fixado, Prazo solicitado, Maior valor, Menor parcela…
  credito: number | null; // crédito aprovado (bruto)
  liquido: number | null; // valor líquido do contrato (o que o cliente recebe)
  parcela: number | null; // 1ª parcela
  prazo: number | null; // meses
  taxa: string | null; // "1,70% a.m. + IPCA"
  indexer: string | null; // IPCA quando pós-fixada
  pos: boolean; // pós-fixada (IPCA)
  texto: string; // resumo legível ("Creditas (opção …): crédito aprovado R$ …; …")
  escolhida?: boolean;
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const t = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (!t) return null;
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : (/\.\d{3}$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** O que vem da extensão (ou do banco) → lista limpa. Aceita os números como texto ("R$ 146.786,61") ou número. */
export function limparOpcoes(input: unknown): OpcaoCreditas[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 12).map((o: any) => {
    const selos = (Array.isArray(o?.selos) ? o.selos : []).map((s: unknown) => String(s || '').trim().slice(0, 40)).filter(Boolean).slice(0, 8);
    const taxa = o?.taxa ?? o?.rate;
    const indexer = o?.indexer ? String(o.indexer).slice(0, 20) : /ipca/i.test(String(taxa || '')) ? 'IPCA' : null;
    const posSelo = selos.some((s: string) => /p[oó]s-?fixad/i.test(s));
    const preSelo = selos.some((s: string) => /pr[eé]-?fixad/i.test(s));
    return {
      n: num(o?.n),
      selos,
      credito: num(o?.credito ?? o?.approvedValue),
      liquido: num(o?.liquido ?? o?.netValue),
      parcela: num(o?.parcela ?? o?.firstInstallment),
      prazo: (() => { const p = num(o?.prazo ?? o?.termMonths); return p ? Math.round(p) : null; })(),
      taxa: taxa ? String(taxa).slice(0, 80) : null,
      indexer,
      pos: typeof o?.pos === 'boolean' ? o.pos && !preSelo : !preSelo && (posSelo || indexer === 'IPCA'),
      texto: String(o?.texto ?? o?.conditions ?? '').slice(0, 1200),
      ...(o?.escolhida ? { escolhida: true } : {}),
    } as OpcaoCreditas;
  }).filter((o) => o.parcela && (o.liquido || o.credito));
}

const valorDe = (o: OpcaoCreditas) => o.liquido || o.credito || 0;
const temSelo = (o: OpcaoCreditas, re: RegExp) => o.selos.some((s) => re.test(norm(s)));
const brl = (n: number | null) => (n == null ? '' : `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** Menor parcela com empate de 1% → maior valor líquido. */
function menorParcela(grupo: OpcaoCreditas[]): { o: OpcaoCreditas; empate: number } {
  const min = Math.min(...grupo.map((o) => o.parcela || Infinity));
  const empatadas = grupo.filter((o) => (o.parcela || Infinity) <= min * 1.01);
  const o = empatadas.slice().sort((a, b) => valorDe(b) - valorDe(a) || (a.parcela || 0) - (b.parcela || 0))[0];
  return { o, empate: empatadas.length };
}

/** Rótulo curto da opção pra tela/nota: "P5 · Prazo solicitado + Maior valor". */
export function rotuloOpcao(o: OpcaoCreditas): string {
  const selos = o.selos.filter((s) => !/fixad/i.test(s)).join(' + ');
  return `${o.n ? `P${o.n}` : 'Opção'}${selos ? ` · ${selos}` : ''}`;
}

/**
 * Escolhe a opção pelo pedido do card. `preferida` = a que a equipe escolheu antes ("Seguir com esta") — se ainda existir (mesmo nº e prazo), vale ela.
 * Devolve o índice na lista e o critério em português (vai pro detalhe da análise). null = lista vazia.
 */
export function escolherOpcaoCreditas(ops: OpcaoCreditas[], pedido?: number | null, preferida?: { n?: number | null; prazo?: number | null } | null): { i: number; criterio: string } | null {
  if (!ops.length) return null;
  if (preferida && preferida.n) {
    const i = ops.findIndex((o) => o.n === preferida.n && (!preferida.prazo || o.prazo === preferida.prazo));
    if (i >= 0) return { i, criterio: 'a que a equipe escolheu ("Seguir com esta")' };
  }
  const pos = ops.filter((o) => o.pos);
  const base = pos.length ? pos : ops;
  const ps = base.filter((o) => temSelo(o, /prazo solicitado/));
  const maxPrazo = Math.max(...base.map((o) => o.prazo || 0));
  const grupo = ps.length ? ps : base.filter((o) => (o.prazo || 0) === maxPrazo);
  const passos = [pos.length ? 'pós-fixada' : 'sem pós-fixada, ficou a pré-fixada', ps.length ? 'prazo solicitado' : `maior prazo (${maxPrazo} meses)`];
  let alvo: OpcaoCreditas;
  const p = Number(pedido) > 0 ? Number(pedido) : 0;
  if (p) {
    const cobrem = grupo.filter((o) => valorDe(o) >= p * 0.99);
    if (cobrem.length) {
      const r = menorParcela(cobrem);
      alvo = r.o;
      passos.push(`cobre o pedido de ${brl(p)} → menor parcela${r.empate > 1 ? ` (${r.empate} com parcela igual → maior valor)` : ''}`);
    } else {
      const maior = Math.max(...grupo.map(valorDe));
      const iguais = grupo.filter((o) => valorDe(o) === maior);
      alvo = iguais.sort((a, b) => (a.parcela || 0) - (b.parcela || 0))[0];
      passos.push(`nenhuma cobre o pedido de ${brl(p)} → maior valor`);
    }
  } else {
    const r = menorParcela(grupo);
    alvo = r.o;
    passos.push(`menor parcela${r.empate > 1 ? ` (${r.empate} com parcela igual → maior valor)` : ''}`);
  }
  return { i: ops.indexOf(alvo), criterio: passos.join(' → ') };
}

/** Menor valor (líquido, ou bruto) entre TODAS as opções — a trava de "outra proposta do mesmo CPF" usa este: se nem a menor opção chega perto do pedido, não é deste card. */
export function menorValorDasOpcoes(ops: OpcaoCreditas[]): number | null {
  const v = ops.map(valorDe).filter((x) => x > 0);
  return v.length ? Math.min(...v) : null;
}

/** Os números da análise a partir da opção escolhida (mesmos campos do resultado da extensão). */
export function numerosDaOpcao(o: OpcaoCreditas) {
  return {
    approvedValue: o.credito,
    netValue: o.liquido,
    termMonths: o.prazo,
    rate: o.taxa,
    indexer: o.indexer,
    firstInstallment: o.parcela,
    conditions: o.texto || null,
  };
}

/** Troca o trecho "CONDIÇÕES — …" do detalhe pela opção escolhida + o critério. */
export function detalheComOpcao(detail: string | null | undefined, o: OpcaoCreditas, criterio: string, total: number): string {
  const base = String(detail || '');
  const k = base.indexOf('CONDIÇÕES — ');
  const cabeca = k >= 0 ? base.slice(0, k) : `${base}${base ? ' — ' : ''}`;
  return `${cabeca}CONDIÇÕES — ${o.texto || rotuloOpcao(o)}. Escolha da opção (${total} no portal): ${criterio}`;
}

/** Linha pra IA da conversa: as opções que o portal aprovou, marcando a escolhida (sem passar valores ao cliente — a regra está no contexto). */
export function opcoesParaIa(ops: OpcaoCreditas[]): string {
  return ops.map((o) => `${o.escolhida ? '[ESCOLHIDA] ' : ''}${rotuloOpcao(o)} (${o.pos ? 'pós-fixada' : 'pré-fixada'}): líquido ${brl(o.liquido)}, ${o.prazo} meses, 1ª parcela ${brl(o.parcela)}, ${o.taxa || ''}`).join('; ');
}
