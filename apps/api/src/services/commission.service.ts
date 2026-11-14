import { prisma } from '../lib/prisma';

/* Comissão da A&F por banco e produto (Fabio 28/10). A % de alguns bancos depende da PRODUÇÃO MENSAL (soma do crédito do mês com aquele banco
 * naquele produto): a faixa alcançada vale pro mês inteiro. A taxa é sempre editável antes de lançar.
 *  - Home Equity, pelo banco da proposta que o cliente segue:
 *      Inter — contrato de correspondente (Anexo I, Home Equity PF): até R$ 500 mil/mês 3%; de R$ 500 mil a R$ 1 mi 4%; acima de R$ 1 mi 5%,
 *        sobre o valor líquido do crédito. (PJ: 2% até R$ 2 mi/mês; acima, 50% da TAC limitado a R$ 200 mil — o CRM não separa PJ, ajuste na mão.)
 *      Creditas 5%; Santander (pelo Credimorar) 2,5% — "o Creditas e Inter é 5%, Santander é 2,5%".
 *  - Financiamento Habitacional, tabela do Credimorar: Bradesco 0,9% até R$ 2 mi/mês e 1% acima; Inter 0,8%; Itaú 0,8%; Santander 0,8% até
 *      R$ 2 mi/mês e 0,9% acima. O Inter vale o mesmo 0,8% no Credimorar e no código direto (Fabio: "são os mesmos"). Banco não identificado: 0,8%.
 *  - CAIXA (Fabio 14/11): a CAIXA paga 0,8% do financiamento e a A&F fica com 50% disso → 0,4% (processo de R$ 1 mi = R$ 8 mil, A&F recebe R$ 4 mil).
 *  - BRB: 1% (Fabio 14/11; as notas de setembro batem: Yago e Debora, 1% do financiamento). Home Equity da CAIXA: 1%.
 *  - Outros setores (ex.: Consórcio): 1%. */
type Faixa = { ate?: number; pct: number };
const HOME_EQUITY: Record<string, Faixa[]> = {
  INTER: [{ ate: 500_000, pct: 3 }, { ate: 1_000_000, pct: 4 }, { pct: 5 }],
  CREDITAS: [{ pct: 5 }],
  CREDIMORAR: [{ pct: 2.5 }],
  CAIXA: [{ pct: 1 }], // Home Equity da CAIXA: 1% (Fabio 14/11)
};
const FINANCIAMENTO: Record<string, Faixa[]> = {
  BRADESCO: [{ ate: 2_000_000, pct: 0.9 }, { pct: 1 }],
  INTER: [{ pct: 0.8 }],
  ITAU: [{ pct: 0.8 }],
  SANTANDER: [{ ate: 2_000_000, pct: 0.8 }, { pct: 0.9 }],
  CAIXA: [{ pct: 0.4 }], // 0,8% × 50%
  BRB: [{ pct: 1 }],
};
const FH_BANCO_NOME: Record<string, string> = { BRADESCO: 'Bradesco', INTER: 'Inter', ITAU: 'Itaú', SANTANDER: 'Santander', CAIXA: 'CAIXA', BRB: 'BRB' };

const ehHomeEquity = (d?: string | null) => /home equity/i.test(d || '');
const ehFinanciamento = (d?: string | null) => /financiamento/i.test(d || '');
const naFaixa = (faixas: Faixa[], producaoMes: number) => (faixas.find((f) => f.ate === undefined || producaoMes <= f.ate) || faixas[faixas.length - 1]).pct;

/** Banco do Financiamento Habitacional: o da análise (INTER direto) ou o escrito no card ("instituicao": Bradesco, Itaú…) — o Credimorar roda 4 bancos juntos. */
export function bancoFinanciamento(bank?: string | null, instituicao?: unknown): string | null {
  if (bank === 'INTER' || bank === 'INTER_FH') return 'INTER';
  if (bank === 'ITAU_FH') return 'ITAU';
  if (bank === 'CAIXA_FH') return 'CAIXA';
  if (bank === 'BRB_FH') return 'BRB';
  const t = String(instituicao || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/bradesco/.test(t)) return 'BRADESCO';
  if (/itau/.test(t)) return 'ITAU';
  if (/santander/.test(t)) return 'SANTANDER';
  if (/caixa/.test(t)) return 'CAIXA';
  if (/\bbrb\b/.test(t)) return 'BRB';
  if (/inter\b/.test(t)) return 'INTER';
  return null;
}

/** Quem paga, como aparece na provisão — no Financiamento pelo Credimorar leva o banco entre parênteses (separa a produção de cada banco). */
export function pagadorComissao(departmentName: string | null | undefined, bank: string | null | undefined, instituicao?: unknown): string | null {
  if (ehFinanciamento(departmentName) && bank !== 'INTER') {
    const b = bancoFinanciamento(bank, instituicao);
    // CAIXA e BRB pagam direto; Inter e Itaú pelos portais deles (INTER_FH/ITAU_FH) também; o resto do Financiamento vem pela Credimorar.
    if (b === 'CAIXA' || b === 'BRB') return FH_BANCO_NOME[b];
    if (bank === 'INTER_FH') return 'Inter';
    if (bank === 'ITAU_FH') return 'Itaú';
    if (bank === 'CREDIMORAR_FH' || b) return `Credimorar${b ? ` (${FH_BANCO_NOME[b]})` : ''}`;
  }
  if (!bank) return null;
  return ({ INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Credimorar', CREDIMORAR_FH: 'Credimorar' } as Record<string, string>)[bank] || bank;
}

/** % da comissão. `producaoMes` = crédito do mês com o mesmo banco/produto, já contando este cliente (decide a faixa). */
export function commissionRatePct(departmentName?: string | null, bank?: string | null, opts: { instituicao?: unknown; producaoMes?: number } = {}): number {
  const producao = opts.producaoMes || 0;
  if (ehHomeEquity(departmentName) || (!departmentName && bank && bank in HOME_EQUITY)) {
    return bank && HOME_EQUITY[bank] ? naFaixa(HOME_EQUITY[bank], producao) : 5;
  }
  if (ehFinanciamento(departmentName)) {
    const b = bancoFinanciamento(bank, opts.instituicao);
    return b ? naFaixa(FINANCIAMENTO[b], producao) : 0.8;
  }
  return 1;
}

const mesBrt = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 7);

/** Produção do mês por produto + pagador: soma do crédito das provisões (em aberto e recebidas) cujo mês (previsão de pagamento, senão lançamento) é `ref`. */
export async function producaoPorPagador(accountId: string, ref = new Date()): Promise<Map<string, number>> {
  const desde = new Date(ref.getTime() - 120 * 86_400_000);
  const rows = await prisma.commissionProvision.findMany({
    where: { accountId, OR: [{ createdAt: { gte: desde } }, { expectedDate: { gte: desde } }] },
    select: { product: true, payer: true, baseAmount: true, expectedDate: true, createdAt: true },
  });
  const mes = mesBrt(ref);
  const out = new Map<string, number>();
  for (const r of rows) {
    if (mesBrt(r.expectedDate || r.createdAt) !== mes) continue;
    const k = `${r.product || ''}|${r.payer || ''}`;
    out.set(k, (out.get(k) || 0) + (r.baseAmount || 0));
  }
  return out;
}
export const chaveProducao = (product: string | null | undefined, payer: string | null | undefined) => `${product || ''}|${payer || ''}`;

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

/** Banco (no formato da análise) a partir do que ficou gravado na provisão: "Inter", "Creditas", "Credimorar", "Credimorar (Bradesco)", "CREDIMORAR_FH". */
export function bancoDoPagador(product: string | null | undefined, payer: string | null | undefined, instituicao?: unknown): { bank: string | null; instituicao: unknown } {
  const p = String(payer || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const entre = /\(([^)]+)\)/.exec(String(payer || ''))?.[1];
  if (ehFinanciamento(product)) {
    if (/^inter\b/.test(p)) return { bank: 'INTER', instituicao };
    if (/^caixa/.test(p)) return { bank: 'CAIXA_FH', instituicao };
    if (/^brb/.test(p)) return { bank: 'BRB_FH', instituicao };
    if (/^itau/.test(p)) return { bank: 'ITAU_FH', instituicao };
    return { bank: 'CREDIMORAR_FH', instituicao: entre || instituicao };
  }
  if (/^inter\b/.test(p)) return { bank: 'INTER', instituicao };
  if (/creditas/.test(p)) return { bank: 'CREDITAS', instituicao };
  if (/^caixa/.test(p)) return { bank: 'CAIXA', instituicao };
  if (/credimorar|santander/.test(p)) return { bank: 'CREDIMORAR', instituicao };
  return { bank: null, instituicao };
}

/** Clientes da provisão (Fabio 28/10: "as provisões são os clientes que estão em vistoria, pois está mais perto de finalizar" + "vistoria e os estágios à frente
 *  dele"): nos funis "Em contratação", da etapa de Vistoria em diante (Vistoria do Imóvel, Análise Jurídica, Registro em Cartório, Pagamento ao Vendedor). */
export async function etapasDaVistoriaEmDiante(accountId: string): Promise<string[]> {
  const funis = await prisma.pipeline.findMany({
    where: { accountId, name: { startsWith: 'Em contratação', mode: 'insensitive' } },
    select: { stages: { select: { id: true, name: true, order: true } } },
  });
  return funis.flatMap((f) => {
    const vistoria = f.stages.find((st) => /vistoria/i.test(st.name));
    return vistoria ? f.stages.filter((st) => st.order >= vistoria.order).map((st) => st.id) : [];
  });
}

export interface ProvisaoSugerida { id: string; name: string; stage: string; product: string | null; baseAmount: number; ratePct: number; payer: string | null }

/** Crédito, taxa e quem paga de cada cliente — base: proposta que o cliente segue (escolhida ⭐ ou a do único banco que aprovou) > "Valor da venda" > crédito
 *  pedido > última aprovação; taxa pela faixa da produção do mês (o que já foi provisionado no mês + este cliente). */
export async function montarProvisoes(accountId: string, leadIds: string[]): Promise<ProvisaoSugerida[]> {
  if (!leadIds.length) return [];
  const leads = await prisma.lead.findMany({
    where: { accountId, id: { in: leadIds } },
    select: { id: true, name: true, value: true, customFields: true, pipeline: { select: { name: true, department: { select: { name: true } } } }, stage: { select: { name: true } } },
  });
  const analyses = await prisma.creditAnalysis.findMany({
    where: { leadId: { in: leadIds }, dryRun: false, source: { not: 'AI_SIM' }, OR: [{ chosen: true }, { status: { in: ['APPROVED', 'CONDITIONAL'] }, approvedValue: { not: null } }] },
    select: { leadId: true, bank: true, approvedValue: true, chosen: true },
    orderBy: { createdAt: 'desc' },
  });
  const producao = await producaoPorPagador(accountId);
  // Taxa aprendida das notas de comissão (Fabio 14/11): quando o banco já pagou nota, vale a taxa efetiva dele no lugar da tabela.
  const { taxasAprendidas, taxaComAprendizado } = require('./commission-note.service') as typeof import('./commission-note.service');
  const aprendidas = await taxasAprendidas(accountId).catch(() => new Map());
  const porId = new Map(leads.map((l) => [l.id, l]));
  return leadIds.map((id) => porId.get(id)).filter((l): l is NonNullable<typeof l> => !!l).map((l) => {
    const mine = analyses.filter((a) => a.leadId === l.id);
    const seguida = propostaSeguida(mine);
    const cf = (l.customFields as Record<string, unknown>) || {};
    // Sem análise no CRM: o banco da proposta anotada no card (nº + instituição — ex.: Sérgio/Adilson com proposta do Inter feita no portal).
    const doCard = !mine.length ? (require('./credit-analysis.service') as typeof import('./credit-analysis.service')).propostaDoCard(cf as Record<string, any>) : null;
    const pick = seguida || mine[0] || (doCard ? { bank: doCard.bank, approvedValue: null, chosen: false, leadId: l.id } : undefined);
    const base = seguida?.approvedValue || l.value || parseCreditValue(cf.valor_credito) || pick?.approvedValue || 0;
    const product = l.pipeline.department?.name || null;
    const payer = pagadorComissao(product, pick?.bank, cf.instituicao);
    return {
      id: l.id, name: l.name, stage: `${l.pipeline.name} · ${l.stage.name}`, product, baseAmount: base, payer,
      ratePct: taxaComAprendizado(aprendidas, product, payer, commissionRatePct(product, seguida?.bank || doCard?.bank, { instituicao: cf.instituicao, producaoMes: (producao.get(chaveProducao(product, payer)) || 0) + base })).pct,
    };
  });
}

/** Lança sozinha a provisão de quem chegou na Vistoria (ou além) e ainda não tem (Fabio 28/10). Um por vez, pra faixa da produção do mês já contar os anteriores. */
let ultimaRodadaProvisoes = 0;
export async function autoProvisoes(accountId: string): Promise<void> {
  if (Date.now() - ultimaRodadaProvisoes < 10 * 60_000) return;
  ultimaRodadaProvisoes = Date.now();
  const etapas = await etapasDaVistoriaEmDiante(accountId);
  if (!etapas.length) return;
  const jaTem = new Set((await prisma.commissionProvision.findMany({ where: { accountId }, select: { leadId: true } })).map((p) => p.leadId));
  const ids = (await prisma.lead.findMany({ where: { accountId, status: 'OPEN', archived: false, stageId: { in: etapas } }, select: { id: true } })).map((l) => l.id).filter((id) => !jaTem.has(id));
  for (const id of ids) {
    const [p] = await montarProvisoes(accountId, [id]);
    if (!p || !(p.baseAmount > 0)) continue; // sem valor nenhum no card: fica na lista pra lançar à mão
    await prisma.commissionProvision.create({
      data: { accountId, leadId: p.id, leadName: p.name, product: p.product, payer: p.payer, baseAmount: p.baseAmount, ratePct: p.ratePct, amount: commissionAmount(p.baseAmount, p.ratePct), note: `Lançada sozinha: cliente em ${p.stage}` },
    });
    await prisma.note.create({ data: { leadId: p.id, type: 'COMMENT', content: `💰 Provisão de comissão lançada sozinha no Financeiro (cliente em ${p.stage}): ${p.ratePct}% de R$ ${p.baseAmount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}${p.payer ? ` — paga: ${p.payer}` : ''}.` } }).catch(() => {});
    console.log(`[Provisão] ${p.name}: ${p.ratePct}% de ${p.baseAmount} (${p.payer || 'sem pagador'})`);
  }
}


/** Taxa pra um processo com o banco escolhido à mão no Financeiro (tabela pela produção do mês + taxa aprendida das notas). */
export async function taxaParaPagador(accountId: string, product: string | null, payer: string, base: number): Promise<number> {
  const { bank, instituicao } = bancoDoPagador(product, payer);
  const producao = (await producaoPorPagador(accountId)).get(chaveProducao(product, payer)) || 0;
  const tabela = commissionRatePct(product, bank, { instituicao, producaoMes: producao + base });
  const { taxasAprendidas, taxaComAprendizado } = require('./commission-note.service') as typeof import('./commission-note.service');
  return taxaComAprendizado(await taxasAprendidas(accountId).catch(() => new Map()), product, payer, tabela).pct;
}

/** A provisão acompanha o card (Fabio 14/11: "cliquei no Inter da Rosana… continua com o ponto de interrogação"): estimativa em aberto, sem nota e sem %
 *  digitada por uma pessoa, refaz banco, crédito e taxa pela proposta escolhida (ou a do único banco que aprovou / a anotada no card). Com a % travada, só
 *  preenche o banco que faltava. Devolve quantas mudaram. */
export async function sincronizarProvisoes(accountId: string, leadIds?: string[]): Promise<number> {
  const abertas = await prisma.commissionProvision.findMany({ where: { accountId, status: 'OPEN', noteId: null, ...(leadIds ? { leadId: { in: leadIds } } : {}) } });
  if (!abertas.length) return 0;
  const sugeridas = new Map((await montarProvisoes(accountId, abertas.map((p) => p.leadId))).map((p) => [p.id, p]));
  let mudou = 0;
  for (const p of abertas) {
    const s = sugeridas.get(p.leadId);
    if (!s || !s.payer) continue; // o card ainda não diz o banco: fica como está
    if (p.rateLocked) {
      if (!p.payer) { await prisma.commissionProvision.update({ where: { id: p.id }, data: { payer: s.payer } }); mudou++; }
      continue;
    }
    const base = s.baseAmount > 0 ? s.baseAmount : p.baseAmount;
    const amount = commissionAmount(base, s.ratePct);
    if (p.payer === s.payer && Math.abs(p.baseAmount - base) < 0.01 && Math.abs(p.ratePct - s.ratePct) < 0.0001) continue;
    // O card manda (proposta escolhida ⭐, a do único banco que aprovou ou a anotada no card); banco escolhido à mão no Financeiro só vale enquanto o card não diz o banco.
    await prisma.commissionProvision.update({ where: { id: p.id }, data: { payer: s.payer, baseAmount: base, ratePct: s.ratePct, amount } });
    mudou++;
  }
  return mudou;
}
