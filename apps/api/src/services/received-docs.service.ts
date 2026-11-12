import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { organizeReceivedDocsFolder, downloadDriveFileForVision, isStickerAttachment, isScreenshotAttachment, getDrive, extractFolderId, findFolder, listFolderContents } from './google.service';
export { isStickerAttachment, isScreenshotAttachment };
import { logActivity } from './activity.service';


/* Card entrou em "Documentação Recebida" (qualquer setor que tenha a pasta
 * LEADS ATIVOS configurada em Department.activeLeadsFolderId): organiza a
 * pasta do cliente no Drive e grava o link em "Pasta no Drive". Roda por
 * polling (index.ts) em vez de hook de rota: o card chega nessa etapa por
 * vários caminhos (tela, "Fechado" migrando pro funil de contratação,
 * automação, IA), e Lead.stageEnteredAt (trigger no banco) marca quando
 * entrou — sem depender de cada caminho lembrar de chamar isto. */

const CONTRACTING_ENTRY_DAYS = 45; // funil "Em contratação": qualquer etapa, até 45 dias depois de entrar
const RECENT_ENTRY_DAYS = 7; // só quem entrou na etapa agora (não mexe em pasta antiga organizada à mão)
const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;
const MAX_VISION_BYTES = 4_500_000;
let running = false;

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

function folderNameFor(lead: { name: string; customFields: unknown }): string {
  const cf = (lead.customFields || {}) as Record<string, string>;
  const raw = cf.participante_1 || lead.name || 'CLIENTE';
  return raw.replace(/[^\p{L}\p{N} .'-]/gu, '').replace(/\s+/g, ' ').trim().toUpperCase() || 'CLIENTE';
}

export const DOC_PROMPT = `Este arquivo foi enviado por um cliente de crédito imobiliário (financiamento ou crédito com garantia de imóvel). Diga qual documento é.
Responda SOMENTE em uma linha, em CAIXA ALTA, sem acento. O nome do documento, de preferência um destes: RG, CNH, CPF, AUTORIZACAO SCR BACEN (formulário de autorização de consulta ao SCR do Banco Central, com ou sem assinatura), AUTORIZACAO USECASA (formulário "Autorização do(s) Cliente(s) para USECASA - Crédito com Garantia do Imóvel" do Santander, com ou sem assinatura do gov.br), CERTIDAO DE NASCIMENTO, CERTIDAO DE CASAMENTO, COMPROVANTE DE RESIDENCIA, CONTRACHEQUE, EXTRATO BANCARIO, IMPOSTO DE RENDA, RECIBO IMPOSTO DE RENDA, CTPS, EXTRATO FGTS, HISTORICO INSS, CND IPTU (SOMENTE a certidão negativa de débitos do IPTU emitida pela prefeitura — documento escrito "Certidão"), GUIA IPTU (guia/carnê de PAGAMENTO do IPTU: parcelas com vencimento e código de barras — NÃO é certidão), CAPA IPTU (capa do carnê/IPTU com as metragens e a inscrição imobiliária), SALDO DEVEDOR (print/extrato do app ou site do banco mostrando o saldo devedor do financiamento do imóvel), DESCRITIVO DA PARCELA (extrato/demonstrativo das PRESTAÇÕES do financiamento do imóvel emitido pelo banco: dados do contrato — prazo, taxa, sistema de amortização — e a lista das últimas parcelas com vencimento, pagamento e valores; mesmo que também mostre o saldo, é DESCRITIVO DA PARCELA; NÃO é extrato bancário), CERTIDAO DE ONUS (SOMENTE a emitida pelo CARTORIO DE REGISTRO DE IMOVEIS: ônus reais, negativa de ônus ou inteiro teor da matrícula), CERTIDAO DE CADASTRO IMOBILIARIO (certidão da PREFEITURA/município com a inscrição imobiliária, proprietários e endereço do imóvel — NÃO é do cartório e NUNCA é certidão de ônus), MATRICULA DO IMOVEL, CONTRATO SOCIAL, CARTAO CNPJ, DEFIS, PGDAS, DECORE, SIMULACAO.
Guia para NÃO confundir (aprendido com arquivos reais de clientes — Fabio 19/10):
- CERTIDAO DE ONUS e MATRICULA DO IMOVEL são SÓ do CARTÓRIO de Registro de Imóveis (matrícula, registros R-, averbações AV-, selo/QR do Registro de Imóveis). Só use esses dois nomes com CERTEZA.
- CERTIDAO DE CADASTRO IMOBILIARIO = PREFEITURA, com inscrição imobiliária, proprietários e endereço (não é do cartório).
- Documentos de IPTU: CND IPTU = certidão negativa ("Certidão" escrita no título); GUIA IPTU = guia/carnê de pagamento (parcelas, vencimento, código de barras); NOTIFICACAO IPTU LANCAMENTO = "IPTU - Notificação de Lançamento"; CAPA IPTU = capa com metragens. CND IPTU vale também pra certidão negativa de débitos/tributos imobiliários de município, estado ou DF.
- VERSO de certidão de casamento/nascimento com "AVERBAÇÕES/ANOTAÇÕES" (divórcio, óbito…): AVERBACAO DIVORCIO (ou AVERBACAO + o assunto) — é documento PESSOAL, não do imóvel.
- Outros que existem: ESCRITURA PUBLICA, CARTA DE SENTENCA, EXIGENCIA NOTARIAL (do cartório), CONSULTA DE PROTOCOLO.
- Foto CORTADA, parcial ou ilegível em que você não tem certeza do que é: escreva DOCUMENTO NAO IDENTIFICADO (e, se der, a pista: "DOCUMENTO NAO IDENTIFICADO IPTU") — NUNCA force CERTIDAO DE ONUS, MATRICULA DO IMOVEL ou CND IPTU na dúvida.
- O titular é a pessoa a quem o documento pertence — NUNCA o escrevente, oficial, cartório, juiz, prefeito ou quem assina.
Se for outro documento, use um nome curto que o descreva (até 4 palavras).
Depois do nome do documento, coloque " | " e o nome completo do titular como aparece no documento (a pessoa a quem ele pertence). Se não aparecer nome de pessoa, escreva só o nome do documento.
Exemplos: "CNH | JOAO CARLOS DA SILVA", "CONTRACHEQUE | MARIA SOUZA", "CND IPTU".
SÓ MATRICULA DO IMOVEL ou CERTIDAO DE ONUS em FOTO/imagem de UMA folha: depois do titular coloque mais um " | " com o número da matrícula e a folha impressos no papel, no formato "MAT <número> FICHA <número da ficha/folha>" e " VERSO" quando for o verso (o verso costuma dizer "verso"/"continuação" ou não ter o cabeçalho da ficha). Folha que não dá pra ler: "MAT <número> FICHA ?". Ex.: "MATRICULA DO IMOVEL | JOAO DA SILVA | MAT 26027 FICHA 2 VERSO". Sem titular: "MATRICULA DO IMOVEL |  | MAT 26027 FICHA 1".
Se NÃO for documento (foto qualquer, selfie, figurinha, print de conversa), responda IGNORAR.`;

type AttachmentForVision = { id: string; driveFileId: string | null; data?: Uint8Array | null; mimeType: string; fileName?: string | null };

/** `folha`: SÓ foto de matrícula/ônus — "MAT 26027 FICHA 2 VERSO" (Fabio 05/11: nomear as folhas PAG 1, 2, 3…). */
export interface DocInfo { type: string; holder?: string; protegido?: boolean; folha?: string }

const clean = (t: string, max: number) =>
  t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase().slice(0, max);

/** Imagem de um anexo pronta pra mandar pro Claude (base64), lendo do banco
 *  ou do Drive. null se não é imagem suportada, é grande demais ou não deu. */
export async function imageSourceForVision(accountId: string, att: AttachmentForVision): Promise<{ type: 'base64'; media_type: string; data: string } | null> {
  if (!/^image\//.test(att.mimeType)) return null;
  try {
    let buffer: Buffer;
    let mimeType = att.mimeType;
    if (att.data && att.data.length) buffer = Buffer.from(att.data);
    else if (att.driveFileId) ({ buffer, mimeType } = await downloadDriveFileForVision(accountId, att.driveFileId, att.mimeType));
    else return null;
    if (buffer.length > MAX_VISION_BYTES) return null;
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) return null;
    return { type: 'base64', media_type: mimeType, data: buffer.toString('base64') };
  } catch {
    return null;
  }
}

/** Tipo do documento e titular lendo o arquivo (Claude com visão) — {type:
 *  "CNH", holder: "JOAO DA SILVA"}. null = não é documento; undefined = não
 *  deu pra ler (tipo de arquivo, tamanho ou erro). Lê os bytes do banco se o
 *  anexo ainda não subiu pro Drive. */
/** Fatura/conta de operadora ou concessionária (Fabio 20/10: "sempre que vier algo de alguma operadora, pode ser comprovante de endereço") pelo NOME DO ARQUIVO — usado quando o arquivo não pôde ser lido
 *  (PDF protegido por senha, ex.: "Fatura Claro.pdf — Senha 89262"). */
const OPERADORA_RX = /(^|[^a-z])(claro|vivo|tim|oi|net|sky|nextel|brisanet|algar|copel|celesc|enel|cemig|cpfl|light|energisa|neoenergia|equatorial|elektro|sabesp|cedae|copasa|sanepar|casan|embasa|caesb|fatura|conta[ _-]*(de[ _-]*)?(luz|agua|energia|gas|telefone|internet))([^a-z]|$)/;
export function faturaDeOperadora(fileName: string): boolean {
  const n = String(fileName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\.[a-z0-9]{2,4}$/, '');
  return OPERADORA_RX.test(n);
}
const pdfCriptografado = (buf: Buffer) => buf.includes('/Encrypt');
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>;
/** PDF criptografado nem sempre pede senha: certidão de cartório (matrícula etc.) costuma vir só com a senha de DONO (bloqueia editar/imprimir) e abre normalmente.
 *  O CRM tratava todo "/Encrypt" como protegido e a IA perguntava ao cliente (Fabio 02/11: "de onde o CRM viu que o arquivo tem senha?"). Abre com o pdf.js:
 *  só pede senha se ele recusar sem ela. Devolve também o texto (a API da Anthropic pode recusar PDF criptografado — aí a leitura vai pelo texto). */
async function abrirPdfCriptografado(buf: Buffer): Promise<{ pedeSenha: boolean; abriu: boolean; texto: string }> {
  try {
    const pdfjs = await esmImport('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
    const partes: string[] = [];
    for (let i = 1; i <= Math.min(doc.numPages, 6); i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      partes.push(tc.items.map((it: any) => it.str || '').join(' '));
    }
    await doc.destroy();
    return { pedeSenha: false, abriu: true, texto: partes.join('\n').replace(/[ \t]+/g, ' ').trim().slice(0, 15_000) };
  } catch (e: any) {
    return { pedeSenha: e?.name === 'PasswordException', abriu: false, texto: '' };
  }
}

export async function classifyDocument(accountId: string, att: AttachmentForVision): Promise<DocInfo | null | undefined> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return undefined;
  const isPdf = att.mimeType === 'application/pdf';
  const isImage = /^image\//.test(att.mimeType);
  if (!isPdf && !isImage) return undefined;

  let buffer: Buffer;
  let mimeType = att.mimeType;
  if (att.data && att.data.length) {
    buffer = Buffer.from(att.data);
  } else if (att.driveFileId) {
    ({ buffer, mimeType } = await downloadDriveFileForVision(accountId, att.driveFileId, att.mimeType));
  } else {
    return undefined;
  }
  // PDF pode ter até ~20 MB (a API aceita; a matrícula do ONR do Luiz tinha 5 MB e ficava "não lida" com o teto de 4,5 MB); imagem segue no teto de 5 MB da API.
  if (buffer.length > (isPdf ? 20_000_000 : MAX_VISION_BYTES)) return undefined;
  // PDF que pede senha: a IA não abre. Fatura de operadora vale como comprovante de residência (regra do Fabio); o resto fica "não lido".
  const protegido = (): DocInfo => (faturaDeOperadora(att.fileName || '') ? { type: 'COMPROVANTE DE RESIDENCIA', protegido: true } : { type: 'PROTEGIDO', protegido: true });
  const cripto = isPdf && pdfCriptografado(buffer) ? await abrirPdfCriptografado(buffer) : null;
  if (cripto && cripto.pedeSenha) return protegido();
  const mediaType = isPdf ? 'application/pdf' : mimeType;
  if (!isPdf && !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) return undefined;

  const source = { type: 'base64', media_type: mediaType, data: buffer.toString('base64') };
  const ler = (conteudo: unknown) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      // Sonnet (Fabio 19/10): o Haiku errava documento do imóvel (certidão da prefeitura como "ônus", guia de IPTU como "CND", exigência de ITBI como "guia"...). A leitura custa centavos
      // por semana (28 chamadas/7 dias) — vale o modelo mais forte. max_tokens folgado: o raciocínio do Sonnet 5 conta no limite e cortava a resposta.
      model: 'claude-sonnet-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: [conteudo, { type: 'text', text: DOC_PROMPT }] }],
    }),
  });
  let res = await ler({ type: isPdf ? 'document' : 'image', source });
  if (!res.ok) {
    const corpoErro = (await res.text()).slice(0, 400);
    console.error('[DocsRecebidos] Erro ao ler documento:', res.status, corpoErro.slice(0, 200));
    // Abre sem senha (só senha de dono) mas a API recusou o PDF criptografado: lê pelo texto do arquivo. Sem texto (digitalizado) fica "não lido" — nunca "protegido".
    if (cripto && cripto.abriu) {
      if (cripto.texto.length < 80) return undefined;
      res = await ler({ type: 'text', text: `Texto extraído do PDF "${att.fileName || 'documento'}" (o arquivo abre sem senha):\n${cripto.texto}` });
      if (!res.ok) { console.error('[DocsRecebidos] Erro ao ler o texto do PDF:', res.status, (await res.text()).slice(0, 200)); return undefined; }
    } else {
      if (res.status === 400 && /password/i.test(corpoErro)) return protegido(); // pede senha e o pdf.js não chegou a abrir
      return faturaDeOperadora(att.fileName || '') ? { type: 'COMPROVANTE DE RESIDENCIA', protegido: true } : undefined;
    }
  }
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('\n').split('\n').map((l) => l.trim()).find((l) => l) || '';
  const [typePart, holderPart, folhaPart] = text.split('|');
  const type = clean(typePart || '', 40);
  if (!type) return undefined;
  if (type === 'IGNORAR') return null;
  const holder = clean(holderPart || '', 60);
  const folha = isImage && ehMatriculaTipo(type) ? (clean(folhaPart || '', 40) || 'FICHA ?') : '';
  return { type, ...(holder ? { holder } : {}), ...(folha ? { folha } : {}) };
}

export const ehMatriculaTipo = (t: string) => /^(MATRICULA|CERTIDAO DE ONUS)/.test(String(t || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''));

/** Palpite do tipo de documento pelo NOME do arquivo (só pra anotar na pasta quando o arquivo não abre). */
export function chuteTipoPeloNome(fileName: string): string {
  const n = String(fileName || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (faturaDeOperadora(fileName)) return 'COMPROVANTE DE RESIDENCIA';
  if (/extrato|nubank|\bnu[_ -]\d/.test(n)) return 'EXTRATO BANCARIO';
  if (/holerite|contracheque|contra-cheque/.test(n)) return 'CONTRACHEQUE';
  if (/\birpf\b|imposto de renda|declaracao|recibo/.test(n)) return 'IMPOSTO DE RENDA';
  if (/\b(rg|cnh|identidade|cpf)\b/.test(n)) return 'DOCUMENTO DE IDENTIFICACAO';
  if (/matricula|onus/.test(n)) return 'MATRICULA DO IMOVEL';
  if (/iptu|cadastro/.test(n)) return 'IPTU';
  return 'DOCUMENTO PROTEGIDO';
}

/** DESCRITIVO DA PARCELA (Fabio 30/10): extrato das prestações do financiamento do imóvel que o banco pede junto com o print do saldo devedor (PDF gerado no app do banco).
 *  Aceita os nomes que a leitura costuma dar ("DEMONSTRATIVO DAS PRESTACOES", "EXTRATO DO FINANCIAMENTO"). */
export function isDescritivoParcela(type: string | null | undefined): boolean {
  const t = String(type || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  return /(DESCRITIVO|DEMONSTRATIVO) D[AEO]S? (PARCELA|PRESTAC)|EXTRATO D[AEO]S? (PARCELA|PRESTAC|FINANCIAMENTO)/.test(t); // "MEMORIAL DESCRITIVO" é do imóvel: fica de fora
}

/** Documento do imóvel (vai pra subpasta IMOVEL; sem nome de pessoa no arquivo). */
export function isPropertyDocType(type: string): boolean {
  return /IMOVEL|MATRICULA|ONUS|IPTU|ESCRITURA|HABITE|PLANTA|LAUDO|AVALIACAO|VISTORIA|CONDOMINIO|ITBI|COMPRA E VENDA|PROMESSA|VINTENARIA|INTEIRO TEOR|MEMORIAL|AVERBACAO|REGISTRO DE IMOVEIS|CADASTRO IMOBILIARIO/.test(type);
}

// Arquivo de simulação que a equipe manda pro cliente ("simulacao CAIXA.pdf",
// "EVOLUCAO_PARCELAS_INTER_...pdf") — vai pra pasta principal, nome original.
const SIMULATION_FILE_RE = /simula|evolu[cç][aã]o[ _-]*(das[ _-]*)?parcelas/i;

// VENDEDOR só recebe documento pessoal (identificação, estado civil,
// residência, certidões/procuração) — renda é sempre do comprador — e nunca
// quando o "titular" é empresa/banco (ex.: extrato em nome da financeira).
const SELLER_DOC_RE = /\b(RG|CNH|CPF|IDENTIDADE|CERTIDAO DE NASCIMENTO|CERTIDAO DE CASAMENTO|CERTIDAO NEGATIVA|CERTIDAO DE DEBITOS?|COMPROVANTE DE RESIDENCIA|PROCURACAO|PACTO ANTENUPCIAL|AVERBACAO DE DIVORCIO)\b/;
const COMPANY_RE = /\b(S ?A|LTDA|EIRELI|ME|BANCO|CREDITO|FINANCIAMENTO|INVESTIMENTO|CAIXA ECONOMICA|COOPERATIVA|CONDOMINIO|PREFEITURA|CARTORIO)\b/;

/** O titular do documento é um dos compradores do card? Mesmo primeiro nome
 *  ou mesmo último sobrenome de um participante (cobre cônjuge/família).
 *  Sem participante conhecido, assume que sim. */
function isBuyerHolder(holder: string | undefined, buyers: string[]): boolean {
  if (!holder || !buyers.length) return true;
  const h = clean(holder, 80).split(' ').filter(Boolean);
  if (!h.length) return true;
  return buyers.some((b) => {
    const w = clean(b, 80).split(' ').filter(Boolean);
    if (!w.length) return false;
    return h[0] === w[0] || (h[h.length - 1].length > 2 && h[h.length - 1] === w[w.length - 1]);
  });
}

/** Mesma pessoa pelo nome: mesmo primeiro nome e um sobrenome em comum (cobre nome de solteira/casada no RG). Pura. */
export function mesmaPessoa(a: string | undefined, b: string | undefined): boolean {
  const partes = (s: string | undefined) => clean(String(s || ''), 100).split(' ').filter((w) => w && !/^(DA|DE|DO|DAS|DOS|E)$/.test(w));
  const x = partes(a), y = partes(b);
  if (x.length < 2 || y.length < 2 || x[0] !== y[0]) return false;
  return x.slice(1).some((w) => w.length > 2 && y.slice(1).includes(w));
}

/** VENDEDORES do imóvel no Financiamento Habitacional (Fabio 11/11: "temos vendedor que deve bater com os mesmos da ônus"): os proprietários ATUAIS que a leitura da
 *  certidão de ônus/matrícula/escritura achou (`_docReview[].dono`, vários separados por ";"). Documento do imóvel ANTIGO (`_docsImovelAntigo`) não conta. Leitura antiga
 *  sem `dono`: cai no titular da classificação ("MATRICULA DO IMOVEL|FULANO"). Pura (testável). */
export function vendedoresDoImovel(cf: Record<string, any> | null | undefined): string[] {
  const antigos = (cf?._docsImovelAntigo || {}) as Record<string, unknown>;
  const DOC = /^(MATRICULA|CERTIDAO DE ONUS|ESCRITURA)/;
  const nomes: string[] = [];
  const add = (txt: unknown) => {
    for (const n0 of String(txt || '').split(/\s*;\s*/)) {
      const n = n0.replace(/\s+/g, ' ').trim(), c = clean(n, 100);
      if (c.split(' ').length >= 2 && !COMPANY_RE.test(c) && !nomes.some((x) => mesmaPessoa(x, n))) nomes.push(n);
    }
  };
  for (const [id, r] of Object.entries((cf?._docReview || {}) as Record<string, any>)) {
    if (r && typeof r === 'object' && !antigos[id] && r.dono && r.resultado !== 'NAO_DOCUMENTO' && DOC.test(clean(String(r.tipo || ''), 60))) add(r.dono);
  }
  if (!nomes.length) {
    for (const [id, v] of Object.entries((cf?._docInfo || {}) as Record<string, unknown>)) {
      if (antigos[id] || typeof v !== 'string') continue;
      const [t, h] = v.split('|');
      if (DOC.test(clean(t || '', 60))) add(h);
    }
  }
  return nomes;
}

export function docLabel(info: DocInfo): string {
  if (isPropertyDocType(info.type)) return info.type;
  return info.holder ? `${info.type} ${info.holder.split(' ').slice(0, 2).join(' ')}` : info.type;
}

/** Documentos já lidos ficam guardados no card (customFields._docInfo, por
 *  id do anexo, "TIPO|TITULAR" ou "IGNORAR") — a conferência de documentação
 *  e o organizador de pasta leem cada arquivo uma vez só. */
export async function getDocInfo(accountId: string, leadId: string, atts: AttachmentForVision[]): Promise<Record<string, DocInfo | null>> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = ((lead?.customFields as Record<string, unknown>) || {});
  const cache = { ...((cf._docInfo as Record<string, string>) || {}) };
  const protAntes = (cf._docsProtegidos || {}) as Record<string, { fileName?: string; relido?: boolean }>;
  const relidos = new Map<string, DocInfo | null>(); // "PROTEGIDO" de antes de 02/11 (todo PDF criptografado contava): relê 1x — null = segue protegido/não lido
  let changed = false;
  for (const att of atts) {
    const relerProtegido = String(cache[att.id] || '').startsWith('PROTEGIDO|') && !!protAntes[att.id] && !protAntes[att.id].relido;
    // Foto de matrícula/ônus lida antes da regra das folhas (05/11): relê 1x pra saber a folha.
    const relerFolha = /^image\//.test(att.mimeType) && ehMatriculaTipo(String(cache[att.id] || '').split('|')[0]) && String(cache[att.id] || '').split('|').length < 3;
    if (cache[att.id] && !relerProtegido && !relerFolha) continue;
    const info = await classifyDocument(accountId, att).catch(() => undefined);
    if (relerProtegido) {
      relidos.set(att.id, info && !info.protegido ? info : null);
      changed = true;
      if (!info || info.protegido) continue;
    }
    if (info === undefined) continue;
    if (relerFolha && (!info || !ehMatriculaTipo(info.type))) { cache[att.id] = `${String(cache[att.id]).split('|').slice(0, 2).join('|')}|FICHA ?`; changed = true; continue; } // releitura deu outro tipo: mantém a classificação de antes
    cache[att.id] = info === null ? 'IGNORAR' : `${info.type}|${info.holder || ''}${info.folha ? `|${info.folha}` : ''}`;
    changed = true;
    if (info && info.protegido) {
      // Arquivo que não abre (senha): vai pro card pra a IA PERGUNTAR ao cliente o que é e pra pasta do Drive sair como "VERIFICAR - …" (Fabio 21/10: "a IA pergunta ao cliente e anota o nome do documento na pasta, depois eu verifico").
      const fr = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
      const cfp = { ...((fr?.customFields || {}) as Record<string, any>) };
      cfp._docsProtegidos = { ...(cfp._docsProtegidos || {}), [att.id]: { fileName: att.fileName || att.id, guess: chuteTipoPeloNome(att.fileName || '') } };
      await prisma.lead.update({ where: { id: leadId }, data: { customFields: cfp as any } });
      await prisma.note.create({ data: { leadId, type: 'COMMENT', content: info.type === 'PROTEGIDO' ? `🔒 "${att.fileName}" está protegido por senha e a IA não consegue abrir. Vou perguntar ao cliente o que é e o arquivo fica na pasta como "VERIFICAR - …" pra você conferir depois.` : `🔒 "${att.fileName}" não pôde ser aberto (protegido por senha ou ilegível). Pelo nome da operadora/concessionária contei como COMPROVANTE DE RESIDÊNCIA (regra do Fabio) — fica na pasta como "VERIFICAR - …": abra com a senha que o cliente mandou e confira a data (até 90 dias) e o titular.` } }).catch(() => {});
    }
  }
  // A conferência (doc-review) já abriu e leu o arquivo marcado como protegido: não pedia senha — sai da lista (some o "VERIFICAR -" da pasta e o "aguardando verificação" da IA).
  const revs = (cf._docReview || {}) as Record<string, { resultado?: string; tipo?: string }>;
  for (const id of Object.keys(protAntes)) {
    const r = revs[id];
    if (!relidos.has(id) && r && r.tipo && (r.resultado === 'OK' || r.resultado === 'PROBLEMA')) { relidos.set(id, { type: r.tipo }); changed = true; }
  }
  if (changed) {
    const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
    const freshCf = ((fresh?.customFields as Record<string, any>) || {});
    // Classificação que a equipe corrigiu no painel de documentos ENQUANTO este lia (Fabio 03/11): vale a da equipe — o `cache` é de antes.
    for (const [id, r] of Object.entries((freshCf._docReview || {}) as Record<string, any>)) if (r?.corrigidoPor && typeof freshCf._docInfo?.[id] === 'string') cache[id] = freshCf._docInfo[id];
    const next: Record<string, unknown> = { ...freshCf, _docInfo: cache };
    delete next._docTypes;
    if (relidos.size) {
      const prot = { ...((next._docsProtegidos || {}) as Record<string, any>) };
      for (const [id, info] of relidos) {
        if (!prot[id]) continue;
        if (!info) { prot[id] = { ...prot[id], relido: true }; continue; }
        await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `✅ "${prot[id].fileName || id}" abre sem senha (o PDF só bloqueia edição/impressão, comum em certidão de cartório): li como ${docLabel(info)}. O aviso de "protegido por senha" estava errado.` } }).catch(() => {});
        delete prot[id];
      }
      next._docsProtegidos = prot;
    }
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: next as any } });
  }
  const out: Record<string, DocInfo | null> = {};
  for (const [id, v] of Object.entries(cache)) {
    if (v === 'IGNORAR') { out[id] = null; continue; }
    const [type, holder, folha] = v.split('|');
    out[id] = { type, ...(holder ? { holder } : {}), ...(folha ? { folha } : {}) };
  }
  return out;
}

/** Grava SÓ as chaves do organizador, nunca o card inteiro: a leitura é de antes do Drive (segundos/minutos movendo arquivos) e regravar tudo apagava o que outro
 *  processo gravou no meio — o pedido do cadastro na CAIXA sumiu 5 s depois do clique (Tarcisio, 05/11). Ver customfields-write-race. */
async function gravarChaves(leadId: string, set: Record<string, unknown>, tirarFalha = false): Promise<void> {
  if (tirarFalha) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = (COALESCE("customFields", '{}'::jsonb) - '_driveOrganizeFailedAt') || ${JSON.stringify(set)}::jsonb WHERE id = ${leadId}`;
  else await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || ${JSON.stringify(set)}::jsonb WHERE id = ${leadId}`;
}

async function organizeLead(lead: {
  id: string; name: string; accountId: string; customFields: unknown; activeLeadsFolderId: string;
}): Promise<void> {
  // O print do SALDO DEVEDOR é a ÚNICA captura de tela que fica na pasta do cliente (Fabio 15/10) — mesmo se o arquivo se chamar "Captura de tela…".
  const saldoPrintId: string | undefined = ((lead.customFields as any) || {})._saldoDevedor?.attachmentId;
  const attachments = (await prisma.messageAttachment.findMany({
    where: { leadId: lead.id, driveFileId: { not: null }, message: { direction: 'INBOUND' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, driveFileId: true, fileName: true, mimeType: true },
  })).filter((a) => !/^(audio|video)\//.test(a.mimeType) && !isStickerAttachment(a) && (!isScreenshotAttachment(a) || a.id === saldoPrintId));
  // Simulações que a equipe mandou pro cliente também vão pra pasta (raiz).
  const sentSimulations = (await prisma.messageAttachment.findMany({
    where: { leadId: lead.id, driveFileId: { not: null }, message: { direction: 'OUTBOUND' } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, driveFileId: true, fileName: true, mimeType: true },
  })).filter((a) => SIMULATION_FILE_RE.test(a.fileName));
  const simulationDriveIds = new Set(sentSimulations.map((a) => a.driveFileId!));
  // Documentos que NÃO vieram pelo WhatsApp (Fabio 12/11, Windson: "a pasta não foi organizada e os documentos estão jogados na pasta geral"): os que a equipe
  // anexou no card e os soltos na pasta do cadastro CAIXA (link do card, ainda crua). A IA lê como os anexos (id "drive:<arquivo>" no `_docInfo`).
  const extras = await arquivosForaDoWhatsapp(lead.accountId, (lead.customFields || {}) as Record<string, any>, new Set([...attachments, ...sentSimulations].map((a) => a.driveFileId!)));
  const files = [...attachments, ...sentSimulations, ...extras].map((a) => ({ driveFileId: a.driveFileId!, fileName: a.fileName, mimeType: a.mimeType }));
  const docInfo = await getDocInfo(lead.accountId, lead.id, [...attachments, ...extras]);
  const attIdByDriveId = new Map([...attachments, ...extras].map((a) => [a.driveFileId!, a.id]));

  // Financiamento Habitacional tem VENDEDOR: documento pessoal de quem não é
  // comprador do card (Fabio 30/09). Home Equity: só COMPRADOR + IMOVEL.
  const dept = await prisma.lead.findUnique({ where: { id: lead.id }, select: { pipeline: { select: { department: { select: { name: true } } } } } });
  const isHab = /habitacional/i.test(dept?.pipeline?.department?.name || '');
  const cfLead = (lead.customFields || {}) as Record<string, unknown>;
  const buyers = [cfLead.participante_1, cfLead.participante_2, ...String(lead.name || '').split('/')]
    .map((x) => String(x || '').trim()).filter((x) => x && !x.startsWith('+'));

  const freshLead = await prisma.lead.findUnique({ where: { id: lead.id }, select: { customFields: true } });
  const cf = { ...((freshLead?.customFields as Record<string, unknown>) || {}) };
  const vendedores = isHab ? vendedoresDoImovel(cf) : [];
  if (!files.length) {
    await gravarChaves(lead.id, { _driveOrganizedAt: new Date().toISOString() });
    await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: '📁 Card em Documentação Recebida, mas nenhum documento do cliente foi encontrado no Drive (anexos do WhatsApp). A pasta não foi organizada automaticamente.' } });
    return;
  }

  // FOLHAS da matrícula/ônus em FOTO (Fabio 05/11: "identificar as folhas da certidão de ônus e nomeá-las como pag 1, 2, 3 quando vier em fotos"): por matrícula+folha
  // vale a foto mais NOVA, nomeada "… - PAG n" na ordem das folhas (ficha 1, verso, ficha 2…); a foto antiga da mesma folha vai pra DESNECESSARIO.
  const paginas = new Map<string, { nome: string; desnecessario: boolean }>();
  {
    const chave = (f: string) => { const mat = ((/MAT\s*([\d.]+)/i.exec(f) || [])[1] || '').replace(/\D/g, ''); const n = Number((/FICHA\s*(\d+)/i.exec(f) || [])[1]); return { mat, ordem: n > 0 ? n * 2 + (/VERSO/i.test(f) ? 1 : 0) : 0 }; };
    const fotos = attachments.filter((a) => /^image\//.test(a.mimeType) && docInfo[a.id] && ehMatriculaTipo(docInfo[a.id]!.type) && docInfo[a.id]!.folha);
    const mats = new Set(fotos.map((a) => chave(docInfo[a.id]!.folha!).mat).filter(Boolean));
    const grupos = new Map<string, typeof fotos>();
    for (const a of fotos) { const k = `${docLabel(docInfo[a.id]!)}|${mats.size > 1 ? chave(docInfo[a.id]!.folha!).mat : ''}`; grupos.set(k, [...(grupos.get(k) || []), a]); }
    for (const [k, lista] of grupos) {
      const [label, mat] = k.split('|');
      const base = `${label}${mat ? ` ${mat}` : ''}`;
      const porOrdem = new Map<number, string[]>(); // ordem → ids (do mais antigo pro mais novo)
      for (const a of lista) { const o = chave(docInfo[a.id]!.folha!).ordem; if (o) porOrdem.set(o, [...(porOrdem.get(o) || []), a.id]); }
      [...porOrdem.keys()].sort((x, y) => x - y).forEach((o, i) => {
        const ids = porOrdem.get(o)!;
        ids.forEach((id, j) => paginas.set(id, j === ids.length - 1 ? { nome: `${base} - PAG ${i + 1}`, desnecessario: false } : { nome: `${base} - PAG ${i + 1} (FOTO ANTERIOR)`, desnecessario: true }));
      });
      for (const a of lista) if (!paginas.has(a.id)) paginas.set(a.id, { nome: `${base} - FOLHA NAO IDENTIFICADA`, desnecessario: false });
    }
  }
  // Documento que não vamos usar (Fabio 05/11): recibo de taxa/emolumento, requerimento, comprovante de pagamento, protocolo — vai pra DESNECESSARIO.
  const SEM_USO = /^(RECIBO(?! (DE ENTREGA|IMPOSTO|DO IMPOSTO|IR\b|IRPF))|REQUERIMENTO|COMPROVANTE DE (PAGAMENTO|TRANSFERENCIA|PIX)|PROTOCOLO|CONSULTA DE PROTOCOLO)/;

  // Documentos do IMÓVEL ANTIGO (Fabio 10/11, cliente trocou de imóvel): `_docsImovelAntigo` = { [attachmentId]: … } — ficam em DESNECESSARIO com "ANTIGO - "
  // no nome e não voltam pra IMOVEL a cada reorganização (sem isso a matrícula antiga voltava a ser "MATRICULA DO IMOVEL" e a nova virava "… 2").
  const antigos = (cf._docsImovelAntigo || {}) as Record<string, unknown>;

  const clientFolderName = folderNameFor(lead);
  const result = await organizeReceivedDocsFolder(lead.accountId, {
    files,
    clientFolderName,
    activeLeadsFolderId: lead.activeLeadsFolderId,
    nameFor: async (f) => {
      const attId = attIdByDriveId.get(f.driveFileId) || '';
      if (antigos[attId]) { const i = docInfo[attId]; return `ANTIGO - ${i ? docLabel(i) : String(f.fileName).replace(/\.[a-z0-9]{2,5}$/i, '').slice(0, 40)}`; }
      const prot = ((cf._docsProtegidos || {}) as Record<string, { fileName?: string; guess?: string }>)[attId];
      if (prot) return `VERIFICAR - ${prot.guess || 'DOCUMENTO PROTEGIDO'} (${String(prot.fileName || f.fileName).replace(/\.[a-z0-9]{2,4}$/i, '').slice(0, 40)})`;
      const info = docInfo[attId];
      if (info === null) return null;
      if (paginas.has(attId)) return paginas.get(attId)!.nome;
      return info ? docLabel(info) : '';
    },
    folderFor: async (f) => {
      if (simulationDriveIds.has(f.driveFileId) || SIMULATION_FILE_RE.test(f.fileName)) return 'RAIZ';
      const attId0 = attIdByDriveId.get(f.driveFileId) || '';
      if (antigos[attId0]) return 'DESNECESSARIO';
      if (paginas.get(attId0)?.desnecessario) return 'DESNECESSARIO';
      const info = docInfo[attId0];
      // FH: documento pessoal de quem está na certidão de ônus como proprietário = VENDEDOR (Fabio 11/11), mesmo com sobrenome igual ao de um comprador.
      if (info && vendedores.length && !isPropertyDocType(info.type) && !/SIMULACAO|^SALDO DEVEDOR/.test(info.type)
        && String(info.holder || '').split(/\s*;\s*/).some((h) => vendedores.some((v) => mesmaPessoa(h, v)) && !buyers.some((b) => mesmaPessoa(h, b)))) return 'VENDEDOR';
      if (info && SEM_USO.test(info.type)) return 'DESNECESSARIO';
      if (info && /^AUTORIZACAO USECASA/.test(info.type)) return 'FORMULARIOS'; // autorização USECASA assinada (Santander) — Fabio 05/11
      if (!info) return 'COMPRADOR';
      if (/SIMULACAO/.test(info.type) || /^SALDO DEVEDOR/.test(info.type) || isDescritivoParcela(info.type)) return 'RAIZ'; // simulação, print do saldo devedor e descritivo da parcela: direto na pasta do cliente
      if (isPropertyDocType(info.type)) return 'IMOVEL';
      if (isHab && SELLER_DOC_RE.test(info.type) && !COMPANY_RE.test(info.holder || '') && !isBuyerHolder(info.holder, buyers)) return 'VENDEDOR';
      return 'COMPRADOR';
    },
  });

  await gravarChaves(lead.id, { link_pasta_drive: result.folderUrl, _driveOrganizedAt: new Date().toISOString() }, true);

  const lines = [
    `📁 Pasta organizada no Drive: ${clientFolderName} (em LEADS ATIVOS)`,
    result.folderUrl,
    '',
    ...(['COMPRADOR', 'VENDEDOR', 'IMOVEL', 'FORMULARIOS', 'RAIZ', 'DESNECESSARIO'] as const).flatMap((f) => {
      const list = result.named.filter((n) => n.folder === f);
      if (!list.length) return [];
      const title = f === 'RAIZ' ? `Simulações na pasta principal (${list.length}):` : f === 'DESNECESSARIO' ? `Subpasta DESNECESSARIO — repetidos e o que não vamos usar (${list.length}):` : `Subpasta ${f} (${list.length}):`;
      return ['', title, ...list.map((n) => `• ${n.to}`)];
    }),
  ];
  if (result.ignored.length) lines.push('', `Não são documentos (foram pra DESNECESSARIO): ${result.ignored.join(', ')}`);
  await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: lines.join('\n') } });
  logActivity({
    accountId: lead.accountId, userId: null, userName: 'Organizador de documentos', action: 'lead_edited', leadId: lead.id, leadName: lead.name,
    summary: `organizou a pasta no Drive (${result.named.length} documentos) e preencheu "Pasta no Drive"`,
  });
  console.log(`[DocsRecebidos] ${lead.name} (${lead.id}): pasta organizada, ${result.named.length} documentos, ${result.ignored.length} ignorados`);
}

/** Arquivos do cliente fora do WhatsApp: `_documentosEquipe` (a equipe anexou no card) + os soltos na raiz da pasta do cadastro CAIXA ainda crua (PDF/imagem). */
async function arquivosForaDoWhatsapp(accountId: string, cf: Record<string, any>, ja: Set<string>): Promise<{ id: string; driveFileId: string; fileName: string; mimeType: string }[]> {
  const out = new Map<string, { id: string; driveFileId: string; fileName: string; mimeType: string }>();
  const serve = (m: string) => /^(application\/pdf|image\/)/.test(m);
  for (const d of Array.isArray(cf._documentosEquipe) ? cf._documentosEquipe : []) {
    const id = String(d?.id || '');
    if (id && !ja.has(id) && serve(String(d?.mimeType || ''))) out.set(id, { id: `drive:${id}`, driveFileId: id, fileName: String(d.nome || 'documento'), mimeType: String(d.mimeType) });
  }
  const { pastaDoCadastroCrua } = require('./ficha-cadastral.service') as typeof import('./ficha-cadastral.service');
  if (pastaDoCadastroCrua(cf)) {
    const itens = await listFolderContents(accountId, extractFolderId(String(cf.link_pasta_drive))).catch(() => []);
    for (const f of itens) if (serve(f.mimeType) && !ja.has(f.id) && !out.has(f.id)) out.set(f.id, { id: `drive:${f.id}`, driveFileId: f.id, fileName: f.name, mimeType: f.mimeType });
  }
  return [...out.values()];
}

/** O link do card aponta pra pasta onde o auto-upload do WhatsApp jogou os
 *  anexos do cliente, e ela ainda não tem COMPRADOR/IMOVEL/VENDEDOR? Então é a
 *  pasta "crua" (só ganhou o link), não uma pasta montada à mão pela equipe. */
async function linkIsRawAttachmentsFolder(accountId: string, leadId: string, link: string): Promise<boolean> {
  const folderId = extractFolderId(link);
  if (!folderId) return false;
  const atts = await prisma.messageAttachment.findMany({
    where: { leadId, driveFileId: { not: null }, message: { direction: 'INBOUND' } },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { driveFileId: true },
  });
  if (!atts.length) return false;
  const drive = await getDrive(accountId);
  let dentro = 0;
  let lidos = 0;
  for (const a of atts) {
    const r = await drive.files.get({ fileId: a.driveFileId!, fields: 'parents', supportsAllDrives: true }).catch(() => null);
    if (r) lidos++;
    if (r?.data.parents?.includes(folderId)) dentro++;
  }
  if (!lidos) throw new Error('Drive não respondeu'); // não marca como "feita à mão" por falha do Drive
  if (!dentro) return false;
  for (const sub of ['COMPRADOR', 'COMPRADORA', 'IMOVEL', 'IMÓVEL', 'VENDEDOR', 'VENDEDORA']) {
    if (await findFolder(accountId, sub, folderId)) return false;
  }
  return true;
}

export async function organizeReceivedDocsLeads(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const leads = await prisma.lead.findMany({
      where: {
        archived: false,
        isGroup: false,
        // "Documentação Recebida" (entrou há pouco) OU qualquer etapa do funil "Em contratação" (entrou há até 45 dias): o Financiamento Habitacional costuma ir direto
        // pra Crédito em Análise/Aprovado/Vistoria/Análise Jurídica sem passar por Documentação Recebida e ficava SEM pasta (Fabio 14/10). A pasta vai pro LEADS ATIVOS
        // configurado no setor do card (FH: "1. LEADS ATIVOS"); quem já tem link/pasta montada é pulado abaixo.
        OR: [
          { stage: { name: { contains: 'recebida', mode: 'insensitive' } }, stageEnteredAt: { gte: new Date(Date.now() - RECENT_ENTRY_DAYS * 86_400_000) } },
          { pipeline: { name: { startsWith: 'Em contratação' } }, stageEnteredAt: { gte: new Date(Date.now() - CONTRACTING_ENTRY_DAYS * 86_400_000) } },
        ],
        pipeline: { department: { activeLeadsFolderId: { not: null } } },
      },
      select: {
        id: true, name: true, accountId: true, customFields: true, aiAutoReplyActive: true,
        stage: { select: { name: true } },
        pipeline: { select: { name: true, department: { select: { activeLeadsFolderId: true } } } },
      },
    });

    // (A IA desligava ao entrar em Documentação Recebida; desde 08/10 ela só
    // desliga quando alguém da equipe responde direto o cliente — Fabio.)

    for (const lead of leads) {
      if (!norm(lead.stage.name).includes('documentacao recebida') && !/^em contratacao/.test(norm(lead.pipeline.name))) continue;
      const cf = (lead.customFields || {}) as Record<string, string>;
      if ((cf as any)._autoPaused) continue; // Stop total do cliente
      if (cf.link_pasta_drive || cf._driveOrganizedAt) {
        // Link colocado à mão: não mexe — exceto quando o link é a própria pasta
        // dos anexos do WhatsApp, ainda sem subpastas (Eduardo, Fabio 27/10: "não
        // tem subpasta COMPRADOR igual no Home Equity, precisa ser igual"). Pasta
        // montada antes (ex.: sob demanda, com documentação ainda incompleta):
        // reorganiza só se chegou documento novo depois.
        // Pasta do cadastro CAIXA ainda crua (só ganhou o link pra conferência da ficha — documentos anexados pela equipe, sem WhatsApp): organiza na contratação
        // (Fabio 12/11, Windson). Sem isso ela virava "link manual" porque não tem anexo do WhatsApp dentro, e ficava jogada pra sempre.
        const crua = (require('./ficha-cadastral.service') as typeof import('./ficha-cadastral.service')).pastaDoCadastroCrua(cf as any) && /^em contratacao/.test(norm(lead.pipeline.name));
        if (!cf._driveOrganizedAt && !crua) {
          if ((cf as any)._driveLinkManual === cf.link_pasta_drive) continue;
          const bruta = await linkIsRawAttachmentsFolder(lead.accountId, lead.id, cf.link_pasta_drive).catch(() => null);
          if (bruta === null) continue; // Drive fora do ar: tenta no próximo ciclo
          if (!bruta) {
            await gravarChaves(lead.id, { _driveLinkManual: cf.link_pasta_drive }).catch(() => {});
            continue;
          }
        } else if (cf._driveOrganizedAt) {
          const novo = await prisma.messageAttachment.findFirst({
            where: { leadId: lead.id, driveFileId: { not: null }, message: { direction: 'INBOUND' }, createdAt: { gt: new Date(cf._driveOrganizedAt) } },
            select: { id: true },
          });
          if (!novo) continue;
        }
      }
      if (cf._driveOrganizeFailedAt && Date.now() - new Date(cf._driveOrganizeFailedAt).getTime() < RETRY_AFTER_FAILURE_MS) continue;

      try {
        await organizeLead({ ...lead, activeLeadsFolderId: lead.pipeline.department!.activeLeadsFolderId! });
      } catch (err) {
        console.error(`[DocsRecebidos] Falha ao organizar a pasta de ${lead.name} (${lead.id}):`, (err as Error)?.message);
        await gravarChaves(lead.id, { _driveOrganizeFailedAt: new Date().toISOString() }).catch(() => {});
      }
    }
  } finally {
    running = false;
  }
}

/** Cliente TROCOU DE IMÓVEL (Fabio 10/11): os documentos DO IMÓVEL (matrícula/ônus, IPTU…) que ele mandou ANTES de `antesDe` são do imóvel antigo →
 *  `_docsImovelAntigo` (DESNECESSARIO, "ANTIGO - …") e a pasta é reorganizada na hora, pra a pasta IMOVEL ficar só com os do imóvel novo. Devolve os nomes marcados. */
export async function marcarDocsImovelAntigo(accountId: string, leadId: string, antesDe: string): Promise<string[]> {
  const atts = await prisma.messageAttachment.findMany({
    where: { leadId, driveFileId: { not: null }, message: { direction: 'INBOUND' }, createdAt: { lt: new Date(antesDe) } },
    select: { id: true, driveFileId: true, fileName: true, mimeType: true },
  });
  if (!atts.length) return [];
  const info = await getDocInfo(accountId, leadId, atts);
  const doImovel = atts.filter((a) => info[a.id] && isPropertyDocType(info[a.id]!.type));
  if (!doImovel.length) return [];
  const agora = new Date().toISOString();
  const marca = Object.fromEntries(doImovel.map((a) => [a.id, { em: agora, tipo: info[a.id]!.type }]));
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsImovelAntigo}', COALESCE("customFields"->'_docsImovelAntigo', '{}'::jsonb) || ${JSON.stringify(marca)}::jsonb, true) WHERE id = ${leadId}`;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  if (((lead?.customFields || {}) as Record<string, unknown>)._driveOrganizedAt) await organizeLeadDocsNow(leadId).catch((e: any) => console.error('[Docs] imóvel trocado — não reorganizei a pasta:', e?.message || e));
  return doImovel.map((a) => docLabel(info[a.id]!));
}

/** Monta/atualiza a pasta do cliente no Drive agora, em qualquer etapa
 *  (Fabio 30/09: "pode fazer a pasta do Ângelo" — documentação ainda
 *  incompleta). Mesmo resultado do organizador automático. */
export async function organizeLeadDocsNow(leadId: string): Promise<void> {
  const lead = await prisma.lead.findUnique({
    where: { id: leadId },
    select: { id: true, name: true, accountId: true, customFields: true, pipeline: { select: { department: { select: { activeLeadsFolderId: true } } } } },
  });
  const folder = lead?.pipeline?.department?.activeLeadsFolderId;
  if (!lead) throw new Error('Card não encontrado');
  if (!folder) throw new Error('O setor desse card não tem a pasta LEADS ATIVOS configurada no Drive');
  await organizeLead({ id: lead.id, name: lead.name, accountId: lead.accountId, customFields: lead.customFields, activeLeadsFolderId: folder });
}
