import fs from 'fs';
import path from 'path';
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import JSZip from 'jszip';

/**
 * Formulários da vistoria do Santander (Fabio 21/10): a vistoria sai por e-mail e leva DOIS anexos que o CRM preenche:
 *  1) "Autorização do(s) Cliente(s) para USECASA" (PDF) → vai ao cliente, que assina pelo gov.br e devolve;
 *  2) "Cadastro de Informações - WEB CASAS" (Word) → vai por e-mail à Letícia, junto com o PDF assinado e os documentos.
 * Aqui só a parte PURA (sem banco de dados): ler a proposta do site, preencher o PDF e o Word. O fluxo está em vistoria-santander.service.ts.
 */

const ASSETS = path.resolve(__dirname, '../../assets/santander');
export const MARCA_USECASA = 'AF-USECASA'; // vai nas palavras-chave do PDF: o PDF assinado pelo gov.br mantém isso e o CRM reconhece o retorno

// ─── Dados da proposta do site ("Proposta preenchida no site — …": uma linha "Campo: valor" por informação) ───
export function camposDaProposta(texto: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of String(texto || '').split('\n')) {
    const m = /^\s*([^:\n]{2,40}):\s*(.+?)\s*$/.exec(l);
    if (m && !(m[1] in out)) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

const titulo = (s: string) => s.toLowerCase().replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase()).replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase());
const digitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');
export const fmtCpf = (s: unknown) => { const d = digitos(s); return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : String(s ?? ''); };
const sp = (n: number) => String(n).padStart(2, '0');
const hojeBR = () => { const d = new Date(Date.now() - 3 * 3600_000); return `${sp(d.getUTCDate())}/${sp(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };

export type Participante = { nome: string; cpf: string };
/** Nomes e CPFs do 1º e do 2º participante: card primeiro, proposta depois. */
export function participantesDe(cf: Record<string, any>, campos: Record<string, string>, leadName: string): { p1: Participante; p2: Participante | null } {
  const p1 = { nome: String(cf.participante_1 || campos['Nome completo'] || leadName || '').trim(), cpf: fmtCpf(cf.cpf_1 || campos['CPF'] || '') };
  const n2 = String(cf.participante_2 || campos['2º Participante'] || '').trim();
  const p2 = n2 ? { nome: n2, cpf: fmtCpf(cf.cpf_2 || campos['CPF 2º'] || '') } : null;
  return { p1, p2 };
}

/** Remove do PDF os campos do tipo botão (da lista de campos e das anotações da página). */
function tiraBotoes(pdf: PDFDocument) {
  const ehBotao = (o: any) => o instanceof PDFDict && String(o.get(PDFName.of('FT'))) === '/Btn';
  const acro = pdf.catalog.lookup(PDFName.of('AcroForm'));
  const campos = acro instanceof PDFDict ? acro.lookup(PDFName.of('Fields')) : undefined;
  if (campos instanceof PDFArray) {
    for (let i = campos.size() - 1; i >= 0; i--) if (ehBotao(campos.lookup(i))) campos.remove(i);
  }
  for (const page of pdf.getPages()) {
    const an = page.node.Annots();
    if (!an) continue;
    for (let i = an.size() - 1; i >= 0; i--) if (ehBotao(an.lookup(i))) an.remove(i);
  }
}

// ─── 1) Autorização USECASA (PDF) ───
export async function preencherAutorizacaoUsecasa(p: { p1: Participante; p2: Participante | null; cidade: string; leadId: string }): Promise<Buffer> {
  const pdf = await PDFDocument.load(fs.readFileSync(path.join(ASSETS, 'usecasa-autorizacao.pdf')));
  tiraBotoes(pdf); // os botões do modelo (imprimir/limpar) não têm aparência e travam o flatten
  const form = pdf.getForm();
  form.getTextField('Nome 1º proponente').setText(titulo(p.p1.nome));
  form.getTextField('CPF 1º proponente').setText(p.p1.cpf);
  if (p.p2) {
    form.getTextField('Nome 2º proponente').setText(titulo(p.p2.nome));
    form.getTextField('CPF 2º proponente').setText(p.p2.cpf);
  }
  form.getTextField('Local e Data').setText(`${p.cidade ? `${p.cidade}, ` : ''}${hojeBR()}`);
  form.updateFieldAppearances();
  form.flatten();
  pdf.setKeywords([`${MARCA_USECASA}-${p.leadId}`]);
  pdf.setTitle('Autorização USECASA');
  return Buffer.from(await pdf.save());
}

/** O arquivo devolvido é o nosso formulário (palavra-chave) e está assinado digitalmente (gov.br grava /ByteRange)? Pura sobre os bytes (testável). */
export async function inspecionarRetornoUsecasa(bytes: Buffer, leadId: string): Promise<{ nosso: boolean; assinado: boolean }> {
  const assinado = bytes.includes(Buffer.from('/ByteRange'));
  let nosso = false;
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    nosso = String(doc.getKeywords() || '').includes(`${MARCA_USECASA}-${leadId}`);
  } catch { nosso = false; }
  return { nosso, assinado };
}

// ─── 2) Cadastro WEB CASAS (Word) ───
type Op = { i: number; texto?: string; marca?: number };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PARAGRAFO = /<w:p[ >][\s\S]*?<\/w:p>/g;

function acrescentaTexto(pxml: string, texto: string): string {
  const ts = [...pxml.matchAll(/<w:t(?: [^>]*)?>[\s\S]*?<\/w:t>/g)].filter((m) => !m[0].startsWith('<w:tab'));
  if (!ts.length) { // parágrafo vazio: cria uma linha de texto
    return pxml.replace(/<\/w:p>$/, `<w:r><w:t xml:space="preserve">${esc(texto)}</w:t></w:r></w:p>`);
  }
  const ult = ts[ts.length - 1];
  const interno = ult[0].replace(/^<w:t(?: [^>]*)?>/, '').replace(/<\/w:t>$/, '');
  const sep = /\s$/.test(interno) ? '' : ' ';
  const novo = `<w:t xml:space="preserve">${interno}${sep}${esc(texto)}</w:t>`;
  return pxml.slice(0, ult.index!) + novo + pxml.slice(ult.index! + ult[0].length);
}

function marcaOpcao(pxml: string, n: number): string {
  let k = -1;
  let out = pxml.replace(/☐/g, (m) => { k++; return k === n ? '☒' : m; });
  // controles de conteúdo (caixa de seleção do Word): troca o n-ésimo "desmarcado" também
  let j = -1;
  out = out.replace(/<w14:checked w14:val="0"\/>/g, (m) => { j++; return j === n ? '<w14:checked w14:val="1"/>' : m; });
  return out;
}

/** Aplica as operações (índice do parágrafo no modelo → texto a acrescentar e/ou opção a marcar). Pura (testável). */
export function aplicarOps(documentXml: string, ops: Op[]): string {
  const porIndice = new Map<number, Op[]>();
  for (const o of ops) porIndice.set(o.i, [...(porIndice.get(o.i) || []), o]);
  let idx = -1;
  return documentXml.replace(PARAGRAFO, (p) => {
    idx++;
    const os = porIndice.get(idx);
    if (!os) return p;
    let q = p;
    for (const o of os) {
      if (o.marca !== undefined) q = marcaOpcao(q, o.marca);
      if (o.texto) q = acrescentaTexto(q, o.texto);
    }
    return q;
  });
}

const ufDe = (s: string) => (/\/\s*([A-Za-z]{2})\s*$/.exec(s) || [])[1]?.toUpperCase() || '';
const cidadeDe = (s: string) => String(s || '').replace(/\s*\/\s*[A-Za-z]{2}\s*$/, '').trim();

export type DadosWebCasas = { ops: Op[]; faltando: string[]; cidadeImovel: string };

/** Monta as operações do modelo a partir da proposta do site + card. Só preenche o que se SABE; o resto vira "faltando" (nota pra equipe). Vendedor não se aplica (o cliente é o dono do imóvel). */
export function dadosWebCasas(cf: Record<string, any>, campos: Record<string, string>, leadName: string, contato: { pessoa: string; telefone: string }): DadosWebCasas {
  const ops: Op[] = [];
  const faltando: string[] = [];
  const { p1, p2 } = participantesDe(cf, campos, leadName);
  const t = (i: number, texto: unknown) => { const s = String(texto ?? '').trim(); if (s) ops.push({ i, texto: s }); return !!s; };
  const m = (i: number, n: number) => ops.push({ i, marca: n });

  // Comprador (o cabeçalho do modelo não tem linha de nome/CPF: vai no parágrafo vazio logo abaixo)
  t(3, `Nome: ${titulo(p1.nome)}    CPF: ${p1.cpf}`);
  const genero = norm(campos['Gênero']);
  if (genero.startsWith('fem')) m(4, 0); else if (genero.startsWith('masc')) m(4, 1); else faltando.push('sexo do comprador');
  const cargo = campos['Cargo / Profissão'] || campos['Profissão'] || '';
  const perfil = /empres|s[oó]cio|propriet/i.test(cargo) ? 'empresário' : /aut[oô]nom|liberal|mei\b/i.test(cargo) ? 'autônomo' : cargo ? 'assalariado' : '';
  if (!t(5, perfil)) faltando.push('perfil de renda');
  t(6, cargo); t(7, cargo);
  if (!t(8, campos['Celular'] || cf.telefone_1)) faltando.push('telefone do comprador');
  const ec = campos['Estado civil'] || '';
  if (!t(9, ec)) faltando.push('estado civil');
  if (ec) m(10, /uni[aã]o/i.test(ec) ? 0 : 1);
  if (/casad/i.test(ec)) faltando.push('data do casamento e regime de comunhão');
  t(13, campos['Nacionalidade'] || 'BRASILEIRA');
  const doc = campos['Documento'] || '';
  const tipoDoc = /cnh/i.test(doc) ? 1 : /\brg\b/i.test(doc) ? 0 : -1;
  if (tipoDoc >= 0) m(14, tipoDoc);
  const nDoc = (/n[º°]\.?\s*(\d[\w.-]*)/i.exec(doc) || /(\d[\d.\-/]{4,})/.exec(doc) || [])[1];
  if (!t(15, nDoc)) faltando.push('número do documento');
  const orgao = campos['Órgão expedidor'] || '';
  t(16, orgao.replace(/\/\s*[A-Za-z]{2}\s*$/, '')); t(17, ufDe(orgao));
  if (!t(18, campos['Data expedição doc'])) faltando.push('data de expedição do documento');
  t(19, 'Não'); t(20, 'Não');
  const logradouro = campos['Logradouro'] || '';
  const mEnd = /^(.*?)(?:,\s*|\s+)(\d+[\w-]*)?\s*$/.exec(logradouro);
  const rua = (mEnd?.[1] || logradouro).trim(); const num = mEnd?.[2] || '';
  const res = { cep: campos['CEP'] || '', tipo: /^av/i.test(rua) ? 2 : /^lad/i.test(rua) ? 1 : /^rua|^r\./i.test(rua) ? 0 : -1, rua: rua.replace(/^(rua|avenida|av\.?|ladeira)\s+/i, ''), num, bairro: campos['Bairro'] || '', cidade: cidadeDe(campos['Cidade/UF residência'] || ''), uf: ufDe(campos['Cidade/UF residência'] || '') };
  t(21, res.cep); if (res.tipo >= 0) m(22, res.tipo); t(23, res.rua); t(24, res.num); t(26, res.bairro); t(27, res.cidade); t(28, res.uf);

  // Cônjuge / convivente (só se o 2º participante é cônjuge ou companheiro)
  const rel = campos['Relação'] || '';
  if (p2 && /c[oô]njuge|companheir/i.test(rel)) {
    t(41, p2.cpf); m(42, 0); t(43, titulo(p2.nome)); t(46, campos['Celular 2º']); t(56, 'Não');
    faltando.push('documento, profissão e e-mail do cônjuge');
  } else if (p2) faltando.push(`2º participante (${titulo(p2.nome)}) não é cônjuge: conferir se entra no cadastro`);

  // Imóvel: o endereço do imóvel só entra se ele é a residência própria do cliente na mesma cidade da garantia
  const garantia = campos['Imóvel em garantia'] || '';
  const mesmaCidade = !!garantia && !!res.cidade && norm(cidadeDe(garantia)) === norm(res.cidade);
  const propria = /pr[oó]pri/i.test(campos['Tipo de residência'] || '');
  const cidadeImovel = cidadeDe(garantia) || res.cidade;
  if (mesmaCidade && propria && res.cep) {
    t(63, res.cep); if (res.tipo >= 0) m(64, res.tipo); t(65, res.rua); t(66, res.num); t(68, res.bairro); t(69, res.cidade); t(70, res.uf);
  } else { t(69, cidadeImovel); t(70, ufDe(garantia)); faltando.push('endereço completo do imóvel (CEP, rua, número, bairro)'); }
  const tipoImovel = campos['Tipo do imóvel'] || String(cf.imovel_tipo || '');
  if (/apart/i.test(tipoImovel)) m(71, 0); else if (/casa|sobrado/i.test(tipoImovel)) m(71, 1); else faltando.push('tipo do imóvel');
  const quitado = campos['Imóvel quitado'] || '';
  t(72, /^sim/i.test(quitado) ? 'Não (quitado)' : quitado ? 'Sim' : '');
  t(73, contato.pessoa); t(74, contato.telefone);
  faltando.push('agência e conta para débito (se o banco pedir)');
  return { ops, faltando, cidadeImovel };
}

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

export async function preencherWebCasas(ops: Op[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(ASSETS, 'web-casas-cadastro.docx')));
  const xml = await zip.file('word/document.xml')!.async('string');
  zip.file('word/document.xml', aplicarOps(xml, ops));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
