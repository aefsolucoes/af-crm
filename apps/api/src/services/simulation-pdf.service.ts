import pdfParse from 'pdf-parse';
import { AF_LOGO_BRANCA_PNG_BASE64 } from './af-logo-branca';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, decodePDFRawStream, rgb } from 'pdf-lib';

/**
 * Marca (A&F) nos PDFs "Evolução das parcelas" que o portal gera.
 *
 * Em vez de redesenhar o PDF, edita o ORIGINAL do portal — assim o resultado fica idêntico
 * ao modelo que o Fabio aprovou (mesma fonte, mesma tabela, mesmas páginas):
 *   - cabeçalho verde-água do portal -> azul-marinho A&F;
 *   - realce das duas primeiras linhas (verde claro) -> azul claro;
 *   - tira a logo do portal e coloca a logo A&F no mesmo lugar.
 * Só a página 1 muda; as demais ficam byte a byte como vieram.
 */

// Mesma posição/tamanho do modelo aprovado (A4 paisagem 842x595).
const LOGO_BOX = { w: 122.29412, h: 56, x: 687.85299, y: 533 };

const COLOR_SWAPS: Array<[RegExp, string]> = [
  [/0\.141 0\.329 0\.345 (rg|RG)/g, '0.055 0.18 0.34 $1'],
  [/0\.74902 0\.94902 0\.80392 (rg|RG)/g, '0.83 0.90 0.98 $1'],
  [/0\.749 0\.949 0\.804 (rg|RG)/g, '0.83 0.90 0.98 $1'],
];

const LOGO_XOBJECT = 'AfLogo';

// Fundo branco explícito: PDF sem fundo vira PRETO em visualizador de tema escuro (e some o texto). Primeiro na pilha da página.
const whiteBg = (w: number, h: number) => `q 1 1 1 rg 0 0 ${w} ${h} re f Q\n`;


function pageContentStreams(doc: PDFDocument, pageIndex: number): Uint8Array[] {
  const page = doc.getPage(pageIndex);
  const raw = page.node.Contents();
  const out: Uint8Array[] = [];
  const push = (obj: unknown) => {
    if (obj instanceof PDFRawStream) out.push(decodePDFRawStream(obj).decode());
  };
  if (raw instanceof PDFArray) {
    for (let i = 0; i < raw.size(); i++) push(raw.lookup(i));
  } else if (raw) {
    push(raw);
  }
  return out;
}

function findPortalLogoName(page: ReturnType<PDFDocument['getPage']>): string | null {
  // A logo do portal é a imagem 319x68 do cabeçalho (nome /I0 no modelo atual).
  try {
    const xo = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    if (xo) {
      for (const key of xo.keys()) {
        const img = xo.lookup(key);
        if (img instanceof PDFRawStream) {
          const w = Number(img.dict.lookup(PDFName.of('Width'))?.toString());
          const h = Number(img.dict.lookup(PDFName.of('Height'))?.toString());
          if (w === 319 && h === 68) return key.decodeText();
        }
      }
    }
  } catch {
    /* sem logo reconhecida */
  }
  return null;
}

export interface BrandResult {
  pdf: Buffer;
  /** true = era o modelo do portal e saiu com a logo A&F; false = devolvido SEM mexer (outro tipo de PDF). */
  recognized: boolean;
}

/** Rápido e barato: o PDF do portal é gerado pelo PDFsharp (fica no dicionário de informações, sem compressão). */
export function looksLikePortalPdf(buf: Buffer): boolean {
  return buf.length > 1000 && buf.subarray(0, 5).toString('latin1') === '%PDF-' && buf.includes('PDFsharp');
}

export async function brandPortalPdf(input: Buffer): Promise<BrandResult> {
  if (!looksLikePortalPdf(input)) return { pdf: input, recognized: false };
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  const portalLogo = doc.getPageCount() ? findPortalLogoName(doc.getPage(0)) : null;
  if (!portalLogo) return { pdf: input, recognized: false }; // já marcado ou fora do modelo: não mexe
  const logo = await doc.embedPng(Buffer.from(AF_LOGO_BRANCA_PNG_BASE64, 'base64'));

  for (let i = 0; i < doc.getPageCount(); i++) {
    const page = doc.getPage(i);
    const streams = pageContentStreams(doc, i);
    if (!streams.length) continue;
    const { width: pw, height: ph } = page.getSize();
    let content = whiteBg(pw, ph) + streams.map((s) => Buffer.from(s).toString('latin1')).join('\n');

    for (const [re, to] of COLOR_SWAPS) content = content.replace(re, to);

    if (i === 0) {
      const drawRe = new RegExp(`q\\s+[-\\d.]+\\s+0\\s+0\\s+[-\\d.]+\\s+[-\\d.]+\\s+[-\\d.]+\\s+cm\\s*/${portalLogo}\\s+Do\\s*Q`, 'g');
      content = content.replace(drawRe, '');
      content += `\nq\n${LOGO_BOX.w} 0 0 ${LOGO_BOX.h} ${LOGO_BOX.x} ${LOGO_BOX.y} cm\n/${LOGO_XOBJECT} Do\nQ\n`;
      let res = page.node.Resources();
      if (!res) {
        res = doc.context.obj({});
        page.node.set(PDFName.of('Resources'), res);
      }
      let xo = res.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xo) {
        xo = doc.context.obj({});
        res.set(PDFName.of('XObject'), xo);
      }
      xo.set(PDFName.of(LOGO_XOBJECT), logo.ref as PDFRef);
    }

    const ref = doc.context.register(doc.context.flateStream(Buffer.from(content, 'latin1')));
    page.node.set(PDFName.of('Contents'), ref);
  }

  return { pdf: Buffer.from(await doc.save({ useObjectStreams: false })) /* sem object streams: com eles o pdf-lib gravava um XRef que o pdf.js recusa ("Invalid Root reference") e a Inbox ficava sem miniatura/visualização — 23/10 */, recognized: true };
}

// ── "Evolução Teórica" do portal do Inter (Chromium/Skia, A4 retrato) ───────────────────────────────
// Esse PDF vem do próprio banco, com a logo Inter no alto e sem faixa de cor. Ele continua intacto (a logo Inter identifica o
// banco); só entra uma faixa azul-marinho A&F no topo da página 1 com a nossa logo à direita — o mesmo visual do modelo do Credimorar.
const INTER_MARK = 'AeF-branded';
const INTER_BAND = { h: 40, logoH: 34, color: rgb(0.055, 0.18, 0.34) };

function hasInterLogoImage(page: ReturnType<PDFDocument['getPage']>): boolean {
  try {
    const xo = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict);
    if (!xo) return false;
    for (const key of xo.keys()) {
      const img = xo.lookup(key);
      if (img instanceof PDFRawStream) {
        const w = Number(img.dict.lookup(PDFName.of('Width'))?.toString());
        const h = Number(img.dict.lookup(PDFName.of('Height'))?.toString());
        if (w === 512 && h === 256) return true; // logo Inter do cabeçalho
      }
    }
  } catch {
    /* não é o modelo */
  }
  return false;
}

export async function brandInterTheoryPdf(input: Buffer): Promise<BrandResult> {
  if (input.length < 1000 || input.subarray(0, 5).toString('latin1') !== '%PDF-' || !input.includes('Skia/PDF')) return { pdf: input, recognized: false };
  const text = (await pdfParse(input, { max: 1 }).catch(() => null))?.text || '';
  if (!/Evolu[cç][aã]o\s*Te[oó]rica/i.test(text) || !/Proposta\s*de\s*Financiamento/i.test(text)) return { pdf: input, recognized: false };
  const doc = await PDFDocument.load(input, { updateMetadata: false });
  if (doc.getKeywords()?.includes(INTER_MARK)) return { pdf: input, recognized: false }; // já marcado
  const page = doc.getPage(0);
  if (!hasInterLogoImage(page)) return { pdf: input, recognized: false };
  const logo = await doc.embedPng(Buffer.from(AF_LOGO_BRANCA_PNG_BASE64, 'base64'));
  const { width, height } = page.getSize();
  // fundo branco explícito por baixo de tudo (tema escuro não pode virar fundo preto)
  const bg = doc.context.register(doc.context.flateStream(Buffer.from(whiteBg(width, height), 'latin1')));
  const prev = page.node.get(PDFName.of('Contents'));
  const stack = doc.context.obj([bg]) as PDFArray;
  if (prev instanceof PDFArray) prev.asArray().forEach((e) => stack.push(e));
  else if (prev) stack.push(prev);
  page.node.set(PDFName.of('Contents'), stack);
  page.drawRectangle({ x: 0, y: height - INTER_BAND.h, width, height: INTER_BAND.h, color: INTER_BAND.color });
  const lw = (INTER_BAND.logoH * logo.width) / logo.height;
  const rightMargin = 45; // alinha com a borda direita da tabela
  page.drawImage(logo, { x: width - rightMargin - lw, y: height - INTER_BAND.h + (INTER_BAND.h - INTER_BAND.logoH) / 2, width: lw, height: INTER_BAND.logoH });
  doc.setKeywords([INTER_MARK]);
  return { pdf: Buffer.from(await doc.save({ useObjectStreams: false })) /* sem object streams: com eles o pdf-lib gravava um XRef que o pdf.js recusa ("Invalid Root reference") e a Inbox ficava sem miniatura/visualização — 23/10 */, recognized: true };
}

/** Marca qualquer simulação conhecida (Credimorar "Evolução das parcelas" ou Inter "Evolução Teórica"); outro PDF volta intacto. */
export async function brandSimulationPdf(input: Buffer): Promise<BrandResult> {
  const a = await brandPortalPdf(input);
  if (a.recognized) return a;
  return brandInterTheoryPdf(input);
}

export interface SimulationInfo {
  pages: number;
  bank: string | null;
  date: string | null; // dd/mm/aaaa
}

/**
 * Lê banco e data do cabeçalho da página 1 (pra nome do arquivo e nota). O texto sai sem espaços
 * (pdf-parse), então o casamento ignora espaço; o nome do cliente vem do lead, não daqui.
 */
export async function readSimulationInfo(buf: Buffer): Promise<SimulationInfo> {
  const parsed = await pdfParse(buf, { max: 1 });
  const lines = parsed.text.split('\n').map((l) => l.trim()).filter(Boolean);
  const di = lines.findIndex((l) => /Data\s*da\s*simula[cç][aã]o/i.test(l));
  const date = di >= 0 ? /(\d{2}\/\d{2}\/\d{4})/.exec(lines[di])?.[1] || null : null;
  const bank = di >= 0 ? lines[di + 1] || null : null;
  return { pages: parsed.numpages, bank, date };
}

// ── Leitura dos DADOS do "Evolução Teórica" do Inter ─────────────────────────────────────────────
// O PDF sai do S3 do portal do Inter; aqui só se LÊ a tabela (o PDF final é desenhado no modelo do Credimorar, ver simulation-sheet.service.ts).
export interface InterTheoryRow { n: number; amort: number; juros: number; aj: number; seguros: number; tarifas: number; prestacao: number; saldo: number }
export interface InterTheory { header: Record<string, string>; rows: InterTheoryRow[] }

const brNum = (t: string) => Number(t.replace(/R\$/g, '').trim().replace(/\./g, '').replace(',', '.'));

async function pdfLines(buf: Buffer): Promise<string[]> {
  const lines: string[] = [];
  await pdfParse(buf, {
    pagerender: async (pageData: any) => {
      const tc = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      const byY = new Map<number, Array<{ s: string; x: number; w: number }>>();
      for (const i of tc.items) {
        const key = Math.round(i.transform[5]);
        (byY.get(key) || byY.set(key, []).get(key)!).push({ s: i.str, x: i.transform[4], w: i.width });
      }
      for (const y of [...byY.keys()].sort((a, b) => b - a)) {
        let out = '';
        let lastEnd = -1;
        for (const it of byY.get(y)!.sort((a, b) => a.x - b.x)) {
          if (lastEnd >= 0) out += it.x - lastEnd > 6 ? '\t' : it.x - lastEnd > 1.2 ? ' ' : '';
          out += it.s;
          lastEnd = it.x + it.w;
        }
        lines.push(out);
      }
      return '';
    },
  });
  return lines;
}

export async function parseInterTheoryPdf(buf: Buffer): Promise<InterTheory> {
  const lines = await pdfLines(buf);
  const header: Record<string, string> = {};
  const rows: InterTheoryRow[] = [];
  let closed = false; // só a 1ª tabela (nº 1, 2, 3…): o PDF traz depois outras tabelas de números (fluxo do CET) que não são parcelas
  for (const l of lines) {
    const cells = l.split('\t');
    if (cells.length === 8 && /^\d+$/.test(cells[0]) && cells.slice(1).every((c) => /^-?[\d.]+,\d{2}$/.test(c))) {
      if (closed) continue;
      const [n, amort, juros, aj, seguros, tarifas, prestacao, saldo] = cells;
      if (rows.length && Number(n) !== rows[rows.length - 1].n + 1) { closed = true; continue; }
      rows.push({ n: Number(n), amort: brNum(amort), juros: brNum(juros), aj: brNum(aj), seguros: brNum(seguros), tarifas: brNum(tarifas), prestacao: brNum(prestacao), saldo: brNum(saldo) });
    } else if (cells.length === 2 && !/^\d+$/.test(cells[0])) {
      header[cells[0].trim()] = cells[1].trim();
    }
  }
  if (!rows.length) throw new Error('não achei a tabela de parcelas no PDF do Inter');
  // Mais linhas que o prazo (já vimos PDF do Inter com 420 linhas pra 240 meses): vale o prazo.
  const prazo = Number(String(header['Prazo em meses'] || '').replace(/\D/g, '')) || 0;
  if (prazo && rows.length > prazo) rows.length = prazo;
  // Conferência de sanidade: as amortizações têm que somar (perto de) o financiamento com despesas.
  const financ = brNum(String(header['Valor do financiamento imobiliário c/ despesas'] || '0'));
  const soma = rows.reduce((t, r) => t + r.amort, 0);
  if (financ > 0 && Math.abs(soma - financ) / financ > 0.05) throw new Error(`os valores do PDF não fecham (amortizações somam ${soma.toFixed(2)} e o financiamento é ${financ.toFixed(2)})`);
  return { header, rows };
}

// ── Leitura dos DADOS do "Evolução das parcelas" do portal Credimorar (Santander) ─────────────────────
// Padrão da simulação de Home Equity (Fabio 26/10): o PDF do Santander deixa de ser o original do portal com a logo trocada e passa a ser desenhado pelo CRM no MESMO modelo
// do Inter e da Creditas (8 campos, sem CET/CESH/renda/entrada). Aqui só se LÊ o PDF do portal: resumo (tipo, prazo, sistema, valores, taxa efetiva), data e a tabela inteira.
export interface PortalSheetData {
  when: Date | null;
  tipoImovel: string;
  prazoMeses: number;
  sistema: string;
  valorImovel: number;
  valorEmprestimo: number;
  efetivaAA: number | null; // percentual (22,28 = 22,28% a.a.)
  rows: Array<{ n: number; amort: number; juros: number; mip: number; dfi: number; tsa: number; parcela: number; saldo: number }>;
}

export async function parsePortalSheetPdf(buf: Buffer): Promise<PortalSheetData> {
  const itens: Array<{ p: number; y: number; x: number; s: string }> = [];
  let page = 0;
  await pdfParse(buf, {
    pagerender: async (pageData: any) => {
      page++;
      const tc = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
      for (const i of tc.items) if (String(i.str).trim()) itens.push({ p: page, y: Math.round(i.transform[5]), x: i.transform[4], s: String(i.str).trim() });
      return '';
    },
  });
  const linha = (p: number, y: number) => itens.filter((i) => i.p === p && Math.abs(i.y - y) <= 1).sort((a, b) => a.x - b.x).map((i) => i.s).join(' ');
  const yDe = (re: RegExp) => itens.find((i) => i.p === 1 && re.test(i.s))?.y;
  // Resumo: a linha dos VALORES fica logo abaixo da linha dos rótulos (14 pt no modelo).
  const yTipo = yDe(/^Tipo$/i) ?? yDe(/Tipo de im[oó]vel/i);
  const yValor = itens.find((i) => i.p === 1 && /^Valor$/i.test(i.s) && i.x < 120)?.y ?? yDe(/Valor do im[oó]vel/i);
  if (yTipo == null || yValor == null) throw new Error('resumo do PDF fora do modelo');
  const v1 = linha(1, yTipo - 14);
  const v2 = linha(1, yValor - 14);
  const dinheiro = (t: string) => Array.from(t.matchAll(/R\$\s*([\d.]+,\d{2})/g)).map((m) => brNum(m[1]));
  const valores2 = dinheiro(v2);
  const efet = /([\d.]+,\d+)\s*%\s*a\.?\s*a/i.exec(v2);
  const prazo = /(\d+)\s*meses/i.exec(v1);
  const data = /(\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{1,2})h(\d{2})/.exec(itens.filter((i) => i.p === 1 && i.y > 500).sort((a, b) => a.x - b.x).map((i) => i.s).join(' '));
  // Tabela: cada linha tem 8 células — nº + 7 valores em R$.
  const porLinha = new Map<string, Array<{ x: number; s: string }>>();
  for (const i of itens) { const k = `${i.p}:${i.y}`; (porLinha.get(k) || porLinha.set(k, []).get(k)!).push({ x: i.x, s: i.s }); }
  const rows: PortalSheetData['rows'] = [];
  for (const k of Array.from(porLinha.keys()).sort((a, b) => { const [pa, ya] = a.split(':').map(Number); const [pb, yb] = b.split(':').map(Number); return pa - pb || yb - ya; })) {
    const cel = porLinha.get(k)!.sort((a, b) => a.x - b.x).map((c) => c.s);
    if (cel.length !== 8 || !/^\d+$/.test(cel[0]) || !cel.slice(1).every((c) => /^R\$\s*-?[\d.]+,\d{2}$/.test(c))) continue;
    const [amort, juros, mip, dfi, tsa, parcela, saldo] = cel.slice(1).map((c) => brNum(c));
    rows.push({ n: Number(cel[0]), amort, juros, mip, dfi, tsa, parcela, saldo });
  }
  if (!rows.length) throw new Error('tabela do PDF sem parcelas');
  if (valores2.length < 2) throw new Error('valor do imóvel/empréstimo não encontrados');
  return {
    when: data ? new Date(Date.UTC(+data[3], +data[2] - 1, +data[1], +data[4] + 3, +data[5])) : null, // horário de Brasília (UTC−3)
    tipoImovel: /comercial/i.test(v1) ? 'Comercial' : 'Residencial',
    prazoMeses: prazo ? Number(prazo[1]) : rows.filter((r) => r.parcela > 0).length,
    sistema: /\bPRICE\b/i.test(v1) ? 'PRICE' : 'SAC',
    valorImovel: valores2[0],
    valorEmprestimo: valores2[1],
    efetivaAA: efet ? brNum(efet[1]) : null,
    rows,
  };
}
