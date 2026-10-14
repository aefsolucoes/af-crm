import pdfParse from 'pdf-parse';
import { AF_LOGO_BRANCA_PNG_BASE64 } from './af-logo-branca';
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';

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
    let content = streams.map((s) => Buffer.from(s).toString('latin1')).join('\n');
    const before = content;

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
    } else if (content === before) {
      continue; // página intacta: não reescreve
    }

    const ref = doc.context.register(doc.context.flateStream(Buffer.from(content, 'latin1')));
    page.node.set(PDFName.of('Contents'), ref);
  }

  return { pdf: Buffer.from(await doc.save()), recognized: true };
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
