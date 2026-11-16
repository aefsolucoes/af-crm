import tabelasJson from '../data/emolumentos-2026.json';

/**
 * CUSTAS DE CARTÓRIO PELA TABELA OFICIAL DE CADA ESTADO (Fabio 16/11: "tem que conferir pela tabela oficial de cada estado, para todos").
 * Antes, fora do DF, escritura e registro vinham da pesquisa na internet — em Goiânia ela usou uma tabela de 2020 "projetada" (escritura de R$ 14,6 mil).
 *
 * Os dados ficam em `src/data/emolumentos-2026.json` (uma entrada por UF, com a URL da fonte oficial, a vigência e 2 contas conferidas à mão).
 * UF sem entrada: o chamador continua na pesquisa e marca "pesquisa na internet — conferir".
 *
 * Por ato (escritura de compra e venda, escritura do financiamento, registro da compra e venda, registro da garantia):
 * - faixa: a primeira com valor <= "ate" (null = sem limite); "total" = o que o usuário paga (emolumento + taxas/fundos/selo), "emolumento" = base do ISS/desconto;
 * - "acima": acima de "de", soma "total"/"emolumento" a cada "cada" reais ou fração; "pctValor": % sobre o valor do ato (ex.: FUNREJUS do PR);
 * - ISS = issPct × emolumento (quando a tabela não traz o ISS no total); 1ª aquisição SFH (Lei 6.015, art. 290): desconto sobre o total ou só sobre o emolumento.
 */

type Faixa = [number | null, number, number?];
type Desconto1a = { pct: number; sobre: 'emolumento' | 'total'; baseFator?: number; usarFaixas1a?: boolean };
type Tabela = {
  faixas: Faixa[];
  /** 1ª aquisição com tabela própria (desconto1a.usarFaixas1a — RJ: emolumento −50% e sem os fundos). */
  faixas1a?: Faixa[]; acima1a?: Tabela['acima'];
  /** Sem financiamento (as faixas normais já vêm com a redução do financiamento — MG, Nota XXIII). */
  faixasSemReducao?: Faixa[]; acimaSemReducao?: Tabela['acima'];
  /** Troca o desconto da seção neste ato (SP: 50% só no registro da garantia). */
  desconto1a?: Desconto1a | null;
  acima?: { de: number; cada: number; total: number; emolumento?: number; tetoTotal?: number | null; tetoEmolumento?: number | null } | null;
  pctValor?: { pct: number; teto?: number | null; minimo?: number | null; nome?: string; noEmolumento?: boolean } | null;
};
type Secao = Tabela & {
  fonte: string; item?: string; issPct?: number; issObs?: string; issPorMunicipio?: Record<string, number> | null;
  desconto1a?: Desconto1a | null; notas?: string;
};
type SecaoNotas = Secao & {
  doisAtos?: boolean; baseFinanciamento?: 'imovel' | 'financiado'; fatorFinanciamento?: number; financiamento?: Tabela | null;
  /** Fator extra do 2º ato quando é SFH (PR, nota 1 da Tabela XI: "a metade das custas"). */
  fatorFinanciamentoSfh?: number;
  /** O que a escritura somada passar de "acimaDe" paga só "fator" (BA, nota I-1 da Tabela II). */
  redutorExcedente?: { acimaDe: number; fator: number } | null;
  /** 3º ato da escritura: a garantia (SC, art. 42 §ú I — alienação fiduciária pela avaliação do imóvel). */
  atoGarantia?: { base: 'imovel' | 'financiado'; fator?: number; tabela?: Tabela | null } | null;
};
type SecaoRegistro = Secao & {
  baseGarantia?: 'imovel' | 'financiado'; fatorGarantia?: number; garantia?: Tabela | null;
  /** Redução sobre a parcela financiada pelo SFH (ES, Tabela 11, nota 6): compra e venda na proporção financiado/imóvel, garantia inteira. */
  reducaoSfh?: { pct: number } | null;
};
export type TabelaUf = { status: string; nome: string; vigencia: string; conferidoEm: string; notas: SecaoNotas; registro: SecaoRegistro };

const TABELAS: Record<string, TabelaUf> = Object.fromEntries(
  Object.entries(tabelasJson as unknown as Record<string, TabelaUf>).filter(([uf, t]) => /^[A-Z]{2}$/.test(uf) && t?.status === 'ok'),
);

export const ufsComTabela = (): string[] => Object.keys(TABELAS).sort();
export const tabelaDaUf = (uf: string): TabelaUf | null => TABELAS[String(uf || '').trim().toUpperCase()] || null;

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Teto do SFH (CMN 2025: R$ 2,25 mi) — regras "só no SFH" (PR, nota 1 da Tabela XI) valem até ele. */
const TETO_SFH = 2_250_000;
const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function faixa(t: Tabela, valor: number): { total: number; emol: number } {
  const acha = (v: number) => t.faixas.find(([ate]) => ate === null || v <= ate) || t.faixas[t.faixas.length - 1];
  const f = acha(valor);
  let total = f[1];
  let emol = f[2] ?? f[1];
  if (t.acima && valor > t.acima.de) {
    const b = acha(t.acima.de);
    const n = Math.ceil((valor - t.acima.de) / t.acima.cada - 1e-9);
    total = b[1] + n * t.acima.total;
    emol = (b[2] ?? b[1]) + n * (t.acima.emolumento ?? t.acima.total);
    if (t.acima.tetoTotal) total = Math.min(total, t.acima.tetoTotal);
    if (t.acima.tetoEmolumento) emol = Math.min(emol, t.acima.tetoEmolumento);
  }
  if (t.pctValor) {
    let p = (valor * t.pctValor.pct) / 100;
    if (t.pctValor.minimo) p = Math.max(p, t.pctValor.minimo);
    if (t.pctValor.teto) p = Math.min(p, t.pctValor.teto);
    total += p;
    if (t.pctValor.noEmolumento) emol += p;
  }
  return { total, emol };
}

function issDa(secao: Secao, cidade: string): number {
  const porCidade = secao.issPorMunicipio || {};
  const c = semAcento(cidade || '');
  const achado = c ? Object.entries(porCidade).find(([nome]) => semAcento(nome) === c) : undefined;
  return (achado ? achado[1] : secao.issPct || 0) / 100;
}

/** Um ato (arredondado em centavos). Pura.
 *  - desconto1a do próprio ato (tabela.desconto1a) troca o da seção; usarFaixas1a → faixas1a já descontadas (sem descontar de novo);
 *  - baseFator: o desconto incide sobre emolumento × baseFator (fundos que são % do emolumento caem junto: GO 1,2425; PR 1,05). */
function ato(secao: Secao, tabela: Tabela, valor: number, cidade: string, primeiraAquisicao: boolean, fator = 1, financiado = 1): number {
  if (!(valor > 0)) return 0;
  const regra = tabela !== secao && Object.prototype.hasOwnProperty.call(tabela, 'desconto1a') ? tabela.desconto1a : secao.desconto1a;
  let d = primeiraAquisicao && regra ? regra : null;
  let t: Tabela = tabela;
  if (d && d.usarFaixas1a && tabela.faixas1a) { t = { faixas: tabela.faixas1a, acima: tabela.acima1a || null, pctValor: tabela.pctValor }; d = null; }
  else if (!(financiado > 0) && tabela.faixasSemReducao) t = { faixas: tabela.faixasSemReducao, acima: tabela.acimaSemReducao || null, pctValor: tabela.pctValor };
  let { total, emol } = faixa(t, valor);
  total *= fator; emol *= fator;
  const iss = issDa(secao, cidade);
  const f = d ? 1 - d.pct / 100 : 1;
  if (d && d.sobre === 'total') return r2(r2(total + emol * iss) * f);
  return r2(total - emol * (d?.baseFator ?? 1) * (1 - f) + emol * f * iss);
}

export type CartoriosUf = {
  escritura: { compraVenda: number; financiamento: number | null; valor: number; obs: string; fonte: string };
  registro: { compraVenda: number; alienacao: number | null; total: number; obs: string; fonte: string };
};

/** Escritura (compra e venda + financiamento, quando a tabela conta 2 atos) e registro (compra e venda + garantia) pela tabela oficial da UF. Null = UF sem tabela. Pura. */
export function cartoriosUf(uf: string, valorImovel: number, financiado: number, primeiraAquisicao: boolean, cidade = ''): CartoriosUf | null {
  const t = tabelaDaUf(uf);
  if (!t || !(valorImovel > 0)) return null;
  const n = t.notas, g = t.registro;
  const sfh = valorImovel <= TETO_SFH;
  let escCv = ato(n, n, valorImovel, cidade, primeiraAquisicao, 1, financiado);
  let escFin = n.doisAtos && financiado > 0
    ? ato(n, n.financiamento || n, n.baseFinanciamento === 'imovel' ? valorImovel : financiado, cidade, primeiraAquisicao, (n.fatorFinanciamento ?? 1) * (sfh && n.fatorFinanciamentoSfh ? n.fatorFinanciamentoSfh : 1)) : 0;
  const rx = n.redutorExcedente;
  if (rx && escCv + escFin > rx.acimaDe) {
    const soma = escCv + escFin, nova = rx.acimaDe + (soma - rx.acimaDe) * rx.fator;
    escFin = r2((escFin * nova) / soma); escCv = r2(nova - escFin);
  }
  // SC (LC 755, art. 42 §ú I): a alienação fiduciária na escritura é mais um ato, pela avaliação (valor do imóvel) — soma no financiamento.
  if (n.atoGarantia && financiado > 0) escFin = r2(escFin + ato(n, n.atoGarantia.tabela || n, n.atoGarantia.base === 'financiado' ? financiado : valorImovel, cidade, primeiraAquisicao, n.atoGarantia.fator ?? 1, financiado));
  // ES (Tabela 11, nota 6): 50% sobre a parcela financiada pelo SFH — compra e venda na proporção financiado/imóvel, garantia inteira. Na 1ª aquisição vale só o desconto dela (não soma).
  const rs = g.reducaoSfh && sfh && financiado > 0 && !(primeiraAquisicao && g.desconto1a) ? g.reducaoSfh : null;
  const fCv = rs ? 1 - (rs.pct / 100) * Math.min(1, financiado / valorImovel) : 1;
  const fGar = rs ? 1 - rs.pct / 100 : 1;
  const regCv = ato(g, g, valorImovel, cidade, primeiraAquisicao, fCv, financiado);
  const regGar = financiado > 0
    ? ato(g, g.garantia || g, g.baseGarantia === 'imovel' ? valorImovel : financiado, cidade, primeiraAquisicao, (g.fatorGarantia ?? 1) * fGar) : 0;
  const issTxt = (s: Secao) => { const p = issDa(s, cidade) * 100; return p ? `, ISS ${p.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%` : ''; };
  const desc = (s: Secao, ...atos: (Tabela | null | undefined)[]) => {
    const d = [s.desconto1a, ...atos.map((a) => (a && Object.prototype.hasOwnProperty.call(a, 'desconto1a') ? a.desconto1a : null))].find(Boolean);
    return primeiraAquisicao && d ? `, ${d.pct}% de desconto da 1ª aquisição SFH${s.desconto1a ? '' : ' (no registro da garantia)'}${d.sobre === 'emolumento' ? ' (sobre o emolumento)' : ''}` : '';
  };
  // Vigência e item resumidos pra anotação (o arquivo de dados guarda o texto inteiro).
  const curto = (x: string | undefined, max: number) => { const v = String(x || '').trim(); return v.length > max ? `${v.slice(0, max).replace(/\s+\S*$/, '')}…` : v; };
  const base = `Tabela oficial ${t.nome} — ${curto(t.vigencia, 90)}`;
  return {
    escritura: {
      compraVenda: escCv, financiamento: escFin || null, valor: r2(escCv + escFin), fonte: n.fonte,
      obs: `${base}${n.item ? ` (${curto(n.item, 110)})` : ''}: ${escFin ? `compra e venda + financiamento${n.baseFinanciamento === 'imovel' ? ' (os 2 pelo valor do imóvel)' : ' (pelo valor financiado)'}` : 'compra e venda'}${issTxt(n)}${desc(n)}`,
    },
    registro: {
      compraVenda: regCv, alienacao: regGar || null, total: r2(regCv + regGar), fonte: g.fonte,
      obs: `${base}${g.item ? ` (${curto(g.item, 110)})` : ''}: compra e venda${regGar ? ` + garantia pelo valor ${g.baseGarantia === 'imovel' ? 'do imóvel' : 'financiado'}` : ''}${issTxt(g)}${desc(g, g.garantia)}`,
    },
  };
}
