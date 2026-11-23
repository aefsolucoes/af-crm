/* ── "Local e Data" dos formulários da CAIXA (Fabio 23/11: "todos os formulários que contenham local e data o CRM deve preencher… no caso, seria cidade/UF";
 * "vi que os da Fernanda foram sem local e data"). Os PDFs vêm prontos do Caixa Aqui (sem campos de formulário): o CRM acha o rótulo na página e escreve por
 * cima da linha, no mesmo lugar onde a própria CAIXA imprime quando preenche:
 *  - proposta de abertura de conta: "____ ,____ de ____ de ____" sobre "Local/Data" (págs. 1 e 4; a CAIXA põe só a data na 4) → cidade/UF + dia, mês e ano;
 *  - proposta do cartão: "  , de  de" sobre "Local/Data" (pág. 2) → cidade/UF antes da vírgula, dia, mês e ano entre os "de";
 *  - ficha cadastral: "LOCAL" e "DATA" lado a lado (a data a CAIXA já imprime) → cidade/UF em cima de LOCAL.
 * Só escreve onde está em branco; o "Data: ___/___/___" do correspondente/gerente não é do cliente e fica. */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

type Item = { s: string; x: number; y: number; w: number };
const MESES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];

/** Dia, mês por extenso e ano de hoje (Brasília). */
export function hojePartes(d = new Date()): { dia: string; mes: string; ano: string; curta: string } {
  const b = new Date(d.getTime() - 3 * 3600_000);
  const dia = String(b.getUTCDate()).padStart(2, '0');
  return { dia, mes: MESES[b.getUTCMonth()], ano: String(b.getUTCFullYear()), curta: `${dia}/${String(b.getUTCMonth() + 1).padStart(2, '0')}/${b.getUTCFullYear()}` };
}

async function itensPorPagina(buf: Buffer): Promise<Item[][]> {
  const pdfParse = require('pdf-parse') as (b: Buffer, o?: any) => Promise<unknown>;
  const pags: Item[][] = [];
  await pdfParse(buf, { pagerender: async (pd: any) => {
    const tc = await pd.getTextContent();
    pags.push(tc.items.map((i: any) => ({ s: String(i.str || ''), x: Number(i.transform[4]), y: Number(i.transform[5]), w: Number(i.width || 0) })));
    return '';
  } });
  return pags;
}

/** Escreve cidade/UF e a data nas linhas de "Local e Data" do cliente. Devolve o PDF e quantas linhas preencheu. */
export async function preencherLocalData(buf: Buffer, local: string, quando = new Date()): Promise<{ pdf: Buffer; linhas: number }> {
  const pags = await itensPorPagina(buf);
  const doc = await PDFDocument.load(buf, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const tam = 9.5;
  const cor = rgb(0, 0, 0);
  const h = hojePartes(quando);
  const larg = (t: string) => font.widthOfTextAtSize(t, tam);
  let linhas = 0;
  doc.getPages().forEach((page, i) => {
    const it = pags[i] || [];
    const escreve = (t: string, x: number, y: number) => page.drawText(t, { x, y, size: tam, font, color: cor });
    // 1) "Local/Data" (conta e cartão)
    for (const rot of it.filter((x) => /^\s*local\s*\/\s*data\s*$/i.test(x.s))) {
      const linha = it.filter((x) => x.y > rot.y + 5 && x.y < rot.y + 20 && x.s.trim());
      const virgula = linha.find((x) => x.s.trim() === ',');
      const des = linha.filter((x) => x.s.trim().toLowerCase() === 'de').sort((a, b) => a.x - b.x);
      const traco = linha.find((x) => /^_{5,}/.test(x.s.trim()));
      if (virgula && des.length >= 2) { // cartão: "  , de  de"
        const y = virgula.y + 5; // o traço do cartão passa ~3 pt acima da linha do texto: escreve por cima dele
        escreve(local, rot.x, y);
        escreve(h.dia, virgula.x + virgula.w + 10, y);
        escreve(h.mes, des[0].x + des[0].w + 12, y);
        escreve(h.ano, des[1].x + des[1].w + 8, y);
        linhas++;
      } else if (traco) { // conta: "____ ,____ de ____ de ____"
        const y = traco.y + 4;
        const jaTemData = it.some((x) => x.y > traco.y && x.y < traco.y + 12 && /^\d{1,4}$|^[A-ZÇ]{4,}$/.test(x.s.trim()));
        escreve(local, traco.x + 6, y);
        // mesmos lugares em que a CAIXA imprime a data na pág. 4 (dia em +207, mês em +311, ano em +476 da linha)
        if (!jaTemData) { escreve(h.dia, traco.x + 207, y); escreve(h.mes, traco.x + 311, y); escreve(h.ano, traco.x + 476, y); }
        linhas++;
      }
    }
    // 2) "LOCAL" e "DATA" lado a lado (ficha cadastral)
    for (const L of it.filter((x) => x.s.trim() === 'LOCAL')) {
      const D = it.find((x) => x.s.trim() === 'DATA' && Math.abs(x.y - L.y) < 3 && x.x > L.x);
      if (!D) continue;
      const data = it.find((x) => /^\d{2}\/\d{2}\/\d{4}$/.test(x.s.trim()) && x.y > D.y && x.y < D.y + 20);
      const y = data ? data.y : L.y + 14;
      const ocupado = it.some((x) => x.y > L.y + 3 && x.y < L.y + 20 && x.x < D.x - 20 && x.s.trim() && x !== data);
      if (!ocupado) escreve(local, L.x + L.w / 2 - larg(local) / 2, y);
      if (!data) escreve(h.curta, D.x + D.w / 2 - larg(h.curta) / 2, y);
      linhas++;
    }
  });
  return { pdf: Buffer.from(await doc.save()), linhas };
}
