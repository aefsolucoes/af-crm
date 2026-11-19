import { prisma } from '../lib/prisma';

/**
 * A IA ENCAMINHA AO CLIENTE DOCUMENTOS DA PASTA DO CARD (Fabio 19/11, Deborah: ela pediu a certidão de ônus pra preencher o formulário do Inter — a certidão já estava na
 * pasta, "IMOVEL/CERTIDAO ONUS APTO PEDRO.pdf", mas a IA ofereceu EMITIR uma nova e pediu o contrato; "o CRM também pode encaminhar documentos ao cliente").
 * Quando o cliente pede um documento, o prompt recebe a lista dos arquivos da pasta do Drive do card; a IA marca "sendDocs" com o(s) nome(s) e o CRM manda o(s) arquivo(s)
 * no WhatsApp logo depois da resposta dela. O mesmo arquivo não sai duas vezes em 30 min.
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

const PEDE = /(mand[ae]|mandar|pass[ae]|passar|envi[ae]|enviar|encaminh[ae]|encaminhar|me\s+d[aá]|tem\s+(a|o|como)|consegue|preciso|cad[eê]|onde\s+(est[aá]|fica)|c[oó]pia)/i;
const DOC = /(certid|[oô]nus|matr[ií]cula|documento|contrato|escritura|iptu|boleto|ficha|comprovante|\bcnh\b|\brg\b|laudo|arquivo|\bpdf\b|simula|proposta|minuta|declara[cç])/i;
const TIPOS = /^(application\/pdf|image\/(jpeg|png|webp))$/i;
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_POR_VEZ = 3;

/** O cliente está pedindo um documento ("Vc pode me passar o ônus do imóvel")? Pura (testável). */
export function clientePedeDocumento(texto: string | null | undefined): boolean {
  const t = String(texto || '');
  return PEDE.test(t) && DOC.test(t);
}

const caminho = (f: { path: string; name: string }) => (f.path ? `${f.path}/${f.name}` : f.name);
const norm = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*[/>]\s*/g, '/').trim();

async function arquivosDoCard(accountId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  const link = String(((lead?.customFields || {}) as Record<string, any>).link_pasta_drive || '').trim();
  if (!link) return [];
  const { extractFolderId } = require('./google.service') as typeof import('./google.service');
  const { listar } = require('./drive-de-fora.service') as typeof import('./drive-de-fora.service');
  const todos = await listar(accountId, extractFolderId(link));
  return todos
    .filter((f) => TIPOS.test(f.mimeType) && f.size > 0 && f.size <= MAX_BYTES && !/^__OCR_TMP/i.test(f.name)
      // simulação/evolução das parcelas vai pelo "sendSimulation" (PDF do banco com a logo, regra própria) — não por esta lista
      && !/SIMULA|EVOLU[CÇ][AÃ]O.?(DAS.?)?PARCELAS/i.test(f.name.normalize('NFD').replace(/[̀-ͯ]/g, '')))
    .map((f) => ({ ...f, path: f.path.replace(/\s*>\s*/g, '/') }))
    .sort((a, b) => caminho(a).localeCompare(caminho(b)));
}

/** Bloco do prompt com os arquivos que o CRM pode encaminhar — só quando o cliente pede um documento (lista a pasta do Drive, então não roda em toda resposta). */
export async function aiArquivosContext(accountId: string, leadId: string, incomingText: string): Promise<string> {
  if (!clientePedeDocumento(incomingText)) return '';
  const arqs = await arquivosDoCard(accountId, leadId);
  if (!arqs.length) return '';
  return `ARQUIVOS NA PASTA DO CLIENTE — O CRM PODE ENCAMINHAR (Fabio 19/11, Deborah pediu a certidão de ônus que já estava na pasta e a IA ofereceu emitir outra): o cliente parece estar pedindo um documento. Se o que ele pediu está nesta lista, NÃO ofereça emitir de novo nem peça outro documento pra isso: diga em 1 frase que já vai mandar e marque "sendDocs" com o NOME EXATO do(s) arquivo(s), como aparece na lista (com a pasta). O CRM manda o arquivo logo depois da sua mensagem. Mande só o que ele pediu (no máximo ${MAX_POR_VEZ}) e nunca diga que mandou sem marcar "sendDocs". Se não estiver na lista, siga as outras regras (ex.: oferecer a emissão da certidão).
${arqs.slice(0, 80).map((f) => `- ${caminho(f)}`).join('\n')}`;
}

/** "sendDocs" do JSON da IA: lista de nomes (texto), no máximo 3. Pura (testável). */
export function parseSendDocs(v: unknown): string[] | null {
  const xs = (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []).map((x) => String(x || '').trim()).filter((x) => x && x.toLowerCase() !== 'null').map((x) => x.slice(0, 250));
  return xs.length ? xs.slice(0, MAX_POR_VEZ) : null;
}

/** Manda ao cliente (WhatsApp) os arquivos da pasta que a IA marcou em "sendDocs". Nome que não bate com a pasta = nota + push pra equipe. */
export async function encaminharDocumentosDaIa(accountId: string, leadId: string, pedidos: string[], io?: Io): Promise<void> {
  if (!pedidos.length) return;
  const arqs = await arquivosDoCard(accountId, leadId);
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const ja = (((lead?.customFields || {}) as Record<string, any>)._docsEncaminhados || {}) as Record<string, string>;
  const { downloadDriveFile } = require('./google.service') as typeof import('./google.service');
  const { sendOutboundMedia } = require('./message.service') as typeof import('./message.service');
  const enviados: string[] = [];
  const falhas: string[] = [];
  for (const pedido of pedidos.slice(0, MAX_POR_VEZ)) {
    const p = norm(pedido);
    const f = arqs.find((a) => norm(caminho(a)) === p) || arqs.find((a) => norm(a.name) === p) || arqs.find((a) => norm(caminho(a)).endsWith(`/${p}`));
    if (!f) { falhas.push(`"${pedido}" (não achei na pasta)`); continue; }
    if (ja[f.id] && Date.now() - Date.parse(ja[f.id]) < 30 * 60_000) continue; // acabou de ir
    try {
      const buffer = await downloadDriveFile(accountId, f.id, f.mimeType);
      const r = await sendOutboundMedia({ accountId, leadId, buffer, fileName: f.name, mimeType: f.mimeType, io: io as any });
      if (!r.success) { falhas.push(`"${caminho(f)}" (${r.error})`); continue; }
      enviados.push(caminho(f));
      const marca = JSON.stringify({ [f.id]: new Date().toISOString() });
      await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsEncaminhados}', COALESCE("customFields"->'_docsEncaminhados', '{}'::jsonb) || ${marca}::jsonb, true) WHERE id = ${leadId}`.catch(() => {});
    } catch (e: any) { falhas.push(`"${caminho(f)}" (${e?.message || 'erro'})`); }
  }
  const linhas = [
    ...(enviados.length ? [`📎 A IA encaminhou ao cliente, a pedido dele, ${enviados.length === 1 ? 'o arquivo' : 'os arquivos'} da pasta do card: ${enviados.join('; ')}.`] : []),
    ...(falhas.length ? [`⚠️ A IA disse que ia mandar ${falhas.join('; ')}, mas o arquivo não foi. Mande à mão.`] : []),
  ];
  if (linhas.length) await prisma.note.create({ data: { leadId, type: 'COMMENT', content: linhas.join('\n') } }).catch(() => {});
  if (falhas.length) {
    try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: `⚠️ ${lead?.name || 'Cliente'}: documento não foi`, body: 'A IA disse que ia mandar um documento da pasta e ele não foi. Mande à mão.', leadId }).catch(() => {}); } catch { /* aviso */ }
  }
}
