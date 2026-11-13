import { prisma } from '../lib/prisma';
import { sendOutboundMedia } from './message.service';
import { MARCAS_PROPOSTA_SITE, camposDaProposta, dadosWebCasas, inspecionarRetornoUsecasa, participantesDe, preencherAutorizacaoUsecasa, preencherWebCasas } from './santander-forms';

type Io = Parameters<typeof sendOutboundMedia>[0]['io'];

/**
 * VISTORIA DO SANTANDER (Fabio 21/10, caso Edson do Carmo: "por e-mail, tem dois anexos que o CRM precisa preencher e encaminhar"). Fluxo, a partir de documentação completa + cliente seguindo pelo Santander (vigia da vistoria):
 *  1) o CRM preenche a "Autorização do(s) Cliente(s) para USECASA" (PDF) e manda ao cliente pelo WhatsApp pra ele ASSINAR PELO GOV.BR e devolver;
 *  2) quando o PDF assinado volta (reconhece pela palavra-chave gravada no arquivo + assinatura digital), junta os documentos da pasta do Drive: do IMÓVEL a CND de IPTU, a capa do IPTU e a certidão de
 *     ônus/matrícula; do CLIENTE o documento de identidade e a certidão de estado civil. A CND de IPTU a A&F emite: sem ela na pasta, a equipe recebe nota + push pra emitir e subir.
 *     Documento faltando NÃO segura o pedido (Fabio 06/11): ele sai com o que tem e o e-mail/nota dizem o que vai depois;
 *  3) preenche o "Cadastro de Informações - WEB CASAS" (Word) com o que se sabe (proposta do site + card) e manda TUDO por e-mail pra Letícia (pela caixa comercial). Se faltar dado essencial do cadastro,
 *     NÃO envia: avisa a equipe com a lista e guarda o Word preenchido na pasta IMOVEL do Drive pra completar à mão;
 *  4) enviado: card vai pra "Vistoria do Imóvel". Estado em customFields._vistoriaSant.
 */

export const VISTORIA_SANTANDER_TO = process.env.VISTORIA_SANTANDER_TO || 'leticia.gomes@credimorar.com.vc';
const AVISO_REPETIR_MS = 12 * 3600_000;

type St = { status?: string; askedAt?: string; signedAt?: string; signedName?: string; cndNoteAt?: string; faltaNoteAt?: string; semAssinaturaNoteAt?: string; teamAskNoteAt?: string; sentAt?: string; to?: string; erro?: string; cndCheckAt?: string; prontaNoteAt?: string; startedByTeam?: boolean; pendentes?: string[]; semLocalNoteAt?: string; lembreteDe?: string; lembretes?: number; lembreteAt?: string; docsFaltaNoteAt?: string; docsFaltaSig?: string; enviadoPor?: string };

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };
/** Push ao colaborador responsável pelo card (Lead.userId); se ele não tem aparelho cadastrado, vai pra equipe toda. */
async function pushDono(accountId: string, leadId: string, title: string, body: string) {
  try {
    const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { userId: true } });
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    const tem = l?.userId ? await prisma.pushSubscription.count({ where: { userId: l.userId } }) : 0;
    sendPushToAccount(accountId, { title, body, leadId }, tem && l?.userId ? [l.userId] : undefined).catch(() => {});
  } catch { /* aviso */ }
}
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

/** CND de IPTU é a A&F que emite: sem ela na pasta, avisa (nota + push) o COLABORADOR do card pra solicitar/emitir (Fabio 29/10). Confere o Drive no máx. a cada 30 min e repete o aviso a cada 12 h. Devolve true se a CND está faltando. */
/** Envia o pedido à Letícia tentando as caixas na ordem (Fabio 13/11: "pode ser que um dos e-mails não esteja funcionando — o segundo seria Fabio e o terceiro Andreia"):
 *  comercial@ (caixa da empresa) → caixa pessoal do Fabio (1º admin) → caixa pessoal da Andreia. Falhou numa (ex.: Titan suspendeu a comercial@ — o envio dá erro na hora), tenta a
 *  próxima. Devolve o endereço que enviou e os erros das que falharam; sem nenhuma caixa que funcione, lança erro com todos os motivos. */
export async function enviarComReserva(accountId: string, params: Omit<Parameters<typeof import('./email-inbox.service').sendEmailFrom>[0], 'acc' | 'userId'>): Promise<{ de: string; falhas: string[] }> {
  const dono = await prisma.user.findFirst({ where: { accountId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  const andreia = await prisma.user.findFirst({ where: { accountId, name: { contains: 'Andreia', mode: 'insensitive' } }, select: { id: true } });
  const contas = await prisma.emailAccount.findMany({ where: { accountId }, orderBy: { createdAt: 'asc' } });
  const ordem = [
    contas.find((c) => !c.userId),
    dono ? contas.find((c) => c.userId === dono.id) : undefined,
    andreia ? contas.find((c) => c.userId === andreia.id) : undefined,
  ].filter((c, i, arr): c is NonNullable<typeof c> => !!c && arr.findIndex((x) => x?.id === c.id) === i);
  if (!ordem.length) throw new Error('nenhuma caixa de e-mail configurada no CRM');
  const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
  const falhas: string[] = [];
  for (const acc of ordem) {
    try {
      await sendEmailFrom({ ...params, acc, userId: acc.userId || dono?.id || null });
      return { de: acc.address, falhas };
    } catch (e: any) { falhas.push(`${acc.address}: ${String(e?.message || e).slice(0, 120)}`); }
  }
  throw new Error(`nenhuma caixa conseguiu enviar — ${falhas.join(' | ')}`);
}

export async function avisaCndSeFalta(accountId: string, leadId: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  if (!lead) return false;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const st = (cf._vistoriaSant || {}) as St;
  if (!opts.force && faz(st.cndCheckAt) < 30 * 60_000) return false;
  await salva(leadId, { cndCheckAt: new Date().toISOString() });
  const cat = categoriasDoDrive(await arquivosDoDrive(accountId, cf));
  if (cat.cnd.length || cat.capa.length) return false; // CND OU capa do IPTU — uma ou outra basta (Fabio 13/11)
  // `force` (clique no card) só confere o Drive na hora: a nota repete no máx. a cada 12 h (Fabio 06/11, Alexandre: cada clique gerava a mesma nota de novo).
  if (faz(st.cndNoteAt) > AVISO_REPETIR_MS) {
    await salva(leadId, { cndNoteAt: new Date().toISOString() });
    const insc = String((cf._docReview && Object.values(cf._docReview as Record<string, any>).map((r: any) => r?.inscricao).find(Boolean)) || '').trim();
    await note(leadId, `🏦 Santander: falta a CND de IPTU na pasta do Drive. É a A&F que emite: solicitar/emitir no site da prefeitura do município do imóvel (certidão negativa de débitos imobiliários/IPTU)${insc ? `, inscrição ${insc}` : ''}, e subir na subpasta IMOVEL do Drive com o nome "CND IPTU" — ou pelo botão "Emitir certidões" do card (aba Financiamento): a extensão "Certidões" emite e guarda sozinha (DF pronto; outro município vira link pra emitir à mão). O pedido de vistoria à Letícia não espera por ela: sai com o que tiver e a CND vai depois.`);
    await pushDono(accountId, leadId, '🏦 Falta a CND de IPTU (Santander)', `${lead.name}: solicitar/emitir a CND de IPTU e subir na pasta do Drive`);
  }
  return true;
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
export async function processVistoriaSantander(accountId: string, leadId: string, io: Io, opts: { manual?: boolean; holdSend?: boolean } = {}): Promise<boolean> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true, contact: { select: { phone: true } } } });
  if (!lead) return false;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused) return false;
  const st = (cf._vistoriaSant || {}) as St;
  if (st.status === 'ENVIADA') return true;
  if (opts.manual && !st.startedByTeam) { await salva(leadId, { startedByTeam: true }); st.startedByTeam = true; }

  const propMsg = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', OR: MARCAS_PROPOSTA_SITE.map((m) => ({ content: { contains: m } })) }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  const campos = camposDaProposta(propMsg?.content || '');
  const { p1, p2 } = participantesDe(cf, campos, lead.name);
  const primeiroNome = (p1.nome.split(/\s+/)[0] || '').toLowerCase().replace(/^./, (c) => c.toUpperCase());

  // 1) mandar a autorização pro cliente assinar
  if (!st.askedAt) {
    if (!lead.aiAutoReplyActive && !opts.manual) {
      if (!st.teamAskNoteAt) { await salva(leadId, { teamAskNoteAt: new Date().toISOString() }); await note(leadId, '🏦 Santander: documentação completa. Falta mandar ao cliente a autorização USECASA pra assinar pelo gov.br (IA do card desligada: o CRM não mandou sozinho).'); push(accountId, '🏦 Vistoria Santander', `${lead.name}: mandar a autorização USECASA pra assinar`, leadId); }
      return false;
    }
    const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
    if (!inNoticeWindow() && !opts.manual) return false;
    if (!(await whatsappWindowOpen(leadId))) {
      if (opts.manual || !st.teamAskNoteAt) { await salva(leadId, { teamAskNoteAt: new Date().toISOString() }); await note(leadId, '🏦 Santander: documentação completa, mas a janela de 24 h do WhatsApp está fechada. A autorização USECASA sai assim que o cliente responder qualquer mensagem.'); push(accountId, '🏦 Vistoria Santander', `${lead.name}: janela fechada, aguardando o cliente falar`, leadId); }
      return false;
    }
    // "Local e Data" sempre com a cidade (Fabio 11/11) e a UF (12/11: "Brasília/DF"): proposta do site → residência dos documentos → cidade/endereço do imóvel no card → CEP. Sem cidade em lugar nenhum, o formulário não sai sem o local; sem UF, sai só a cidade.
    const { localDaAssinatura, textoDoLocal } = require('./endereco-imovel.service') as typeof import('./endereco-imovel.service');
    const cidade = textoDoLocal(await localDaAssinatura(leadId, cf, [campos['Cidade/UF residência'], campos['Cidade/UF'], campos['Imóvel em garantia']])); // "Cidade/UF" = a residência na proposta que chega pelo WhatsApp
    if (!cidade) {
      if (opts.manual || !st.semLocalNoteAt) { await salva(leadId, { semLocalNoteAt: new Date().toISOString() }); await note(leadId, '🏦 Santander: não achei a cidade pro campo "Local e data" da autorização USECASA, e sem o local o formulário não sai. Preencha "Cidade do imóvel" (ou o CEP do imóvel) no card — o CRM manda a autorização em seguida.'); push(accountId, '🏦 Vistoria Santander', `${lead.name}: falta a cidade pro "Local e data" da autorização`, leadId); }
      return false;
    }
    const pdf = await preencherAutorizacaoUsecasa({ p1, p2, cidade, leadId });
    const sent = await sendOutboundMedia({ accountId, leadId, buffer: pdf, fileName: 'Autorizacao USECASA - assinar pelo gov.br.pdf', mimeType: 'application/pdf', caption: textoPedidoAssinatura(primeiroNome, !!p2), io });
    if (!sent.success) return false;
    await salva(leadId, { status: 'ASSINATURA_PEDIDA', askedAt: new Date().toISOString() });
    const guardou = await guardaFormulario(accountId, cf, 'AUTORIZACAO USECASA - PARA ASSINAR.pdf', 'application/pdf', pdf);
    await note(leadId, `🏦 Santander: mandei ao cliente a autorização USECASA (já com nomes e CPFs) pra assinar pelo gov.br${guardou ? ' (cópia na pasta FORMULARIOS do Drive)' : ''}. Quando o PDF assinado voltar, o CRM junta os documentos e pede a vistoria por e-mail à Letícia.`);
    return false;
  }

  // CND de IPTU: já avisa o colaborador enquanto o cliente assina (a A&F leva dias pra emitir)
  await avisaCndSeFalta(accountId, leadId, { force: opts.manual }).catch(() => {});

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
    if (!depois?.signedAt) {
      // "Já assinou?" antes da conversa fechar, no horário de atendimento (Fabio 13/11).
      await (require('./assinatura-lembrete.service') as typeof import('./assinatura-lembrete.service')).lembrarAssinaturaGovBr({ accountId, leadId, leadName: lead.name, nome: primeiroNome, pedidoAt: st.askedAt!, oQue: 'a autorização', estado: { lembreteDe: depois?.lembreteDe, lembretes: depois?.lembretes }, salvar: (patch) => salva(leadId, patch), io }).catch((e: any) => console.warn('[Vistoria Santander] lembrete da assinatura:', e?.message));
      return false;
    }
    st.signedAt = depois.signedAt; st.signedName = depois.signedName;
  }

  // 3) documentos da pasta do Drive
  const files = await arquivosDoDrive(accountId, cf);
  const cat = categoriasDoDrive(files);
  // Matrícula divergente (o termo de quitação cita outra matrícula): a certidão antiga NÃO vale — só a da matrícula correta (do cliente ou emitida pelo ONR).
  const dv = cf._matriculaDivergente as { correta?: string } | undefined;
  if (dv?.correta) {
    const alvo = String(dv.correta).replace(/\D/g, '');
    const revs = (cf._docReview || {}) as Record<string, any>;
    const atts = await prisma.messageAttachment.findMany({ where: { leadId, driveFileId: { not: null } }, select: { id: true, driveFileId: true } });
    const idsOk = new Set<string>(atts.filter((a) => { const r = revs[a.id]; return r && /MATRICULA|ONUS/.test(String(r.tipo || '').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')) && String(r.matricula || '').replace(/\D/g, '') === alvo; }).map((a) => a.driveFileId!));
    const emitidas = await prisma.certidaoRequest.findMany({ where: { accountId, leadId, status: 'ISSUED', driveFileId: { not: null } }, select: { matricula: true, driveFileId: true } });
    for (const c of emitidas) if (String(c.matricula || '').replace(/\D/g, '') === alvo) idsOk.add(c.driveFileId!);
    cat.onus = files.filter((f) => idsOk.has(f.id) && OK_ARQ.test(f.mimeType)).slice(0, 2);
  }
  // Identidade/estado civil com leitura de PROBLEMA (foto ilegível, de outra pessoa) não vai pra Letícia (Fabio 13/11, Vicente: a CNH ilegível ia no pacote) — conta como faltando.
  {
    const revs = (cf._docReview || {}) as Record<string, any>;
    const atts = await prisma.messageAttachment.findMany({ where: { leadId, driveFileId: { not: null } }, select: { id: true, driveFileId: true } });
    const ruins = new Set(atts.filter((a) => revs[a.id]?.resultado === 'PROBLEMA').map((a) => a.driveFileId));
    cat.ident = cat.ident.filter((f) => !ruins.has(f.id));
    cat.civil = cat.civil.filter((f) => !ruins.has(f.id));
  }
  const faltam: string[] = [];
  // IPTU: a CND OU a capa — uma ou outra basta (Fabio 13/11). Sem nenhuma das duas, a CND pode ir depois (a A&F emite).
  if (!cat.cnd.length && !cat.capa.length) faltam.push('CND de IPTU ou capa do IPTU (a A&F emite a CND)');
  if (!cat.onus.length) faltam.push(dv?.correta ? `certidão de ônus da matrícula correta (nº ${dv.correta})` : 'certidão de ônus/matrícula');
  if (cat.ident.length < (p2 ? 2 : 1)) faltam.push(`documento de identidade${p2 ? ' (dos dois)' : ''}`);
  if (!cat.civil.length) faltam.push('certidão de estado civil');
  // Documento faltando NÃO trava mais o pedido (Fabio 06/11, Alexandre: "não travar, por falta de documento, o envio à Letícia"): sai com o que tem na pasta; o e-mail e a nota
  // dizem o que ficou pendente pra mandar depois. Antes: status AGUARDA_DOCS + nota repetida a cada clique até a pasta ficar completa.
  const pendente = faltam.length ? `\n⚠️ Ainda não está na pasta (mande à Letícia depois, por e-mail): ${faltam.join('; ')}.` : '';

  // Só a CND de IPTU pode ir depois (Fabio 13/11: "certidão de ônus do cliente é algo essencial; creio que o único que pode ser encaminhado depois seria a CND de IPTU"):
  // faltando qualquer outro documento, o pedido NÃO sai — nota + push pra equipe (o CRM não pede documento ao cliente sem a equipe). Revoga o "não travar" de 06/11 pra esses.
  const travam = faltam.filter((f) => !/^CND de IPTU/.test(f)); // só o IPTU (CND/capa) pode ir depois
  if (travam.length) {
    const sig = travam.join('|');
    if (st.status !== 'AGUARDA_DOCS' || st.docsFaltaSig !== sig || faz(st.docsFaltaNoteAt) > AVISO_REPETIR_MS) {
      await salva(leadId, { status: 'AGUARDA_DOCS', docsFaltaSig: sig, docsFaltaNoteAt: new Date().toISOString() });
      await note(leadId, `🏦 Santander: o pedido de vistoria NÃO saiu — falta na pasta do Drive: ${travam.join('; ')} (só a CND de IPTU pode ir depois). Suba na pasta (ou combine com o cliente) e o CRM envia sozinho.`);
      await pushDono(accountId, leadId, '🏦 Vistoria Santander parada: falta documento', `${lead.name}: ${travam.join('; ')}`.slice(0, 160));
    }
    return false;
  }

  // 4) cadastro WEB CASAS + e-mail
  const contatoPessoa = String(cf.contato_vistoria || '').trim() || p1.nome;
  const telefone = String(cf.telefone_1 || lead.contact?.phone || campos['Celular'] || '').trim();
  const dados = dadosWebCasas(cf, campos, lead.name, { pessoa: contatoPessoa, telefone });
  // Nº do documento em branco não segura quando o RG/CNH vai anexado no mesmo e-mail (Fabio 06/11, Alexandre: a proposta pelo WhatsApp não traz o número; a Letícia lê no documento).
  const identAnexada = cat.ident.length >= (p2 ? 2 : 1);
  const essenciais = dados.faltando.filter((f) => /sexo|estado civil|n[uú]mero do documento|endere[cç]o completo do im[oó]vel|tipo do im[oó]vel|telefone do comprador/i.test(f) && !(identAnexada && /n[uú]mero do documento/i.test(f)));
  const docx = await preencherWebCasas(dados.ops);
  if (essenciais.length) {
    if (st.status !== 'FALTAM_DADOS' || faz(st.faltaNoteAt) > AVISO_REPETIR_MS) {
      await salva(leadId, { status: 'FALTAM_DADOS', faltaNoteAt: new Date().toISOString() });
      const guardou = await guardaFormulario(accountId, cf, 'WEB CASAS - CADASTRO PARA COMPLETAR.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', docx);
      await note(leadId, `🏦 Santander: tudo pronto pra pedir a vistoria, mas o cadastro WEB CASAS ficou sem dado essencial: ${essenciais.join('; ')}.${guardou ? ' Guardei o Word preenchido na pasta FORMULARIOS do Drive ("WEB CASAS - CADASTRO PARA COMPLETAR"): complete e envie à Letícia com os documentos, ou me diga o que preencher.' : ' Complete o cadastro e envie à Letícia com os documentos, ou me diga o que preencher.'}`);
      push(accountId, '🏦 Vistoria Santander: cadastro incompleto', `${lead.name}: ${essenciais.join('; ').slice(0, 110)}`, leadId);
    }
    return false;
  }

  // Automação da contratação desligada: tudo pronto, mas quem envia à Letícia é a equipe (botão "Enviar à Letícia" no card).
  if (opts.holdSend && !opts.manual) {
    if (st.status !== 'PRONTA') {
      await salva(leadId, { status: 'PRONTA', prontaNoteAt: new Date().toISOString() });
      await note(leadId, `🏦 Santander: autorização assinada e cadastro WEB CASAS preenchido${faltam.length ? '' : ', documentos completos'}. Falta só enviar à Letícia: botão "Enviar à Letícia" em "Vistoria do imóvel (Santander)", na aba Financiamento do card.${faltam.length ? ` O pedido sai com o que já está na pasta.${pendente}` : ''}`);
      await pushDono(accountId, leadId, '🏦 Vistoria Santander pronta', `${lead.name}: clique em "Enviar à Letícia" no card${faltam.length ? ` (pendente: ${faltam.join('; ')})` : ''}`.slice(0, 160));
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
    if (!arr.length) continue; // pendente: entra na linha "Segue depois" do e-mail
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
    ...(faltam.length ? [`Segue depois, assim que tivermos: ${faltam.map((f) => f.replace(/\s*\(a A&F emite( a CND)?\)/, '').replace('CND de IPTU ou capa do IPTU', 'CND de IPTU')).join('; ')}.`, ''] : []),
    `Contato para a vistoria: ${contatoPessoa}${telefone ? ` — ${telefone}` : ''}`, '',
    'Qualquer dúvida, estou à disposição.', 'Obrigado!',
  ].join('\n');
  let enviadoDe = '';
  try {
    const env = await enviarComReserva(accountId, { to: [VISTORIA_SANTANDER_TO], cc: [], subject: `Solicitação de vistoria - ${nomeCliente.toUpperCase()}${prop?.proposalNumber ? ` - proposta ${prop.proposalNumber}` : ''}`, body: corpo, replyToId: null, leadId, io: (io || ({ to: () => ({ emit: () => {} }) })) as any, attachments: anexos });
    enviadoDe = env.de;
    if (env.falhas.length) await note(leadId, `⚠️ Santander: a caixa ${env.falhas.map((f) => f.split(':')[0]).join(' e ')} não conseguiu enviar (${env.falhas.join(' | ')}); o pedido saiu pela ${env.de}.`);
  } catch (e: any) {
    await salva(leadId, { status: 'ERRO', erro: String(e?.message || e).slice(0, 200) });
    await note(leadId, `⚠️ Santander: tentei enviar o pedido de vistoria à Letícia e não consegui: ${e?.message || e}. Envie à mão.`);
    push(accountId, '⚠️ Vistoria Santander não saiu', lead.name, leadId);
    return false;
  }
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, pipelineId: true, stageId: true, stage: { select: { name: true } } } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _vistoriaRequestedAt: new Date().toISOString() } } });
  await salva(leadId, { status: 'ENVIADA', sentAt: new Date().toISOString(), to: VISTORIA_SANTANDER_TO, pendentes: faltam });
  await note(leadId, `📨 Vistoria solicitada ao Santander: e-mail (de ${enviadoDe}) para ${VISTORIA_SANTANDER_TO} com ${anexos.length} anexo(s): ${anexos.map((a) => a.filename).join('; ')}.${dados.faltando.length ? `\nFicaram em branco no cadastro: ${dados.faltando.join('; ')}.` : ''}${pendente}`);
  if (faltam.length) await pushDono(accountId, leadId, '📨 Vistoria Santander pedida — falta documento', `${lead.name}: mandar à Letícia depois: ${faltam.join('; ')}`.slice(0, 160));
  else push(accountId, '📨 Vistoria solicitada ao Santander', lead.name, leadId);
  // Vistoria solicitada = "Vistoria do Imóvel" (mesmo caminho do Inter/Creditas/CAIXA: só pra frente e tira do funil de Vendas se precisar).
  await (require('./vistoria-inter.service') as typeof import('./vistoria-inter.service')).moverParaVistoria(accountId, leadId, 'vistoria solicitada ao Santander', io as any);
  return true;
}

// ── Card: "Vistoria do imóvel (Santander)" (Fabio 29/10: igual ao do Inter, dentro do card) ──

const STATUS_TXT: Record<string, string> = {
  ASSINATURA_PEDIDA: 'Autorização USECASA enviada ao cliente — aguardando ele assinar pelo gov.br e devolver',
  ASSINADA: 'Autorização assinada pelo cliente — conferindo os documentos da pasta',
  AGUARDA_DOCS: 'Autorização assinada — faltam documentos na pasta do Drive',
  FALTAM_DADOS: 'Documentos ok, mas o cadastro WEB CASAS ficou sem dado essencial (Word na pasta FORMULARIOS)',
  PRONTA: 'Tudo pronto — falta enviar o pedido à Letícia',
  ENVIADA: 'Pedido de vistoria enviado à Letícia',
  ERRO: 'Deu erro no envio (veja a nota do card)',
};

/** O que o card mostra: andamento, documentos da pasta (achou/faltou) e a CND de IPTU. `aplicavel` = o cliente tem aprovação do Santander (ou o fluxo já começou). */
export async function santanderPreview(accountId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  // Financiamento pelo Santander (Credimorar): fluxo próprio com 3 formulários (Fabio 30/10) — vistoria-santander-fh.service
  if (/habitacional/i.test(lead.pipeline?.department?.name || '')) {
    if (!/^santander$/i.test(String(cf._fhChosen?.bank || '')) && !cf._vistoriaSantFh) return { aplicavel: false as const };
    return (require('./vistoria-santander-fh.service') as typeof import('./vistoria-santander-fh.service')).santanderFhPreview(accountId, leadId);
  }
  const st = (cf._vistoriaSant || {}) as St;
  const aprov = await prisma.creditAnalysis.count({ where: { leadId, bank: 'CREDIMORAR', dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] } } });
  const aplicavel = aprov > 0 || !!cf._vistoriaSant;
  if (!aplicavel) return { aplicavel: false as const };
  const propMsg = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', OR: MARCAS_PROPOSTA_SITE.map((m) => ({ content: { contains: m } })) }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  const campos = camposDaProposta(propMsg?.content || '');
  const { p2 } = participantesDe(cf, campos, lead.name);
  const cat = categoriasDoDrive(await arquivosDoDrive(accountId, cf));
  const docs = [
    { key: 'cnd', label: 'CND de IPTU (a A&F emite)', ok: cat.cnd.length > 0 },
    { key: 'capa', label: 'Capa do IPTU', ok: cat.capa.length > 0 },
    { key: 'onus', label: 'Certidão de ônus/matrícula', ok: cat.onus.length > 0 },
    { key: 'ident', label: `Documento de identidade${p2 ? ' (dos dois)' : ''}`, ok: cat.ident.length >= (p2 ? 2 : 1) },
    { key: 'civil', label: 'Certidão de estado civil', ok: cat.civil.length > 0 },
  ];
  return {
    aplicavel: true as const,
    status: st.status || '',
    statusTexto: STATUS_TXT[st.status || ''] || '',
    askedAt: st.askedAt || null, signedAt: st.signedAt || null, sentAt: st.sentAt || null, to: st.to || VISTORIA_SANTANDER_TO,
    docs, temLinkPasta: !!String(cf.link_pasta_drive || '').trim(),
  };
}

/** Botão do card: avança o fluxo AGORA (manda a autorização ao cliente, confere assinatura/documentos e, se tudo estiver pronto, envia o e-mail à Letícia). Devolve o preview novo. */
export async function executarVistoriaSantander(accountId: string, leadId: string, io: Io) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead) throw new Error('Card não encontrado');
  if (/habitacional/i.test(lead.pipeline?.department?.name || '')) await (require('./vistoria-santander-fh.service') as typeof import('./vistoria-santander-fh.service')).processVistoriaSantanderFh(accountId, leadId, io, { manual: true });
  else await processVistoriaSantander(accountId, leadId, io, { manual: true });
  return santanderPreview(accountId, leadId);
}
