import { prisma } from '../lib/prisma';
import { sendOutboundMedia } from './message.service';
import { camposDaProposta, dadosWebCasas, inspecionarRetornoUsecasa, participantesDe, preencherAutorizacaoUsecasa, preencherWebCasas } from './santander-forms';

type Io = Parameters<typeof sendOutboundMedia>[0]['io'];

/**
 * VISTORIA DO SANTANDER (Fabio 21/10, caso Edson do Carmo: "por e-mail, tem dois anexos que o CRM precisa preencher e encaminhar"). Fluxo, a partir de documentação completa + cliente seguindo pelo Santander (vigia da vistoria):
 *  1) o CRM preenche a "Autorização do(s) Cliente(s) para USECASA" (PDF) e manda ao cliente pelo WhatsApp pra ele ASSINAR PELO GOV.BR e devolver;
 *  2) quando o PDF assinado volta (reconhece pela palavra-chave gravada no arquivo + assinatura digital), junta os documentos da pasta do Drive: do IMÓVEL a CND de IPTU, a capa do IPTU e a certidão de
 *     ônus/matrícula; do CLIENTE o documento de identidade e a certidão de estado civil. A CND de IPTU a A&F emite: sem ela na pasta, a equipe recebe nota + push pra emitir e subir;
 *  3) preenche o "Cadastro de Informações - WEB CASAS" (Word) com o que se sabe (proposta do site + card) e manda TUDO por e-mail pra Letícia (pela caixa comercial). Se faltar dado essencial do cadastro,
 *     NÃO envia: avisa a equipe com a lista e guarda o Word preenchido na pasta IMOVEL do Drive pra completar à mão;
 *  4) enviado: card vai pra "Vistoria do Imóvel". Estado em customFields._vistoriaSant.
 */

export const VISTORIA_SANTANDER_TO = process.env.VISTORIA_SANTANDER_TO || 'leticia.gomes@credimorar.com.vc';
const AVISO_REPETIR_MS = 12 * 3600_000;

type St = { status?: string; askedAt?: string; signedAt?: string; signedName?: string; cndNoteAt?: string; faltaNoteAt?: string; semAssinaturaNoteAt?: string; teamAskNoteAt?: string; sentAt?: string; to?: string; erro?: string };

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };
async function salva(leadId: string, patch: Partial<St>) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  cf._vistoriaSant = { ...(cf._vistoriaSant || {}), ...patch };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}
const faz = (iso?: string) => (iso ? Date.now() - new Date(iso).getTime() : Infinity);

export const textoPedidoAssinatura = (nome: string, doisParticipantes: boolean): string => [
  `${nome ? `${nome}, p` : 'P'}ra seguir com a vistoria do imóvel, preciso que você assine esta autorização pelo gov.br e me devolva o PDF assinado:`,
  '',
  '1. Acesse assinador.iti.br (ou o app gov.br, em "Assinatura digital")',
  '2. Envie o PDF, entre com a sua conta gov.br e assine',
  '3. Baixe o arquivo assinado e me mande por aqui',
  ...(doisParticipantes ? ['', 'O 2º participante também precisa assinar: ele assina o mesmo arquivo, depois de você (ou cada um assina e me manda).'] : []),
  '',
  'Qualquer dúvida na hora de assinar, me avise.',
].join('\n');

type DriveF = { id: string; name: string; path: string; mimeType: string; size: number };
const OK_ARQ = /^(application\/pdf|image\/)/;
const ordena = (a: DriveF, b: DriveF) => a.name.localeCompare(b.name);

/** Separa os arquivos da pasta do cliente nas categorias que a Letícia pede. Pura (testável). */
export function categoriasDoDrive(files: DriveF[]): Record<'cnd' | 'capa' | 'onus' | 'ident' | 'civil', DriveF[]> {
  const ok = files.filter((f) => OK_ARQ.test(f.mimeType) && (f.size || 0) <= 12 * 1024 * 1024 && !/^VERIFICAR/i.test(f.name)).sort(ordena);
  const n = (f: DriveF) => f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const cert = ok.filter((f) => /^CERTIDAO DE ONUS/.test(n(f)));
  return {
    cnd: ok.filter((f) => /CND IPTU|CERTIDAO NEGATIVA.*(IPTU|DEBITO)/.test(n(f))),
    capa: ok.filter((f) => /CAPA IPTU/.test(n(f))).slice(0, 2),
    onus: (cert.length ? cert : ok.filter((f) => /^MATRICULA DO IMOVEL/.test(n(f)))).slice(0, 2),
    ident: ok.filter((f) => /^(RG|CNH|CPF|DOCUMENTO DE IDENTIFICACAO|CARTEIRA DE IDENTIDADE)\b/.test(n(f))).slice(0, 4),
    civil: ok.filter((f) => /^CERTIDAO DE (CASAMENTO|NASCIMENTO|OBITO|UNIAO)/.test(n(f))).slice(0, 2),
  };
}

async function arquivosDoDrive(accountId: string, cf: Record<string, any>): Promise<DriveF[]> {
  const link = String(cf.link_pasta_drive || '').trim();
  if (!link) return [];
  try {
    const { extractFolderId, listAllFilesInFolderTree } = await import('./google.service');
    return (await listAllFilesInFolderTree(accountId, extractFolderId(link), 3)) as DriveF[];
  } catch { return []; }
}

async function bytesDoAnexo(accountId: string, a: { data: Uint8Array | Buffer | null; driveFileId: string | null; mimeType: string }): Promise<Buffer | null> {
  if (a.data && a.data.length) return Buffer.from(a.data);
  if (!a.driveFileId) return null;
  try { const { downloadDriveFile } = await import('./google.service'); return await downloadDriveFile(accountId, a.driveFileId, a.mimeType); } catch { return null; }
}

/** Guarda um formulário na subpasta FORMULARIOS da pasta do cliente no Drive (Fabio 21/10: "abre uma pasta FORMULARIOS no Drive do cliente e coloca esses formulários lá"). Sem pasta do cliente: não guarda (não trava o fluxo). */
async function guardaFormulario(accountId: string, cf: Record<string, any>, nome: string, mimeType: string, data: Buffer): Promise<boolean> {
  const link = String(cf.link_pasta_drive || '').trim();
  if (!link) return false;
  try {
    const { extractFolderId, createFolder, uploadFile } = await import('./google.service');
    const pasta = await createFolder(accountId, 'FORMULARIOS', extractFolderId(link));
    await uploadFile(accountId, { name: nome, mimeType, parentId: pasta.id, data });
    return true;
  } catch (e: any) { console.warn('[Vistoria Santander] não consegui guardar o formulário no Drive:', e?.message); return false; }
}

/** Chamado pelo vigia da vistoria (um card por vez) quando o cliente segue pelo Santander. Devolve true quando o pedido já foi enviado. */
export async function processVistoriaSantander(accountId: string, leadId: string, io: Io): Promise<boolean> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true, contact: { select: { phone: true } } } });
  if (!lead) return false;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused) return false;
  const st = (cf._vistoriaSant || {}) as St;
  if (st.status === 'ENVIADA') return true;

  const propMsg = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Proposta preenchida no site' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  const campos = camposDaProposta(propMsg?.content || '');
  const { p1, p2 } = participantesDe(cf, campos, lead.name);
  const primeiroNome = (p1.nome.split(/\s+/)[0] || '').toLowerCase().replace(/^./, (c) => c.toUpperCase());

  // 1) mandar a autorização pro cliente assinar
  if (!st.askedAt) {
    if (!lead.aiAutoReplyActive) {
      if (!st.teamAskNoteAt) { await salva(leadId, { teamAskNoteAt: new Date().toISOString() }); await note(leadId, '🏦 Santander: documentação completa. Falta mandar ao cliente a autorização USECASA pra assinar pelo gov.br (IA do card desligada: o CRM não mandou sozinho).'); push(accountId, '🏦 Vistoria Santander', `${lead.name}: mandar a autorização USECASA pra assinar`, leadId); }
      return false;
    }
    const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
    if (!inNoticeWindow()) return false;
    if (!(await whatsappWindowOpen(leadId))) {
      if (!st.teamAskNoteAt) { await salva(leadId, { teamAskNoteAt: new Date().toISOString() }); await note(leadId, '🏦 Santander: documentação completa, mas a janela de 24 h do WhatsApp está fechada. A autorização USECASA sai assim que o cliente responder qualquer mensagem.'); push(accountId, '🏦 Vistoria Santander', `${lead.name}: janela fechada, aguardando o cliente falar`, leadId); }
      return false;
    }
    const cidade = (campos['Cidade/UF residência'] || campos['Imóvel em garantia'] || '').replace(/\s*\/\s*[A-Za-z]{2}\s*$/, '').trim();
    const pdf = await preencherAutorizacaoUsecasa({ p1, p2, cidade, leadId });
    const sent = await sendOutboundMedia({ accountId, leadId, buffer: pdf, fileName: 'Autorizacao USECASA - assinar pelo gov.br.pdf', mimeType: 'application/pdf', caption: textoPedidoAssinatura(primeiroNome, !!p2), io });
    if (!sent.success) return false;
    await salva(leadId, { status: 'ASSINATURA_PEDIDA', askedAt: new Date().toISOString() });
    const guardou = await guardaFormulario(accountId, cf, 'AUTORIZACAO USECASA - PARA ASSINAR.pdf', 'application/pdf', pdf);
    await note(leadId, `🏦 Santander: mandei ao cliente a autorização USECASA (já com nomes e CPFs) pra assinar pelo gov.br${guardou ? ' (cópia na pasta FORMULARIOS do Drive)' : ''}. Quando o PDF assinado voltar, o CRM junta os documentos e pede a vistoria por e-mail à Letícia.`);
    return false;
  }

  // 2) esperar o PDF assinado de volta
  if (!st.signedAt) {
    const atts = await prisma.messageAttachment.findMany({ where: { leadId, mimeType: 'application/pdf', createdAt: { gt: new Date(st.askedAt) }, message: { direction: 'INBOUND' } }, orderBy: { createdAt: 'asc' }, select: { id: true, fileName: true, mimeType: true, data: true, driveFileId: true } });
    for (const a of atts) {
      const bytes = await bytesDoAnexo(accountId, a);
      if (!bytes) continue;
      const r = await inspecionarRetornoUsecasa(bytes, leadId);
      if (r.nosso && r.assinado) {
        await salva(leadId, { status: 'ASSINADA', signedAt: new Date().toISOString(), signedName: a.fileName });
        const guardou = await guardaFormulario(accountId, cf, 'AUTORIZACAO USECASA - ASSINADA.pdf', 'application/pdf', bytes);
        await note(leadId, `🏦 Santander: o cliente devolveu a autorização USECASA ASSINADA (${a.fileName})${guardou ? ' — guardada na pasta FORMULARIOS do Drive' : ''}. Agora o CRM junta os documentos da pasta do Drive.`);
        break;
      }
      if (r.nosso && !r.assinado && faz(st.semAssinaturaNoteAt) > AVISO_REPETIR_MS) { await salva(leadId, { semAssinaturaNoteAt: new Date().toISOString() }); await note(leadId, `🏦 Santander: o cliente mandou de volta a autorização (${a.fileName}), mas SEM assinatura digital do gov.br. Peça pra ele assinar em assinador.iti.br e mandar de novo.`); }
    }
    const depois = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields as any)?._vistoriaSant as St | undefined;
    if (!depois?.signedAt) return false;
    st.signedAt = depois.signedAt; st.signedName = depois.signedName;
  }

  // 3) documentos da pasta do Drive
  const files = await arquivosDoDrive(accountId, cf);
  const cat = categoriasDoDrive(files);
  const faltam: string[] = [];
  if (!cat.cnd.length) faltam.push('CND de IPTU (a A&F emite)');
  if (!cat.capa.length) faltam.push('capa do IPTU');
  if (!cat.onus.length) faltam.push('certidão de ônus/matrícula');
  if (cat.ident.length < (p2 ? 2 : 1)) faltam.push(`documento de identidade${p2 ? ' (dos dois)' : ''}`);
  if (!cat.civil.length) faltam.push('certidão de estado civil');
  if (faltam.length) {
    if (faz(st.faltaNoteAt) > AVISO_REPETIR_MS) {
      await salva(leadId, { status: 'AGUARDA_DOCS', faltaNoteAt: new Date().toISOString(), ...(faltam.some((f) => /CND/.test(f)) ? { cndNoteAt: new Date().toISOString() } : {}) });
      const cnd = faltam.some((f) => /CND/.test(f));
      const insc = String((cf._docReview && Object.values(cf._docReview as Record<string, any>).map((r: any) => r?.inscricao).find(Boolean)) || '').trim();
      await note(leadId, `🏦 Santander: autorização assinada, mas a pasta do Drive ainda não tem: ${faltam.join('; ')}.${cnd ? `\nA CND de IPTU é da A&F: emitir no site da prefeitura do município do imóvel (certidão negativa de débitos imobiliários/IPTU)${insc ? `, inscrição ${insc}` : ''}, e subir na subpasta IMOVEL do Drive (nome "CND IPTU"). Assim que estiver na pasta, o CRM envia o pedido à Letícia.` : ''}`);
      push(accountId, '🏦 Vistoria Santander: falta documento', `${lead.name}: ${faltam.join('; ').slice(0, 110)}`, leadId);
    }
    return false;
  }

  // 4) cadastro WEB CASAS + e-mail
  const contatoPessoa = String(cf.contato_vistoria || '').trim() || p1.nome;
  const telefone = String(cf.telefone_1 || lead.contact?.phone || campos['Celular'] || '').trim();
  const dados = dadosWebCasas(cf, campos, lead.name, { pessoa: contatoPessoa, telefone });
  const essenciais = dados.faltando.filter((f) => /sexo|estado civil|n[uú]mero do documento|endere[cç]o completo do im[oó]vel|tipo do im[oó]vel|telefone do comprador/i.test(f));
  const docx = await preencherWebCasas(dados.ops);
  if (essenciais.length) {
    if (faz(st.faltaNoteAt) > AVISO_REPETIR_MS || st.status !== 'FALTAM_DADOS') {
      await salva(leadId, { status: 'FALTAM_DADOS', faltaNoteAt: new Date().toISOString() });
      const guardou = await guardaFormulario(accountId, cf, 'WEB CASAS - CADASTRO PARA COMPLETAR.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx);
      await note(leadId, `🏦 Santander: tudo pronto pra pedir a vistoria, mas o cadastro WEB CASAS ficou sem dado essencial: ${essenciais.join('; ')}.${guardou ? ' Guardei o Word preenchido na pasta FORMULARIOS do Drive ("WEB CASAS - CADASTRO PARA COMPLETAR"): complete e envie à Letícia com os documentos, ou me diga o que preencher.' : ' Complete o cadastro e envie à Letícia com os documentos, ou me diga o que preencher.'}`);
      push(accountId, '🏦 Vistoria Santander: cadastro incompleto', `${lead.name}: ${essenciais.join('; ').slice(0, 110)}`, leadId);
    }
    return false;
  }

  // anexos: PDF assinado + Word + documentos da pasta
  const att = await prisma.messageAttachment.findFirst({ where: { leadId, fileName: st.signedName || undefined, mimeType: 'application/pdf', message: { direction: 'INBOUND' } }, orderBy: { createdAt: 'desc' }, select: { data: true, driveFileId: true, mimeType: true, fileName: true } });
  const assinado = att ? await bytesDoAnexo(accountId, att) : null;
  if (!assinado) { await salva(leadId, { status: 'ERRO', erro: 'não consegui abrir o PDF assinado' }); await note(leadId, '⚠️ Santander: não consegui abrir o PDF assinado do cliente pra anexar. Envie o pedido à mão.'); return false; }
  const { downloadDriveFile } = await import('./google.service');
  const anexos: { filename: string; contentType: string; content: Buffer }[] = [
    { filename: 'Cadastro de Informações - WEB CASAS.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: docx },
    { filename: st.signedName || 'Autorizacao USECASA assinada.pdf', contentType: 'application/pdf', content: assinado },
  ];
  const lista: string[] = ['cadastro WEB CASAS preenchido', 'autorização USECASA assinada pelo cliente (gov.br)'];
  for (const [k, arr] of [['cnd', cat.cnd.slice(0, 1)], ['capa', cat.capa], ['onus', cat.onus], ['ident', cat.ident], ['civil', cat.civil]] as const) {
    for (const f of arr) anexos.push({ filename: f.name, contentType: f.mimeType, content: await downloadDriveFile(accountId, f.id, f.mimeType) });
    lista.push({ cnd: 'CND de IPTU', capa: 'capa do IPTU', onus: 'certidão de ônus/matrícula do imóvel', ident: 'documento de identidade', civil: 'certidão de estado civil' }[k]);
  }
  await guardaFormulario(accountId, cf, 'WEB CASAS - CADASTRO PREENCHIDO.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx);
  const prop = await prisma.creditAnalysis.findFirst({ where: { leadId, bank: 'CREDIMORAR', dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] }, proposalNumber: { not: null } }, orderBy: { createdAt: 'desc' }, select: { proposalNumber: true } });
  const nomeCliente = p1.nome.replace(/\s+/g, ' ').trim();
  const corpo = [
    'Olá, Letícia, tudo bem?', '',
    `Segue a solicitação de vistoria do imóvel do cliente ${nomeCliente}${prop?.proposalNumber ? ` (proposta Santander nº ${prop.proposalNumber})` : ''}.`, '',
    'Em anexo:', ...lista.map((l) => `• ${l}`), '',
    `Contato para a vistoria: ${contatoPessoa}${telefone ? ` — ${telefone}` : ''}`, '',
    'Qualquer dúvida, estou à disposição.', 'Obrigado!',
  ].join('\n');
  const dono = await prisma.user.findFirst({ where: { accountId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  const acc = await prisma.emailAccount.findFirst({ where: { accountId, userId: null }, orderBy: { createdAt: 'asc' } });
  if (!dono || !acc) { await note(leadId, '⚠️ Santander: a caixa de e-mail comercial não está configurada; não consegui enviar o pedido de vistoria.'); return false; }
  try {
    const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
    await sendEmailFrom({ acc, userId: dono.id, to: [VISTORIA_SANTANDER_TO], cc: [], subject: `Solicitação de vistoria - ${nomeCliente.toUpperCase()}${prop?.proposalNumber ? ` - proposta ${prop.proposalNumber}` : ''}`, body: corpo, replyToId: null, leadId, io: (io || ({ to: () => ({ emit: () => {} }) })) as any, attachments: anexos });
  } catch (e: any) {
    await salva(leadId, { status: 'ERRO', erro: String(e?.message || e).slice(0, 200) });
    await note(leadId, `⚠️ Santander: tentei enviar o pedido de vistoria à Letícia e não consegui: ${e?.message || e}. Envie à mão.`);
    push(accountId, '⚠️ Vistoria Santander não saiu', lead.name, leadId);
    return false;
  }
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, pipelineId: true, stageId: true, stage: { select: { name: true } } } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _vistoriaRequestedAt: new Date().toISOString() } } });
  await salva(leadId, { status: 'ENVIADA', sentAt: new Date().toISOString(), to: VISTORIA_SANTANDER_TO });
  await note(leadId, `📨 Vistoria solicitada ao Santander: e-mail para ${VISTORIA_SANTANDER_TO} com ${anexos.length} anexo(s): ${anexos.map((a) => a.filename).join('; ')}.${dados.faltando.length ? `\nFicaram em branco no cadastro: ${dados.faltando.join('; ')}.` : ''}`);
  push(accountId, '📨 Vistoria solicitada ao Santander', lead.name, leadId);
  try {
    const vist = await prisma.stage.findFirst({ where: { pipelineId: fresh!.pipelineId, name: { contains: 'Vistoria', mode: 'insensitive' } }, select: { id: true, name: true } });
    if (vist && vist.id !== fresh!.stageId) {
      const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
      await updateLeadStage(leadId, accountId, vist.id);
      await prisma.note.create({ data: { leadId, type: 'STAGE_CHANGE', content: `Estágio: "${fresh!.stage?.name || '—'}" → "${vist.name}" — vistoria solicitada ao Santander` } }).catch(() => {});
    }
  } catch (e: any) { console.warn('[Vistoria Santander] não consegui mover o card:', e?.message); }
  return true;
}
