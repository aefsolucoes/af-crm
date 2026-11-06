import fs from 'fs';
import path from 'path';
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

/** "Requerimento para emissão de guia de ITBI" da Receita do DF — o PRÓPRIO modelo da pasta MODELOS DE FORMULARIO do Drive
 * ("REQ ITBI.doc", ITBI – 06/06/2023), convertido em PDF (assets/itbi/req-itbi-df.pdf); o CRM só escreve os dados por cima.
 * Fabio 06/11: "o documento precisa ser fiel ao que está lá na pasta" e "pode colocar só o primeiro vendedor".
 * Usado quando a DEITBI não aceita (ninguém da venda é dono no IPTU / lançamento de ofício): o cliente assina pelo gov.br.
 * Coordenadas em pontos PDF (origem embaixo à esquerda), medidas nos rótulos do modelo. Campo sem dado fica em branco. */
export type ReqItbiDados = {
  transmitente: { nome: string; cpf: string };
  adquirente: { nome: string; cpf: string };
  natureza: string;
  objeto: string;
  inscricao: string;
  areaConstruida: string;
  valor: string;
  percentual: string;
  dataPagamento: string; // dd/mm/aaaa
  responsavel: { nome: string; cpf: string; rg: string; rgEmissao: string; orgao: string; uf: string; email: string; telefone: string };
  data: { dia: string; mes: string; ano: string }; // "Brasília/DF, __ de ____ de 20__"
};

const MODELO = path.resolve(__dirname, '../../assets/itbi/req-itbi-df.pdf');
// Helvetica padrão só codifica WinAnsi: aspas curvas viram retas e o resto fora do Latin-1 sai.
const safe = (s: unknown) => String(s ?? '').normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\x20-\x7E -ÿ–—]/g, '').trim();
export const cpfFmt = (c: string) => { const d = String(c || '').replace(/\D/g, ''); return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : c; };

/** Escreve `texto` em (x, y) diminuindo a fonte até caber em `largura`. */
function escreve(page: PDFPage, font: PDFFont, texto: string, x: number, y: number, largura: number, tam = 9) {
  const t = safe(texto);
  if (!t) return;
  let s = tam;
  while (s > 5.5 && font.widthOfTextAtSize(t, s) > largura) s -= 0.25;
  page.drawText(t, { x, y, size: s, font, color: rgb(0, 0, 0.45) });
}

export async function montarRequerimentoItbiPdf(d: ReqItbiDados): Promise<Buffer> {
  const pdf = await PDFDocument.load(fs.readFileSync(MODELO));
  pdf.setTitle('Requerimento para emissão de guia de ITBI');
  const page = pdf.getPage(0);
  const f = await pdf.embedFont(StandardFonts.Helvetica);
  const r = d.responsavel;
  const [pd, pm, pa] = String(d.dataPagamento || '').split('/');
  const [ed, em, ea] = String(r.rgEmissao || '').split('/');

  escreve(page, f, d.transmitente.nome, 104, 739, 298);
  escreve(page, f, cpfFmt(d.transmitente.cpf), 456, 739, 100);
  escreve(page, f, d.adquirente.nome, 94, 716, 308);
  escreve(page, f, cpfFmt(d.adquirente.cpf), 456, 716, 100);
  escreve(page, f, d.natureza, 218, 690, 337);
  escreve(page, f, d.objeto, 44, 654, 512, 8.5);
  escreve(page, f, d.inscricao, 148, 638, 112);
  escreve(page, f, d.areaConstruida, 356, 635, 85);
  escreve(page, f, d.valor, 136, 609, 126);
  escreve(page, f, d.percentual, 374, 609, 66);
  if (pd) { escreve(page, f, pd, 461, 604, 12); escreve(page, f, pm || '', 489, 604, 14); escreve(page, f, pa || '', 510, 604, 40); }
  escreve(page, f, 'X', 108, 537, 8, 10); // ( X ) CONTRIBUINTE / ADQUIRENTE — quem assina pelo gov.br é o comprador
  escreve(page, f, r.nome, 44, 483, 510);
  escreve(page, f, cpfFmt(r.cpf), 44, 457, 150);
  escreve(page, f, r.rg, 203, 457, 136);
  if (ed) { escreve(page, f, ed, 355, 459, 12); escreve(page, f, em || '', 385, 459, 14); escreve(page, f, ea || '', 406, 459, 40); }
  escreve(page, f, r.orgao, 460, 457, 72);
  escreve(page, f, r.uf, 538, 457, 20);
  escreve(page, f, r.email, 74, 438, 266);
  escreve(page, f, r.telefone, 385, 438, 140);
  escreve(page, f, d.data.dia, 262, 420, 20);
  escreve(page, f, d.data.mes, 298, 420, 74);
  escreve(page, f, String(d.data.ano).slice(-2), 396, 420, 14);
  return Buffer.from(await pdf.save());
}
