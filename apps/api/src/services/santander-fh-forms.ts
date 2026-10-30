import fs from 'fs';
import path from 'path';
import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
import JSZip from 'jszip';
import { aplicarOps, fmtCpf } from './santander-forms';

/**
 * Formulários da vistoria do Santander no FINANCIAMENTO (aquisição) — Fabio 30/10: "são 3 formulários, todos deverão ser preenchidos; os 2 em PDF vão ao cliente pra assinar pelo gov.br,
 * o outro (Word) só precisa ser preenchido":
 *  1) "Autorização do(s) Comprador(es) para Aquisição de Imóvel" (PDF) — nomes e CPFs dos compradores + local e data;
 *  2) "Declaração Pessoal de Saúde e Atividade do(s) Comprador(es)" (PDF) — imóvel residencial, seguradora, prazo, nomes, nascimentos, profissão, local e data e as respostas
 *     (Sim/Não) que o CLIENTE confirmou pelo WhatsApp (nunca presumidas);
 *  3) "Ficha para cadastro — aquisição" (Word) — comprador(es), cônjuge, imóvel, contato da vistoria, vendedor e conta para crédito.
 * Aqui só a parte PURA (sem banco de dados). O fluxo está em vistoria-santander-fh.service.ts.
 */

const ASSETS = path.resolve(__dirname, '../../assets/santander');
export const MARCA_AUT_FH = 'AF-SANTFH-AUT';
export const MARCA_SAUDE_FH = 'AF-SANTFH-SAUDE';

const sp = (n: number) => String(n).padStart(2, '0');
const hojeBR = () => { const d = new Date(Date.now() - 3 * 3600_000); return `${sp(d.getUTCDate())}/${sp(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`; };
const titulo = (s: string) => String(s || '').toLowerCase().replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase()).replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase());
const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const digitos = (s: unknown) => String(s ?? '').replace(/\D/g, '');

/** Remove os botões do modelo (imprimir/próxima/anterior): não têm aparência e travam o flatten. */
function tiraBotoes(pdf: PDFDocument) {
  const ehBotaoPush = (o: any) => o instanceof PDFDict && String(o.get(PDFName.of('FT'))) === '/Btn' && /^Button \d+$/.test(String((o.get(PDFName.of('T')) as any)?.decodeText?.() ?? ''));
  const acro = pdf.catalog.lookup(PDFName.of('AcroForm'));
  const campos = acro instanceof PDFDict ? acro.lookup(PDFName.of('Fields')) : undefined;
  if (campos instanceof PDFArray) for (let i = campos.size() - 1; i >= 0; i--) if (ehBotaoPush(campos.lookup(i))) campos.remove(i);
  for (const page of pdf.getPages()) {
    const an = page.node.Annots();
    if (!an) continue;
    for (let i = an.size() - 1; i >= 0; i--) if (ehBotaoPush(an.lookup(i))) an.remove(i);
  }
}

export type CompradorFh = { nome: string; cpf: string; nascimento?: string; profissao?: string };

// ─── 1) Autorização (PDF) ───
export async function preencherAutorizacaoFh(p: { c1: CompradorFh; c2: CompradorFh | null; cidade: string; leadId: string }): Promise<Buffer> {
  const pdf = await PDFDocument.load(fs.readFileSync(path.join(ASSETS, 'fh-autorizacao.pdf')));
  tiraBotoes(pdf);
  const form = pdf.getForm();
  form.getTextField('Nome 1º comprador').setText(titulo(p.c1.nome));
  form.getTextField('CPF 1º comprador').setText(fmtCpf(p.c1.cpf));
  if (p.c2) {
    form.getTextField('Nome 2º comprador').setText(titulo(p.c2.nome));
    form.getTextField('CPF 2º comprador').setText(fmtCpf(p.c2.cpf));
  }
  form.getTextField('Local e Data').setText(`${p.cidade ? `${p.cidade}, ` : ''}${hojeBR()}`);
  form.updateFieldAppearances();
  form.flatten();
  pdf.setKeywords([`${MARCA_AUT_FH}-${p.leadId}`]);
  pdf.setTitle('Autorização do(s) Comprador(es) - Santander');
  return Buffer.from(await pdf.save());
}

// ─── 2) Declaração de saúde (PDF) ───
/** Perguntas Sim/Não do modelo (versão Aquisição 0238-S01 — SETEMBRO/2025): página, altura do rótulo de cada proponente, x dos rótulos "Não"/"Sim" e a resposta de quem CONFIRMOU a lista padrão. */
const PERGUNTAS: { pg: number; y1: number; y2: number; xNao: number; xSim: number; padrao: 'NAO' | 'SIM'; texto: string }[] = [
  { pg: 0, y1: 526, y2: 506, xNao: 112, xSim: 145, padrao: 'NAO', texto: 'pratica esporte radical ou perigoso' },
  { pg: 0, y1: 467, y2: 446, xNao: 112, xSim: 145, padrao: 'SIM', texto: 'está em plena atividade de trabalho' },
  { pg: 0, y1: 307, y2: 286, xNao: 111, xSim: 144, padrao: 'NAO', texto: 'aposentado por invalidez ou afastado pela previdência' },
  { pg: 0, y1: 237, y2: 217, xNao: 111, xSim: 144, padrao: 'NAO', texto: 'atividade com esforço repetitivo, insalubre ou perigosa' },
  { pg: 0, y1: 166, y2: 145, xNao: 111, xSim: 143, padrao: 'NAO', texto: 'já afastado do trabalho por doença ou acidente' },
  { pg: 0, y1: 82, y2: 61, xNao: 111, xSim: 143, padrao: 'SIM', texto: 'em plenas condições de saúde' },
  { pg: 1, y1: 718, y2: 698, xNao: 113, xSim: 145, padrao: 'NAO', texto: 'doença/tratamento contínuo ou cirurgia prevista' },
  { pg: 1, y1: 610, y2: 589, xNao: 113, xSim: 146, padrao: 'NAO', texto: 'tratamento por LER/DORT ou psiquiátrico' },
  { pg: 1, y1: 521, y2: 500, xNao: 112, xSim: 145, padrao: 'NAO', texto: 'internação para tratamento clínico ou cirúrgico' },
  { pg: 1, y1: 440, y2: 419, xNao: 113, xSim: 146, padrao: 'NAO', texto: 'deformidade, deficiência ou redução funcional' },
];
/** Linhas da "principal atividade profissional" (página 1). */
const PROFISSAO_Y = { c1: 381, c2: 360 };
export type SeguroFh = 'ZURICH' | 'SANTANDER_AUTO';

/** Preenche a declaração. `respostasPadrao` = o cliente CONFIRMOU no WhatsApp a lista padrão (saúde plena etc.): marca as respostas. Sem confirmação, os Sim/Não ficam em branco. */
export async function preencherDeclaracaoSaude(p: { c1: CompradorFh; c2: CompradorFh | null; prazoMeses: number | null; cidade: string; leadId: string; seguro: SeguroFh; respostasPadrao: boolean }): Promise<Buffer> {
  const pdf = await PDFDocument.load(fs.readFileSync(path.join(ASSETS, 'fh-declaracao-saude.pdf')));
  tiraBotoes(pdf);
  const form = pdf.getForm();
  try { form.getRadioGroup('Declaração Pessoal de Saúde e Atividade').select('Imóvel Residencial'); } catch { /* modelo diferente: fica em branco */ }
  try { form.getRadioGroup('seguros').select(p.seguro === 'SANTANDER_AUTO' ? 'Choice2' : 'Choice1'); } catch { /* idem */ }
  if (p.prazoMeses) form.getTextField('Prazo do Contrato').setText(String(p.prazoMeses));
  form.getTextField('Nome do 1o Proponente').setText(titulo(p.c1.nome));
  form.getTextField('Data de Nascimento_7').setText(p.c1.nascimento || '');
  if (p.c2) {
    form.getTextField('Nome do 2o Proponente').setText(titulo(p.c2.nome));
    form.getTextField('Data de Nascimento_8').setText(p.c2.nascimento || '');
  }
  form.getTextField('Local e Data_2').setText(`${p.cidade ? `${p.cidade}, ` : ''}${hojeBR()}`);
  form.updateFieldAppearances();
  form.flatten();
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const fontN = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  if (p.c1.profissao) pages[0].drawText(p.c1.profissao.slice(0, 90), { x: 104, y: PROFISSAO_Y.c1, size: 9, font: fontN, color: rgb(0, 0, 0) });
  if (p.c2?.profissao) pages[0].drawText(p.c2.profissao.slice(0, 90), { x: 104, y: PROFISSAO_Y.c2, size: 9, font: fontN, color: rgb(0, 0, 0) });
  if (p.respostasPadrao) {
    for (const q of PERGUNTAS) {
      const x = (q.padrao === 'SIM' ? q.xSim : q.xNao) - 10.5;
      for (const y of p.c2 ? [q.y1, q.y2] : [q.y1]) pages[q.pg].drawText('X', { x, y: y + 0.5, size: 9, font, color: rgb(0, 0, 0) });
    }
  }
  pdf.setKeywords([`${MARCA_SAUDE_FH}-${p.leadId}`]);
  pdf.setTitle('Declaração Pessoal de Saúde e Atividade - Santander');
  return Buffer.from(await pdf.save());
}

/** O arquivo devolvido é o NOSSO formulário (palavra-chave) e está assinado digitalmente (gov.br grava /ByteRange)? Pura sobre os bytes. */
export async function inspecionarRetornoFh(bytes: Buffer, leadId: string): Promise<{ qual: 'AUT' | 'SAUDE' | null; assinado: boolean }> {
  const assinado = bytes.includes(Buffer.from('/ByteRange'));
  let qual: 'AUT' | 'SAUDE' | null = null;
  try {
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const kw = String(doc.getKeywords() || '');
    if (kw.includes(`${MARCA_AUT_FH}-${leadId}`)) qual = 'AUT';
    else if (kw.includes(`${MARCA_SAUDE_FH}-${leadId}`)) qual = 'SAUDE';
  } catch { qual = null; }
  return { qual, assinado };
}

// ─── 3) Ficha para cadastro — aquisição (Word) ───
type Op = { i: number; texto?: string; marca?: number };

/** Pessoa como vem da ficha cadastral (leitura dos documentos) — só os campos usados aqui. */
export type PessoaFicha = {
  nome?: string | null; cpf?: string | null; nascimento?: string | null; sexo?: string | null; nacionalidade?: string | null; estadoCivil?: string | null; regimeBens?: string | null; dataCasamento?: string | null;
  identidade?: { tipo?: string | null; numero?: string | null; orgao?: string | null; uf?: string | null; emissao?: string | null } | null;
  endereco?: { logradouro?: string | null; numero?: string | null; complemento?: string | null; bairro?: string | null; cidade?: string | null; uf?: string | null; cep?: string | null } | null;
  profissao?: string | null; trabalho?: { vinculo?: string | null; cargo?: string | null } | null; semRenda?: boolean;
  telefone?: string | null; email?: string | null;
};
export type ContaCredito = { titular?: string; banco?: string; agencia?: string; conta?: string; digito?: string; tipo?: string };
export type ImovelFh = { cep?: string; logradouro?: string; numero?: string; complemento?: string; bairro?: string; cidade?: string; uf?: string; tipo?: string };

const tipoLogradouro = (rua: string) => (/^av/i.test(rua) ? 2 : /^lad/i.test(rua) ? 1 : /^(rua|r\.)/i.test(rua) ? 0 : -1);
const semTipo = (rua: string) => rua.replace(/^(rua|r\.|avenida|av\.?|ladeira)\s+/i, '').trim();
const perfilRenda = (p: PessoaFicha) => {
  const v = norm(p.trabalho?.vinculo);
  if (p.semRenda) return 'sem renda';
  if (/empresario/.test(v)) return 'empresário';
  if (/autonomo/.test(v)) return 'autônomo';
  if (/aposentado/.test(v)) return 'aposentado';
  if (/clt|servidor/.test(v)) return 'assalariado';
  return '';
};

/** Bloco de uma pessoa com os índices dos parágrafos do modelo. Pura. */
function blocoPessoa(t: (i: number, s: unknown) => boolean, m: (i: number, n: number) => void, p: PessoaFicha, ix: Record<string, number>, faltando: string[], quem: string) {
  const sexo = norm(p.sexo);
  if (ix.sexo !== undefined) { if (sexo.startsWith('f')) m(ix.sexo, 0); else if (sexo.startsWith('m')) m(ix.sexo, 1); else faltando.push(`sexo ${quem}`); }
  if (ix.profissao !== undefined && !t(ix.profissao, p.profissao || p.trabalho?.cargo)) faltando.push(`profissão ${quem}`);
  if (ix.cargo !== undefined) t(ix.cargo, p.trabalho?.cargo);
  if (ix.telefone !== undefined && !t(ix.telefone, p.telefone)) faltando.push(`telefone ${quem}`);
  if (ix.email !== undefined && !t(ix.email, p.email)) faltando.push(`e-mail ${quem}`);
  const ec = String(p.estadoCivil || '');
  if (ix.estadoCivil !== undefined && !t(ix.estadoCivil, ec)) faltando.push(`estado civil ${quem}`);
  if (ix.nascimento !== undefined && !t(ix.nascimento, p.nascimento)) faltando.push(`data de nascimento ${quem}`);
  if (ix.uniao !== undefined && ec) m(ix.uniao, /uni[aã]o/i.test(ec) ? 0 : 1);
  if (ix.dataCasamento !== undefined) t(ix.dataCasamento, p.dataCasamento);
  if (ix.regime !== undefined) t(ix.regime, p.regimeBens);
  if (ix.nacionalidade !== undefined) t(ix.nacionalidade, p.nacionalidade || 'BRASILEIRA');
  const id = p.identidade || {};
  const tipoDoc = /cnh/i.test(String(id.tipo || '')) ? 1 : /rg/i.test(String(id.tipo || '')) ? 0 : -1;
  if (ix.documento !== undefined && tipoDoc >= 0) m(ix.documento, tipoDoc);
  if (ix.numDoc !== undefined && !t(ix.numDoc, id.numero)) faltando.push(`número do documento ${quem}`);
  if (ix.orgao !== undefined) t(ix.orgao, id.orgao);
  if (ix.ufDoc !== undefined) t(ix.ufDoc, id.uf);
  if (ix.emissao !== undefined) t(ix.emissao, id.emissao);
  if (ix.procurador !== undefined) { if (ix.procuradorMarca) m(ix.procurador, 1); else t(ix.procurador, 'Não'); }
  if (ix.cep !== undefined) {
    const e = p.endereco || {};
    const rua = String(e.logradouro || '').trim();
    t(ix.cep, e.cep); const tp = tipoLogradouro(rua); if (tp >= 0) m(ix.tipoEnd, tp);
    t(ix.rua, semTipo(rua)); t(ix.num, e.numero); t(ix.compl, e.complemento); t(ix.bairro, e.bairro); t(ix.cidade, e.cidade); t(ix.uf, e.uf);
    if (!e.cep || !rua) faltando.push(`endereço ${quem}`);
  }
}

/** Monta as operações da ficha. Só preenche o que se SABE; o resto vira "faltando". Pura (testável). */
export function dadosFichaFh(d: {
  compradores: PessoaFicha[]; vendedores: PessoaFicha[]; conta: ContaCredito | null; imovel: ImovelFh; contato: { pessoa: string; telefone: string }; usaFgts: boolean; financiado?: string;
}): { ops: Op[]; faltando: string[] } {
  const ops: Op[] = [];
  const faltando: string[] = [];
  const t = (i: number, texto: unknown) => { const s = String(texto ?? '').trim(); if (s) ops.push({ i, texto: s }); return !!s; };
  const m = (i: number, n: number) => ops.push({ i, marca: n });
  const [c1, c2] = d.compradores;
  if (!c1) return { ops, faltando: ['dados do comprador (ficha cadastral)'] };

  // Comprador (o cabeçalho não tem linha de nome/CPF: vai no parágrafo vazio logo abaixo)
  t(3, `Nome: ${titulo(c1.nome || '')}    CPF: ${fmtCpf(c1.cpf)}`);
  if (!t(5, perfilRenda(c1))) faltando.push('perfil de renda do comprador');
  blocoPessoa(t, m, c1, { sexo: 4, profissao: 6, cargo: 7, telefone: 8, estadoCivil: 9, nascimento: 10, uniao: 11, dataCasamento: 12, regime: 13, nacionalidade: 14, documento: 15, numDoc: 16, orgao: 17, ufDoc: 18, emissao: 19, procurador: 20,
    cep: 22, tipoEnd: 23, rua: 24, num: 25, compl: 26, bairro: 27, cidade: 28, uf: 29 }, faltando, 'do comprador');
  t(21, d.usaFgts ? 'Sim' : 'Não');
  if (/casad/i.test(String(c1.estadoCivil || '')) && (!c1.dataCasamento || !c1.regimeBens)) faltando.push('data do casamento e regime de comunhão');

  // Cônjuge / 2º comprador
  if (c2) {
    t(42, fmtCpf(c2.cpf)); m(43, 0); t(44, titulo(c2.nome || ''));
    const mesmo = !!c1.endereco?.cep && digitos(c1.endereco?.cep) === digitos(c2.endereco?.cep);
    blocoPessoa(t, m, c2, { nascimento: 45, sexo: 46, profissao: 47, telefone: 48, email: 49, nacionalidade: 50, documento: 51, numDoc: 52, orgao: 53, ufDoc: 54, emissao: 55, procurador: 56, procuradorMarca: 1 }, faltando, 'do 2º comprador');
    m(57, mesmo || !c2.endereco?.cep ? 0 : 1);
    t(58, d.usaFgts ? 'Sim' : 'Não');
  }

  // Imóvel
  const im = d.imovel;
  const rua = String(im.logradouro || '').trim();
  t(65, im.cep); const tp = tipoLogradouro(rua); if (tp >= 0) m(66, tp); t(67, semTipo(rua)); t(68, im.numero); t(69, im.complemento); t(70, im.bairro); t(71, im.cidade); t(72, im.uf);
  if (!im.cep || !rua || !im.numero) faltando.push('endereço completo do imóvel (CEP, rua, número, bairro)');
  if (/apart/i.test(String(im.tipo || ''))) m(73, 0); else if (/casa|sobrado/i.test(String(im.tipo || ''))) m(73, 1); else faltando.push('tipo do imóvel (apartamento ou casa)');
  t(74, d.financiado || '');
  if (!t(75, d.contato.pessoa)) faltando.push('pessoa a ser contatada para a vistoria');
  if (!t(76, d.contato.telefone)) faltando.push('telefone do contato da vistoria');

  // Vendedor PF (+ cônjuge)
  const [v1, v2] = d.vendedores;
  if (!v1) faltando.push('dados do vendedor (documentos na pasta VENDEDOR)');
  else {
    t(81, fmtCpf(v1.cpf)); t(82, titulo(v1.nome || ''));
    blocoPessoa(t, m, v1, { nascimento: 83, sexo: 84, profissao: 85, telefone: 86, email: 87, estadoCivil: 88, uniao: 89, dataCasamento: 90, regime: 91, nacionalidade: 92, documento: 93, numDoc: 94, orgao: 95, ufDoc: 96, emissao: 97, procurador: 98,
      cep: 99, tipoEnd: 100, rua: 101, num: 102, compl: 103, bairro: 104, cidade: 105, uf: 106 }, faltando, 'do vendedor');
    if (v2) {
      t(114, fmtCpf(v2.cpf)); m(115, 0); t(116, titulo(v2.nome || ''));
      blocoPessoa(t, m, v2, { nascimento: 117, sexo: 118, profissao: 119, telefone: 120, email: 121, nacionalidade: 122, documento: 123, numDoc: 124, orgao: 125, ufDoc: 126, emissao: 127, procurador: 128, procuradorMarca: 1 }, faltando, 'do cônjuge do vendedor');
      m(129, 0);
    }
  }
  const c = d.conta || {};
  t(132, c.titular || (v1 ? titulo(v1.nome || '') : '')); t(133, c.banco); t(134, c.agencia); t(135, c.conta); t(136, c.digito); t(137, c.tipo);
  if (!c.banco || !c.agencia || !c.conta) faltando.push('conta do vendedor para crédito (banco, agência e conta)');
  return { ops, faltando };
}

export async function preencherFichaFh(ops: Op[]): Promise<Buffer> {
  const zip = await JSZip.loadAsync(fs.readFileSync(path.join(ASSETS, 'fh-ficha-cadastro.docx')));
  const xml = await zip.file('word/document.xml')!.async('string');
  zip.file('word/document.xml', aplicarOps(xml, ops));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
