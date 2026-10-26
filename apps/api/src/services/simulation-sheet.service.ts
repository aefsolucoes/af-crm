import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { AF_LOGO_BRANCA_PNG_BASE64 } from './af-logo-branca';
import { BANK_LOGOS_BASE64, SELAWIK_BOLD_BASE64, SELAWIK_REGULAR_BASE64 } from './simulation-sheet-assets';

/**
 * "Home Equity | Evolução das parcelas" gerado pelo CRM no MESMO modelo do PDF do portal Credimorar (com a logo A&F no alto).
 * Serve pros bancos que não vêm do Credimorar (Inter, Creditas): a extensão só LÊ os dados da simulação no portal do banco e o CRM
 * desenha o PDF. As medidas (posições, cores, 8 linhas na 1ª página e 17 nas demais, total no fim) foram tiradas do modelo aprovado;
 * a tabela usa Helvetica como o original, e o cabeçalho usa Selawik (mesmas métricas da Segoe UI do portal).
 */

export type SheetBank = 'INTER' | 'SANTANDER' | 'CREDITAS';

export interface SheetRow {
  n: number;
  amort: number;
  juros: number;
  mip: number;
  dfi: number;
  tsa: number;
  parcela: number; // valor da parcela (soma de tudo)
  saldo: number;
}

export interface SimulationSheet {
  clientName: string;
  /** Banco que informa só o TOTAL de seguros (MIP+DFI): mostra uma célula única "Seguros (MIP + DFI)" no lugar das duas colunas. */
  segurosJuntos?: boolean;
  /** Momento da simulação (padrão: agora, horário de Brasília). */
  when?: Date;
  bank: SheetBank;
  /** Nome mostrado ao lado do ícone (padrão: Inter / Santander / Creditas). */
  bankLabel?: string;
  /** PADRÃO DA SIMULAÇÃO DE HOME EQUITY (Fabio 26/10) — só estes 8 campos, em 2 linhas de 4: tipo de imóvel, prazo, sistema, valor do imóvel / valor do empréstimo,
   *  taxa mensal, taxa nominal, taxa efetiva. Saíram CET, CESH, renda e entrada (Home Equity não tem entrada). Taxas já formatadas (ver `taxasDe`). */
  summary: {
    tipoImovel: string; // Residencial | Comercial
    prazoMeses: number;
    sistema: string; // SAC | PRICE
    valorImovel: number;
    valorEmprestimo: number;
    taxaMensal: string; // "1,40% a.m. + IPCA"
    taxaNominal: string; // "16,80% a.a. + IPCA"
    taxaEfetiva: string; // "18,16% a.a. + IPCA"
  };
  rows: SheetRow[];
}

const NAVY = rgb(0.055, 0.18, 0.34);
const GRAY = rgb(0.96078, 0.96078, 0.96078);
const BOX = rgb(0.961, 0.961, 0.961);
const BLUE = rgb(0.83, 0.9, 0.98);
const YELLOW = rgb(0.99216, 0.92549, 0.56863);
const INK = rgb(0.14118, 0.14118, 0.14118);
const NOTE = rgb(0.302, 0.302, 0.322);
const SEP_BOX = rgb(0.875, 0.875, 0.875);
const SEP_HEAD = rgb(0.87451, 0.87451, 0.87451);
const WHITE = rgb(1, 1, 1);

const PAGE_W = 842;
const PAGE_H = 595;
const ROW_H = 28.13;
const PITCH = 30;
const FIRST_PAGE_ROWS = 8;
const OTHER_PAGE_ROWS = 17;

// Colunas da tabela: página 1 começa em x=35, as demais em x=30.
const COLS_P1 = { x0: 35, w: [88.89, 105.47, 94.77, 97.78, 95.21, 67.36, 111.87, 118.66] };
const COLS_PN = { x0: 30, w: [89.46, 106.14, 95.37, 98.4, 95.82, 67.79, 112.58, 119.42] };
const HEADERS = ['Nº Parcela', 'Amortização', 'Juros', 'Seguro MIP', 'Seguro DFI', 'TSA', 'Valor Parcela', 'Saldo Devedor'];

const DISCLAIMER_TITLE = 'Importante: O resultado apresentado é apenas uma simulação.';
const DISCLAIMER_LINES = [
  'A taxa de juros é indicativa, pode variar conforme perfil de crédito. O valor da parcela apresentado, assim como valor dos seguros DFI e MIP, podem sofrer alterações',
  'de acordo com o valor da avaliação do imóvel. A nomenclatura das tarifas pode variar entre as instituições. As condições de negócio poderão ser alteradas ou',
  'extintas a qualquer momento, sem aviso prévio. A validade da simulação da proposta está condicionada a alteração da taxa de juros de cada banco.',
];

export function brl(n: number): string {
  const neg = n < 0;
  const [int, dec] = Math.abs(n).toFixed(2).split('.');
  return `${neg ? '-' : ''}R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${dec}`;
}

function brasiliaParts(d: Date) {
  const f = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} - ${p.hour === '24' ? '00' : p.hour}h${p.minute}`;
}

interface Ctx {
  doc: PDFDocument;
  reg: PDFFont;
  bold: PDFFont;
  hel: PDFFont;
  helBold: PDFFont;
  afLogo: PDFImage;
  bankLogo: PDFImage | null;
}

function centered(page: PDFPage, text: string, font: PDFFont, size: number, cx: number, y: number, color = INK) {
  page.drawText(text, { x: cx - font.widthOfTextAtSize(text, size) / 2, y, size, font, color });
}

function justify(page: PDFPage, text: string, font: PDFFont, size: number, x: number, y: number, width: number, color = NOTE) {
  const words = text.split(' ');
  const total = words.reduce((s, w) => s + font.widthOfTextAtSize(w, size), 0);
  const gap = words.length > 1 ? (width - total) / (words.length - 1) : 0;
  let cx = x;
  for (const w of words) {
    page.drawText(w, { x: cx, y, size, font, color });
    cx += font.widthOfTextAtSize(w, size) + gap;
  }
}

function drawFirstPageHeader(ctx: Ctx, page: PDFPage, s: SimulationSheet) {
  const { reg, bold } = ctx;
  page.drawRectangle({ x: 0, y: 496, width: 843, height: 99, color: NAVY });
  page.drawText('Home Equity | Evolução das parcelas', { x: 30, y: 555.39, size: 17.25, font: reg, color: WHITE });
  page.drawLine({ start: { x: 30, y: 543.5 }, end: { x: 376, y: 543.5 }, thickness: 1, color: BLUE });
  page.drawText(s.clientName.toUpperCase(), { x: 30, y: 519.05, size: 12, font: reg, color: WHITE });
  const when = `Data da simulação: ${brasiliaParts(s.when || new Date())}`;
  page.drawText(when, { x: 814 - reg.widthOfTextAtSize(when, 12), y: 518.55, size: 12, font: reg, color: WHITE });
  page.drawImage(ctx.afLogo, { x: 687.85299, y: 533, width: 122.29412, height: 56 });

  // Banco + aviso
  if (ctx.bankLogo) page.drawImage(ctx.bankLogo, { x: 63, y: 437, width: 30, height: 30 });
  const label = s.bankLabel || { INTER: 'Inter', SANTANDER: 'Santander', CREDITAS: 'Creditas' }[s.bank];
  page.drawText(label, { x: 102, y: 447.67, size: 10.5, font: bold, color: rgb(0.141, 0.141, 0.141) });
  page.drawText(DISCLAIMER_TITLE, { x: 158.62, y: 473.29, size: 9, font: bold, color: NOTE });
  justify(page, DISCLAIMER_LINES[0], reg, 9, 158.63, 451.29, 814 - 158.63);
  justify(page, DISCLAIMER_LINES[1], reg, 9, 158.63, 439.29, 814 - 158.63);
  page.drawText(DISCLAIMER_LINES[2], { x: 158.63, y: 427.29, size: 9, font: reg, color: NOTE });

  // Caixas do resumo — padrão de 26/10: 2 linhas de 4 caixas de larguras iguais (29 → 814), nas mesmas alturas do modelo.
  const m = s.summary;
  const W = (814 - 29) / 4;
  const caixa = (i: number, label: string, value: string) => ({ x: 29 + W * i, w: W, label, cx: 29 + W * (i + 0.5), value });
  const row1 = [
    caixa(0, 'Tipo de imóvel', m.tipoImovel),
    caixa(1, 'Prazo', `${m.prazoMeses} meses`),
    caixa(2, 'Sistema de amortização', m.sistema),
    caixa(3, 'Valor do imóvel', brl(m.valorImovel)),
  ];
  const row2 = [
    caixa(0, 'Valor do empréstimo', brl(m.valorEmprestimo)),
    caixa(1, 'Taxa mensal', m.taxaMensal),
    caixa(2, 'Taxa nominal', m.taxaNominal),
    caixa(3, 'Taxa efetiva', m.taxaEfetiva),
  ];
  // As caixas do modelo são recortadas: 39,2 pt de altura e nunca passam de x=814.
  const BOX_H = 39.2;
  for (const b of row1) page.drawRectangle({ x: b.x, y: 374, width: Math.min(b.w, 814 - b.x), height: BOX_H, color: BOX });
  for (const b of row2) page.drawRectangle({ x: b.x, y: 330, width: Math.min(b.w, 814 - b.x), height: BOX_H, color: BOX });
  for (const x of [29 + W, 29 + W * 2, 29 + W * 3]) {
    page.drawLine({ start: { x, y: 374 + BOX_H }, end: { x, y: 374 }, thickness: 2, color: SEP_BOX });
    page.drawLine({ start: { x, y: 330 + BOX_H }, end: { x, y: 330 }, thickness: 2, color: SEP_BOX });
  }
  row1.forEach((b) => { centered(page, b.label, bold, 10.5, b.cx, 397.67, rgb(0, 0, 0)); centered(page, b.value, reg, 10.5, b.cx, 383.67, rgb(0, 0, 0)); });
  row2.forEach((b) => { centered(page, b.label, bold, 10.5, b.cx, 353.67, rgb(0, 0, 0)); centered(page, b.value, reg, 10.5, b.cx, 339.67, rgb(0, 0, 0)); });
}

/** As 3 taxas do padrão a partir do que o banco informa (Fabio 26/10). Mensal = nominal ÷ 12 (a regra do Fabio, 22/10); efetiva = mensal acumulada em 12 meses.
 *  Taxas em PERCENTUAL (1,40 = 1,40%). O que o banco informa vale; o resto é calculado. `indexador` (ex.: "IPCA") entra como " + IPCA" nas três. */
export function taxasDe(p: { mensal?: number | null; nominalAA?: number | null; efetivaAA?: number | null; indexador?: string | null }): { taxaMensal: string; taxaNominal: string; taxaEfetiva: string } {
  const ok = (v: number | null | undefined) => (v != null && Number.isFinite(v) && v > 0 ? v : null);
  let mensal = ok(p.mensal), nominal = ok(p.nominalAA), efetiva = ok(p.efetivaAA);
  if (mensal == null && nominal != null) mensal = nominal / 12;
  if (mensal == null && efetiva != null) mensal = (Math.pow(1 + efetiva / 100, 1 / 12) - 1) * 100;
  if (nominal == null && mensal != null) nominal = mensal * 12;
  if (efetiva == null && mensal != null) efetiva = (Math.pow(1 + mensal / 100, 12) - 1) * 100;
  const suf = p.indexador ? ` + ${p.indexador}` : '';
  const f = (v: number | null, un: string) => (v == null ? '—' : `${v.toFixed(2).replace('.', ',')}% ${un}${suf}`);
  return { taxaMensal: f(mensal, 'a.m.'), taxaNominal: f(nominal, 'a.a.'), taxaEfetiva: f(efetiva, 'a.a.') };
}

function colCenters(cols: { x0: number; w: number[] }): number[] {
  let x = cols.x0;
  return cols.w.map((w) => { const c = x + w / 2; x += w; return c; });
}

// O modelo posiciona os títulos da tabela com medidas próprias (não é centralização exata): usa os x do original.
const HEADER_X_P1 = [52.85, 144.37, 261.69, 343.38, 440.75, 539.54, 606.38, 718.91];
const HEADER_X_PN = [48.13, 140.28, 258.24, 340.55, 438.54, 537.85, 605.27, 718.53];

function drawTableHeader(ctx: Ctx, page: PDFPage, cols: { x0: number; w: number[] }, headerBase: number, xs: number[], juntos: boolean) {
  HEADERS.forEach((h, i) => {
    if (juntos && i === 4) return;
    if (juntos && i === 3) { centered(page, 'Seguros (MIP + DFI)', ctx.helBold, 10.5, cols.x0 + cols.w.slice(0, 3).reduce((a, b) => a + b, 0) + (cols.w[3] + cols.w[4]) / 2, headerBase, INK); return; }
    page.drawText(h, { x: xs[i], y: headerBase, size: 10.5, font: ctx.helBold, color: INK });
  });
  let x = cols.x0;
  for (let i = 0; i < cols.w.length - 1; i++) {
    x += cols.w[i];
    if (juntos && i === 3) continue;
    page.drawLine({ start: { x: x - 0.75, y: headerBase - 12.32 }, end: { x: x - 0.75, y: headerBase + 17.68 }, thickness: 1.5, color: SEP_HEAD });
  }
}

function drawRow(ctx: Ctx, page: PDFPage, cols: { x0: number; w: number[] }, top: number, g: number, r: SheetRow, hl1: number, juntos: boolean) {
  const gray = g % 2 === 1;
  // Realce azul/amarelo nas DUAS PRIMEIRAS PARCELAS PAGAS (hl1 = índice da 1ª): no Santander as linhas 0 e 1 vêm zeradas (carência) e o realce caía nelas (26/10).
  const k = g - hl1;
  const highlight = k === 0 || k === 1;
  const vals = [String(r.n), brl(r.amort), brl(r.juros), brl(r.mip), brl(r.dfi), brl(r.tsa), brl(r.parcela), brl(r.saldo)];
  // 1º as células (fundo + linha branca de cima), 2º os textos: na célula única de seguros o texto passa por cima da coluna vizinha.
  let x = cols.x0;
  cols.w.forEach((w, i) => {
    const hl = highlight && i === 6 ? (k === 0 ? BLUE : YELLOW) : null;
    const fill = hl || (gray ? GRAY : null);
    if (fill) page.drawRectangle({ x, y: top - ROW_H, width: w, height: ROW_H, color: fill });
    page.drawLine({ start: { x, y: top }, end: { x: x + w, y: top }, thickness: 3.75, color: WHITE });
    x += w;
  });
  x = cols.x0;
  cols.w.forEach((w, i) => {
    if (juntos && i === 3) centered(page, vals[i], ctx.hel, 10.5, x + (w + cols.w[4]) / 2, top - 17.69, INK);
    else if (!(juntos && i === 4)) centered(page, vals[i], ctx.hel, 10.5, x + w / 2, top - 17.69, INK);
    x += w;
  });
}

export async function renderSimulationSheet(s: SimulationSheet): Promise<Buffer> {
  if (!s.rows.length) throw new Error('A simulação não tem parcelas');
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const ctx: Ctx = {
    doc,
    reg: await doc.embedFont(Buffer.from(SELAWIK_REGULAR_BASE64, 'base64'), { subset: true }),
    bold: await doc.embedFont(Buffer.from(SELAWIK_BOLD_BASE64, 'base64'), { subset: true }),
    hel: await doc.embedFont(StandardFonts.Helvetica),
    helBold: await doc.embedFont(StandardFonts.HelveticaBold),
    afLogo: await doc.embedPng(Buffer.from(AF_LOGO_BRANCA_PNG_BASE64, 'base64')),
    bankLogo: BANK_LOGOS_BASE64[s.bank] ? await doc.embedPng(Buffer.from(BANK_LOGOS_BASE64[s.bank], 'base64')) : null,
  };
  doc.setTitle(`Evolução das parcelas — ${s.clientName}`);
  doc.setAuthor('A&F Soluções Financeiras');

  const total = s.rows.reduce((sum, r) => sum + r.parcela, 0);
  const hl1 = Math.max(0, s.rows.findIndex((r) => r.parcela > 0));
  const pages: PDFPage[] = [];
  let idx = 0; // linha global
  let pageNo = 0;
  let placedTotal = false;
  while (!placedTotal) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: WHITE }); // fundo branco explícito (tema escuro não vira fundo preto)
    pages.push(page);
    const first = pageNo === 0;
    const cols = first ? COLS_P1 : COLS_PN;
    const capacity = first ? FIRST_PAGE_ROWS : OTHER_PAGE_ROWS;
    let rowTop: number;
    if (first) {
      drawFirstPageHeader(ctx, page, s);
      drawTableHeader(ctx, page, cols, 302.32, HEADER_X_P1, !!s.segurosJuntos);
      rowTop = 288.13;
    } else {
      drawTableHeader(ctx, page, cols, 552.32, HEADER_X_PN, !!s.segurosJuntos);
      rowTop = 538.13;
    }
    let used = 0;
    while (used < capacity && idx < s.rows.length) {
      drawRow(ctx, page, cols, rowTop - used * PITCH, idx, s.rows[idx], hl1, !!s.segurosJuntos);
      used++;
      idx++;
    }
    if (idx >= s.rows.length && used < capacity) {
      const base = rowTop - used * PITCH - 17.69;
      const centers = colCenters(cols);
      centered(page, 'TOTAL:', ctx.helBold, 10.5, centers[5], base, INK);
      centered(page, brl(total), ctx.helBold, 10.5, centers[6], base, INK);
      placedTotal = true;
    }
    pageNo++;
  }
  // "Página X de N" (Helvetica 10, borda direita fixa como no modelo)
  const rightEdge = 732.73 + ctx.hel.widthOfTextAtSize('Página 1 de 15', 10);
  pages.forEach((p, i) => {
    const t = `Página ${i + 1} de ${pages.length}`;
    p.drawText(t, { x: rightEdge - ctx.hel.widthOfTextAtSize(t, 10), y: 15, size: 10, font: ctx.hel, color: rgb(0, 0, 0) });
  });
  return Buffer.from(await doc.save());
}
