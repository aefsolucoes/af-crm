import JSZip from 'jszip';
import { prisma } from '../lib/prisma';

/**
 * DOCUMENTAÇÃO ZIPADA (Fabio 12/11: "esse cliente mandou documentação zipada, precisa extrair e colocar na pasta dele"). O cliente manda um .zip pelo WhatsApp
 * ou por e-mail; o CRM abre e anexa cada PDF/imagem NA PRÓPRIA MENSAGEM — dali em diante é anexo comum: Drive → pasta do cliente (received-docs) → conferência
 * de documentos → lembretes. O .zip, depois de aberto, conta como "não é documento" (a conferência não tenta ler e a pasta organizada manda pra DESNECESSARIO).
 *
 * O zip é arquivo de TERCEIRO: nada vai pra disco e nada é executado. Abre em memória, um arquivo por vez, com teto de quantidade, de tamanho por arquivo e de
 * tamanho total (contado no que DE FATO sai da descompactação — o tamanho declarado pode mentir). Só entra PDF e imagem, conferidos pelo CONTEÚDO do arquivo;
 * caminho com ".." ou absoluto fica de fora. Zip com senha, corrompido ou grande demais → anotação + push pra equipe, sem travar nada.
 * .rar/.7z e parecidos o CRM não abre: só avisa a equipe.
 */

const MB = 1024 * 1024;
export const ZIP_LIMITES = { zipBytes: 100 * MB, entradas: 2000, arquivos: 60, arquivoBytes: 25 * MB, totalBytes: 150 * MB };
export type ZipLimites = typeof ZIP_LIMITES;

type Anexo = { fileName?: string | null; mimeType?: string | null };
const ZIP_MIMES = ['application/zip', 'application/x-zip', 'application/x-zip-compressed'];
/** .zip pelo nome, ou pelo tipo quando o nome não diz outra coisa (docx/xlsx/apk… também são zip por dentro e NÃO são pacote de documentos). */
export const isZipFile = (a: Anexo) => {
  const nome = (a.fileName || '').trim();
  if (/\.zip$/i.test(nome)) return true;
  return ZIP_MIMES.includes((a.mimeType || '').toLowerCase()) && !/\.[a-z0-9]{2,5}$/i.test(nome);
};
/** Compactado que o CRM NÃO abre (só avisa a equipe). */
export const isOtherArchive = (a: Anexo) => !isZipFile(a) && (/\.(rar|7z|tar|gz|tgz|bz2|xz)$/i.test((a.fileName || '').trim())
  || /^application\/(vnd\.rar|x-rar|x-rar-compressed|x-7z-compressed|gzip|x-gzip|x-tar|x-bzip2?|x-xz)$/i.test(a.mimeType || ''));

export type ZipRecusa = 'SENHA' | 'CORROMPIDO' | 'GRANDE' | 'ENTRADAS';
export class ZipRecusado extends Error {
  constructor(public motivo: ZipRecusa, detalhe?: string) { super(detalhe || motivo); }
}

// ─── Leitura do zip (sem banco, sem disco) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tipo pelo CONTEÚDO (assinatura do arquivo) — o nome não vale: "contrato.pdf" que é um executável fica de fora. Só PDF e imagem. */
export function tipoPeloConteudo(b: Buffer): { mime: string; ext: string } | null {
  if (b.length < 12) return null;
  const txt = (de: number, ate: number) => b.toString('latin1', de, ate);
  if (b.subarray(0, 1024).includes('%PDF-')) return { mime: 'application/pdf', ext: 'pdf' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a) return { mime: 'image/png', ext: 'png' };
  if (txt(0, 4) === 'GIF8') return { mime: 'image/gif', ext: 'gif' };
  if (txt(0, 4) === 'RIFF' && txt(8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (txt(4, 8) === 'ftyp') {
    const marca = txt(8, 12);
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(marca)) return { mime: 'image/heic', ext: 'heic' };
    if (/^avi[fs]$/.test(marca)) return { mime: 'image/avif', ext: 'avif' };
  }
  if (b.readUInt32BE(0) === 0x49492a00 || b.readUInt32BE(0) === 0x4d4d002a) return { mime: 'image/tiff', ext: 'tif' };
  if (txt(0, 2) === 'BM' && b.readUInt32LE(6) === 0) return { mime: 'image/bmp', ext: 'bmp' };
  return null;
}

// Nome de arquivo sem a marca de UTF-8 no zip: compactador antigo do Windows grava na página de código do DOS (CP850 no Brasil) — "Certidão" virava "Certid├úo".
const CP850 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ';
export function decodeNomeZip(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* não é UTF-8: página do DOS */ }
  return Array.from(bytes, (c) => (c < 0x80 ? String.fromCharCode(c) : CP850[c - 0x80])).join('');
}

const EXT_ACEITA = /^(pdf|jpe?g|jpe|jfif|png|gif|webp|heic|heif|avif|bmp|tiff?)$/i;
const extDe = (nome: string) => (/\.([a-z0-9]{1,5})$/i.exec(nome) || [])[1] || '';
const limpaParte = (s: string) => s.normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();

/** Nome do anexo a partir do caminho dentro do zip: a subpasta entra na frente ("Casa1/Frente.jpg" → "Casa1 - Frente.jpg") pra não perder o contexto nem
 *  misturar arquivos de mesmo nome. Nunca vira caminho — é só o nome que aparece na conversa e no Drive. */
export function nomeDoAnexo(partes: string[]): string {
  const limpas = partes.map(limpaParte).filter(Boolean);
  let nome = limpas.join(' - ') || 'arquivo';
  if (nome.length > 150) { const ext = extDe(nome); nome = `${nome.slice(0, 150 - (ext ? ext.length + 1 : 0)).trim()}${ext ? `.${ext}` : ''}`; }
  return nome;
}

/** Lixo que o compactador põe sozinho (Mac/Windows): não é arquivo do cliente, nem entra na lista do que ficou de fora. */
const ehLixo = (partes: string[]) => partes.includes('__MACOSX') || /^(\.ds_store|thumbs\.db|desktop\.ini)$/i.test(partes[partes.length - 1] || '') || /^(\._|~\$)/.test(partes[partes.length - 1] || '');
const caminhoSuspeito = (original: string) => /^[\\/]/.test(original) || /^[a-z]:/i.test(original) || original.split(/[\\/]/).includes('..');

/** Quantos arquivos o zip DIZ ter (registro do fim do arquivo) — conferido antes de abrir, pra um zip com milhões de entradas não ocupar a memória. */
function entradasDeclaradas(buf: Buffer): number | null {
  const min = Math.max(0, buf.length - 65_557);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) return buf.readUInt16LE(i + 10);
  return null;
}

/** Descompacta UM arquivo contando os bytes que saem: passou do teto, para na hora (zip-bomba declara 1 KB e despeja gigabytes). */
function inflar(entry: JSZip.JSZipObject, max: number): Promise<Buffer | 'GRANDE'> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    let total = 0, fim = false;
    const s = (entry as any).internalStream('nodebuffer');
    s.on('data', (c: Buffer) => {
      if (fim) return;
      total += c.length;
      if (total > max) { fim = true; s.pause(); resolve('GRANDE'); return; }
      partes.push(c);
    }).on('error', (e: Error) => { if (!fim) { fim = true; reject(e); } })
      .on('end', () => { if (!fim) { fim = true; resolve(Buffer.concat(partes)); } })
      .resume();
  });
}

export type ItemZip = { tipo: 'arquivo'; fileName: string; mimeType: string; data: Buffer } | { tipo: 'ignorado'; nome: string; motivo: string };

/**
 * Abre o zip e entrega um item por vez: o arquivo aceito (PDF/imagem, já com nome limpo e tipo conferido) ou o que ficou de fora, com o motivo.
 * Quem chama grava cada arquivo antes de pedir o próximo — só um fica na memória. Zip que não abre (senha, corrompido, grande demais) → ZipRecusado.
 */
export async function* lerZip(buf: Buffer, lim: ZipLimites = ZIP_LIMITES): AsyncGenerator<ItemZip> {
  if (buf.length > lim.zipBytes) throw new ZipRecusado('GRANDE', `${Math.round(buf.length / MB)} MB`);
  const declaradas = entradasDeclaradas(buf);
  if (declaradas === null) throw new ZipRecusado('CORROMPIDO', 'sem o registro de fim do zip');
  if (declaradas === 0xffff || declaradas > lim.entradas) throw new ZipRecusado('ENTRADAS', `${declaradas === 0xffff ? 'mais de 65 mil' : declaradas} itens`);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf, { decodeFileName: (b) => decodeNomeZip(Buffer.from(b as Uint8Array)) });
  } catch (e: any) {
    throw new ZipRecusado(/encrypt/i.test(e?.message || '') ? 'SENHA' : 'CORROMPIDO', e?.message);
  }

  const entradas = Object.values(zip.files).filter((e) => !e.dir).map((e) => ({ e, original: String((e as any).unsafeOriginalName || e.name), partes: e.name.split('/').filter(Boolean) }))
    .filter((x) => x.partes.length && !ehLixo(x.partes));
  // Pasta única que embrulha tudo ("Documentos_HomeEquity/…"): sai do nome. Subpasta de verdade ("Casa1/…") fica.
  const validas = entradas.filter((x) => !caminhoSuspeito(x.original));
  while (validas.length && validas.every((x) => x.partes.length > 1 && x.partes[0] === validas[0].partes[0])) validas.forEach((x) => x.partes.shift());

  const usados = new Set<string>();
  const passaDoTotal = `o zip passa de ${Math.round(lim.totalBytes / MB)} MB aberto`;
  // `total` = bytes dos arquivos aceitos; `trabalho` = tudo que foi descompactado, inclusive o que acabou de fora — teto do esforço gasto com um zip malicioso.
  let aceitos = 0, total = 0, trabalho = 0;
  for (const x of entradas) {
    const nomeBruto = nomeDoAnexo(x.partes);
    const fora = (motivo: string): ItemZip => ({ tipo: 'ignorado', nome: nomeBruto, motivo });
    if (caminhoSuspeito(x.original)) { yield fora('caminho suspeito dentro do zip'); continue; }
    // "Comprovante 10.2026" não tem extensão de verdade (o tipo sai do conteúdo); "planilha.xlsx" tem, e nem é aberto.
    const ext = /^([a-z]{2,5}|mp3|mp4|m4a|m4v|3gp|7z)$/i.test(extDe(nomeBruto)) ? extDe(nomeBruto) : '';
    if (ext && !EXT_ACEITA.test(ext)) { yield fora(/^(zip|rar|7z|gz|tar|tgz)$/i.test(ext) ? 'outro compactado dentro do zip' : 'não é PDF nem imagem'); continue; }
    const declarado = Number((x.e as any)._data?.uncompressedSize) || 0;
    if (declarado > lim.arquivoBytes) { yield fora(`grande demais (${Math.round(declarado / MB)} MB)`); continue; }
    if (aceitos >= lim.arquivos) { yield fora(`passou do limite de ${lim.arquivos} arquivos por zip`); continue; }
    if (total + declarado > lim.totalBytes || trabalho > lim.totalBytes * 2) { yield fora(passaDoTotal); continue; }
    const teto = Math.min(lim.arquivoBytes, lim.totalBytes - total);
    let data: Buffer | 'GRANDE';
    try { data = await inflar(x.e, teto); } catch { yield fora('corrompido dentro do zip'); continue; }
    trabalho += data === 'GRANDE' ? teto : data.length;
    if (data === 'GRANDE') { yield fora(teto < lim.arquivoBytes ? passaDoTotal : `grande demais (mais de ${Math.round(teto / MB)} MB)`); continue; }
    if (!data.length) { yield fora('arquivo vazio'); continue; }
    const tipo = tipoPeloConteudo(data);
    if (!tipo) { yield fora(ext ? 'o conteúdo não é PDF nem imagem' : 'não é PDF nem imagem'); continue; }
    total += data.length;
    aceitos++;
    // Sem extensão, ou "x.pdf" que na verdade é foto (e vice-versa): o nome ganha a extensão do conteúdo. Mesmo nome duas vezes no zip: o segundo ganha "(2)".
    const base = ext && (/^pdf$/i.test(ext) === (tipo.ext === 'pdf')) ? nomeBruto : `${nomeBruto}.${tipo.ext}`;
    let fileName = base;
    for (let n = 2; usados.has(fileName.toLowerCase()); n++) fileName = base.replace(/(\.[a-z0-9]{1,5})$/i, ` (${n})$1`);
    usados.add(fileName.toLowerCase());
    yield { tipo: 'arquivo', fileName, mimeType: tipo.mime, data };
  }
}

// ─── Gravação no card ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ResultadoZip = { arquivos: string[]; repetidos: number; ignorados: string[]; erro?: string };
type Io = any;

/** Anotação que não se repete (a extração pode rodar de novo: endpoint, retomada depois de reinício). */
async function notaUnica(leadId: string, content: string): Promise<boolean> {
  if (await prisma.note.findFirst({ where: { leadId, content }, select: { id: true } })) return false;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
  return true;
}

async function avisarEquipe(accountId: string, leadId: string, title: string, body: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { userId: true } });
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title, body: body.slice(0, 160), leadId }, lead?.userId ? [lead.userId] : undefined).catch(() => {});
}

const RECUSA: Record<ZipRecusa, (nome: string, detalhe: string) => string> = {
  SENHA: (n) => `🔒 O cliente mandou "${n}" protegido por SENHA e o CRM não abre. Peça a senha (ou os arquivos soltos, em PDF/foto), extraia e anexe os documentos no card.`,
  CORROMPIDO: (n) => `⚠️ O cliente mandou "${n}", mas o arquivo não abre (corrompido ou não é um .zip de verdade). Peça pra ele mandar de novo, de preferência os arquivos soltos em PDF/foto.`,
  GRANDE: (n, d) => `⚠️ O cliente mandou "${n}" grande demais pro CRM abrir sozinho (${d}; o limite é ${ZIP_LIMITES.zipBytes / MB} MB). Baixe pela conversa, extraia e anexe os documentos no card.`,
  ENTRADAS: (n, d) => `⚠️ O cliente mandou "${n}" com itens demais pro CRM abrir sozinho (${d}). Baixe pela conversa, extraia e anexe só os documentos no card.`,
};

const abrindoAgora = new Set<string>(); // mensagem + zip em extração neste servidor: uma segunda chamada (clique repetido, retomada) não corre junto e duplica
type PedidoZip = { accountId: string; leadId: string; messageId: string; zipName: string; buffer: Buffer; zipAttachmentId?: string; io?: Io; tentativa?: number };

/**
 * Abre o zip e anexa cada PDF/imagem na mensagem `messageId`. Pode rodar de novo sem duplicar: arquivo com o mesmo nome já anexado à mensagem fica de fora.
 * Cada arquivo sobe pro Drive antes do próximo (os bytes não se acumulam no banco). `zipAttachmentId`: o anexo do próprio .zip (WhatsApp) — depois de aberto
 * conta como "não é documento". Enquanto roda, o card leva a marca `_zipAbrindo` (ver retomarZipsInterrompidos).
 */
export async function extrairZipNaMensagem(p: PedidoZip): Promise<ResultadoZip> {
  const chave = `${p.messageId}|${p.zipName}`;
  if (abrindoAgora.has(chave)) return { arquivos: [], repetidos: 0, ignorados: [], erro: 'EM ANDAMENTO' };
  abrindoAgora.add(chave);
  try { return await extrair(p); } finally { abrindoAgora.delete(chave); }
}

async function extrair(p: PedidoZip): Promise<ResultadoZip> {
  const out: ResultadoZip = { arquivos: [], repetidos: 0, ignorados: [] };
  const lead = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { name: true } });
  const quem = lead?.name || 'Cliente';
  // Conferido no banco arquivo por arquivo (não numa lista lida no começo): outro servidor pode estar terminando a mesma extração durante um deploy.
  const jaAnexado = async (nome: string) => !!(await prisma.messageAttachment.findFirst({ where: { messageId: p.messageId, fileName: { equals: nome, mode: 'insensitive' } }, select: { id: true } }));
  const { autoUploadAttachmentToDrive } = require('./google.service') as typeof import('./google.service');
  const marca = `${new Date().toISOString()}|${p.tentativa || 1}`;
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_zipAbrindo}', to_jsonb(${marca}::text), true) WHERE id = ${p.leadId}`.catch(() => {});
  let driveFora = false;
  try {
    for await (const item of lerZip(p.buffer)) {
      if (item.tipo === 'ignorado') { out.ignorados.push(`${item.nome} (${item.motivo})`); continue; }
      if (await jaAnexado(item.fileName)) { out.repetidos++; continue; }
      const att = await prisma.messageAttachment.create({ data: { messageId: p.messageId, leadId: p.leadId, fileName: item.fileName, mimeType: item.mimeType, data: item.data }, select: { id: true } });
      out.arquivos.push(item.fileName);
      // Drive fora do ar: os bytes ficam no banco e a rede de segurança (archiveOldAttachmentsAutomatic) recolhe depois — igual a um anexo comum. Falhou uma vez
      // (já com as tentativas do auto-upload), não insiste arquivo por arquivo.
      if (!driveFora) await autoUploadAttachmentToDrive(p.accountId, p.leadId, att.id).catch((err: any) => { driveFora = true; console.error('[Zip] Drive:', err?.message); });
    }
  } catch (e: any) {
    console.warn(`[Zip] ${quem} (${p.leadId}): "${p.zipName}" —`, e?.message);
    if (e instanceof ZipRecusado) {
      out.erro = e.motivo;
      if (await notaUnica(p.leadId, RECUSA[e.motivo](p.zipName, e.message))) {
        await avisarEquipe(p.accountId, p.leadId, `🗜️ ${quem}: zip que não abriu`, e.motivo === 'SENHA' ? `"${p.zipName}" tem senha — peça a senha ou os arquivos soltos` : `"${p.zipName}" não abriu sozinho — extraia à mão`);
      }
    } else {
      // Parou no meio (banco/rede): o que entrou fica; rodar de novo completa sem duplicar.
      out.erro = `ERRO: ${String(e?.message || 'erro').slice(0, 120)}`;
      if (await notaUnica(p.leadId, `⚠️ "${p.zipName}": o CRM anexou ${out.arquivos.length} arquivo(s) do zip e parou no meio por um erro. Confira o zip pela conversa e anexe no card o que faltar.`)) {
        await avisarEquipe(p.accountId, p.leadId, `🗜️ ${quem}: zip aberto pela metade`, `"${p.zipName}" — confira e anexe o que faltar`);
      }
    }
  } finally {
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_zipAbrindo' WHERE id = ${p.leadId} AND "customFields"->>'_zipAbrindo' = ${marca}`.catch(() => {});
  }
  if (out.erro && !out.arquivos.length) return out;

  const lista = (nomes: string[], max: number) => `${nomes.slice(0, max).join(', ')}${nomes.length > max ? ` e mais ${nomes.length - max}` : ''}`;
  const fora = out.ignorados.length ? `\n⚠️ Ficaram de fora (abra o zip pela conversa se precisar): ${lista(out.ignorados, 25)}` : '';
  if (out.arquivos.length) {
    await notaUnica(p.leadId, `🗜️ O cliente mandou "${p.zipName}": o CRM abriu e anexou ${out.arquivos.length} arquivo(s) na conversa — vão pra pasta do cliente e entram na conferência: ${lista(out.arquivos, 60)}${fora}`);
    const { scheduleDocsCheck } = require('./docs-checker.service') as typeof import('./docs-checker.service');
    await scheduleDocsCheck(p.accountId, p.leadId, p.io).catch(() => {});
    if (p.io) p.io.to(`lead:${p.leadId}`).emit('message_attachments_added', { leadId: p.leadId, messageId: p.messageId });
    if (out.ignorados.length) await avisarEquipe(p.accountId, p.leadId, `🗜️ ${quem}: zip aberto`, `${out.arquivos.length} arquivo(s) anexados; ${out.ignorados.length} ficaram de fora — veja a anotação`);
  } else if (!out.repetidos && !out.erro) {
    if (await notaUnica(p.leadId, `⚠️ O cliente mandou "${p.zipName}", mas não tinha PDF nem imagem que o CRM pudesse anexar.${fora || ' O zip está vazio.'}`)) {
      await avisarEquipe(p.accountId, p.leadId, `🗜️ ${quem}: zip sem documento`, `"${p.zipName}" não tinha PDF nem imagem — confira pela conversa`);
    }
  }
  // O .zip aberto não é documento: a conferência não conta como "arquivo não lido" e a pasta organizada manda pra DESNECESSARIO. Só a chave do anexo, por SQL
  // (regravar o card inteiro apaga o que outro processo gravou no meio — ver customfields-write-race).
  if (p.zipAttachmentId && (out.arquivos.length || out.repetidos)) {
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docInfo}', COALESCE("customFields"->'_docInfo', '{}'::jsonb) || ${JSON.stringify({ [p.zipAttachmentId]: 'IGNORAR' })}::jsonb, true) WHERE id = ${p.leadId}`.catch(() => {});
  }
  console.log(`[Zip] ${quem} (${p.leadId}): "${p.zipName}" → ${out.arquivos.length} anexado(s), ${out.repetidos} já estavam, ${out.ignorados.length} de fora`);
  return out;
}

/** Compactado que o CRM não abre (.rar, .7z…): anotação + push — a equipe extrai à mão. */
async function avisarFormatoSemSuporte(accountId: string, leadId: string, nome: string): Promise<void> {
  if (!(await notaUnica(leadId, `🗜️ O cliente mandou "${nome}", um compactado que o CRM não abre sozinho (só .zip). Baixe pela conversa, extraia e anexe os documentos no card — ou peça os arquivos soltos, em PDF/foto.`))) return;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true } });
  await avisarEquipe(accountId, leadId, `🗜️ ${lead?.name || 'Cliente'}: arquivo compactado`, `"${nome}" não abre sozinho — extraia e anexe os documentos`);
}

/** Recebimento (WhatsApp, repasse do corretor/vendedor): o anexo que acabou de chegar é um compactado? .zip → abre e anexa; .rar/.7z → avisa a equipe.
 *  Conversa de GRUPO fica de fora (arquivo de grupo não sobe sozinho pro Drive e os bytes ficariam no banco). */
export async function aoReceberCompactado(p: { accountId: string; leadId: string; messageId: string; attachment?: { id: string; fileName: string; mimeType: string } | null; buffer: Buffer; io?: Io }): Promise<void> {
  const a = p.attachment;
  if (!a || (!isZipFile(a) && !isOtherArchive(a))) return;
  const lead = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { isGroup: true } });
  if (!lead || lead.isGroup) return;
  if (isOtherArchive(a)) { await avisarFormatoSemSuporte(p.accountId, p.leadId, a.fileName); return; }
  await extrairZipNaMensagem({ accountId: p.accountId, leadId: p.leadId, messageId: p.messageId, zipName: a.fileName, buffer: p.buffer, zipAttachmentId: a.id, io: p.io });
}

/** E-mail do cliente na conversa do card com .zip anexado: baixa o anexo do servidor de e-mail e abre na mensagem do e-mail. */
export async function extrairZipsDoEmail(p: { accountId: string; leadId: string; messageId: string; io?: Io; tentativa?: number }): Promise<ResultadoZip[]> {
  const m = await prisma.message.findFirst({ where: { id: p.messageId, leadId: p.leadId, channel: 'EMAIL' }, select: { externalId: true } });
  if (!m?.externalId) return [];
  const { emailMetaFor, conversationEmailAttachment, streamAttachment } = require('./email-inbox.service') as typeof import('./email-inbox.service');
  const anexos = (await emailMetaFor(p.accountId, p.leadId, [m.externalId])).get(m.externalId)?.attachments || [];
  const out: ResultadoZip[] = [];
  for (const a of anexos) {
    const arq = { fileName: a.filename, mimeType: a.contentType };
    if (isOtherArchive(arq)) { await avisarFormatoSemSuporte(p.accountId, p.leadId, a.filename); continue; }
    if (!isZipFile(arq) || !a.part) continue;
    try {
      const found = await conversationEmailAttachment(p.accountId, p.messageId, a.part);
      if (!found) throw new Error('anexo não encontrado no e-mail');
      const baixado: { partes: Buffer[]; total: number; grande: boolean } = { partes: [], total: 0, grande: false };
      await streamAttachment(found.acc, found.msg, a.part, async (_meta, content) => {
        for await (const c of content) {
          baixado.total += c.length;
          if (baixado.total > ZIP_LIMITES.zipBytes) { baixado.grande = true; baixado.partes = []; content.destroy(); break; }
          baixado.partes.push(Buffer.from(c));
        }
      });
      if (baixado.grande) {
        if (await notaUnica(p.leadId, RECUSA.GRANDE(a.filename, `mais de ${ZIP_LIMITES.zipBytes / MB} MB`))) await avisarEquipe(p.accountId, p.leadId, '🗜️ zip grande demais no e-mail', `"${a.filename}" — extraia à mão`);
        out.push({ arquivos: [], repetidos: 0, ignorados: [], erro: 'GRANDE' });
        continue;
      }
      if (!baixado.total) throw new Error('o servidor de e-mail não entregou o anexo');
      out.push(await extrairZipNaMensagem({ accountId: p.accountId, leadId: p.leadId, messageId: p.messageId, zipName: a.filename, buffer: Buffer.concat(baixado.partes), io: p.io, tentativa: p.tentativa }));
    } catch (e: any) {
      console.warn(`[Zip] e-mail ${p.messageId}: "${a.filename}" —`, e?.message);
      out.push({ arquivos: [], repetidos: 0, ignorados: [], erro: String(e?.message || 'erro').slice(0, 160) });
    }
  }
  return out;
}

/** Conversa antiga (ou retomada depois de reinício): abre todo .zip que o cliente já mandou neste card — WhatsApp e e-mail. Não duplica o que já foi anexado. */
export async function extrairZipsDoLead(accountId: string, leadId: string, io?: Io, opts: { tentativa?: number } = {}): Promise<{ zips: number; arquivos: string[]; jaAnexados: number; ignorados: string[]; falhas: string[] }> {
  const res = { zips: 0, arquivos: [] as string[], jaAnexados: 0, ignorados: [] as string[], falhas: [] as string[] };
  const soma = (nome: string, r: ResultadoZip) => { res.zips++; res.arquivos.push(...r.arquivos); res.jaAnexados += r.repetidos; res.ignorados.push(...r.ignorados); if (r.erro) res.falhas.push(`${nome}: ${r.erro}`); };
  const atts = (await prisma.messageAttachment.findMany({
    where: { leadId, message: { direction: 'INBOUND', deleted: false }, OR: [{ fileName: { endsWith: '.zip', mode: 'insensitive' } }, { mimeType: { in: ZIP_MIMES } }] },
    orderBy: { createdAt: 'asc' }, select: { id: true, messageId: true, fileName: true, mimeType: true, driveFileId: true },
  })).filter(isZipFile);
  for (const a of atts) {
    try {
      let buffer: Buffer | null = null;
      if (a.driveFileId) {
        const { getDrive, downloadDriveFile } = require('./google.service') as typeof import('./google.service');
        const tamanho = Number((await (await getDrive(accountId)).files.get({ fileId: a.driveFileId, fields: 'size', supportsAllDrives: true })).data.size || 0);
        if (tamanho > ZIP_LIMITES.zipBytes) { soma(a.fileName, { arquivos: [], repetidos: 0, ignorados: [], erro: `GRANDE (${Math.round(tamanho / MB)} MB)` }); continue; }
        buffer = await downloadDriveFile(accountId, a.driveFileId, a.mimeType);
      } else {
        const row = await prisma.messageAttachment.findUnique({ where: { id: a.id }, select: { data: true } });
        buffer = row?.data ? Buffer.from(row.data) : null;
      }
      if (!buffer) { res.falhas.push(`${a.fileName}: arquivo não encontrado`); continue; }
      soma(a.fileName, await extrairZipNaMensagem({ accountId, leadId, messageId: a.messageId, zipName: a.fileName, buffer, zipAttachmentId: a.id, io, tentativa: opts.tentativa }));
    } catch (e: any) {
      res.falhas.push(`${a.fileName}: ${String(e?.message || 'erro').slice(0, 160)}`);
    }
  }
  const emails = await prisma.message.findMany({ where: { leadId, direction: 'INBOUND', channel: 'EMAIL', deleted: false, content: { contains: '.zip', mode: 'insensitive' } }, select: { id: true } });
  for (const m of emails) for (const r of await extrairZipsDoEmail({ accountId, leadId, messageId: m.id, io, tentativa: opts.tentativa }).catch(() => [] as ResultadoZip[])) soma('zip do e-mail', r);
  return res;
}

// Extração cortada no meio por reinício do servidor (deploy): a marca `_zipAbrindo` de antes de o servidor subir = zip aberto pela metade. Roda de novo UMA vez
// (não duplica o que já entrou); se o servidor cair de novo com o mesmo zip, para de tentar e avisa a equipe — o próprio zip pode ser a causa.
const SERVER_BOOT_AT = Date.now();
export async function retomarZipsInterrompidos(io: Io): Promise<void> {
  const boot = new Date(SERVER_BOOT_AT).toISOString();
  const leads = await prisma.$queryRaw<{ id: string; accountId: string; name: string; marca: string }[]>`SELECT id, "accountId", name, "customFields"->>'_zipAbrindo' AS marca FROM "Lead" WHERE "customFields"->>'_zipAbrindo' < ${boot}`;
  for (const l of leads) {
    const pegou = await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_zipAbrindo' WHERE id = ${l.id} AND "customFields"->>'_zipAbrindo' = ${l.marca}`;
    if (!pegou) continue;
    const tentativa = Number(String(l.marca).split('|')[1]) || 1;
    if (tentativa >= 2) {
      if (await notaUnica(l.id, '⚠️ O CRM tentou abrir o .zip do cliente duas vezes e o servidor reiniciou no meio nas duas. Baixe o zip pela conversa, extraia e anexe os documentos que faltarem no card.')) await avisarEquipe(l.accountId, l.id, `🗜️ ${l.name}: zip aberto pela metade`, 'Confira os documentos e anexe os que faltarem');
      continue;
    }
    console.log(`[Zip] ${l.name} (${l.id}): extração cortada pelo reinício do servidor — abrindo de novo`);
    await extrairZipsDoLead(l.accountId, l.id, io, { tentativa: tentativa + 1 }).catch((e: any) => console.error('[Zip] retomada após reinício:', e?.message));
  }
}
