import { prisma } from '../lib/prisma';
import { cleanSubject } from './inter-email.service';

/**
 * Botão "Solicitar vistoria" do card (Fabio 19/10). A vistoria do Inter segue pelo e-mail: depois do "[Inter] Engajamento Automático" o consultor designado responde e pede/agenda
 * a vistoria (engenheiro em até 2 dias úteis, laudo em até 6). Este serviço monta o e-mail (revisável na tela) e responde NA MESMA CONVERSA do Inter, pela caixa comercial,
 * com os dados do cliente e a certidão de ônus da pasta do Drive em anexo. Nada sai sem alguém clicar em "Enviar ao Inter".
 * Matrícula errada ou imóvel em outro nome NÃO travam (regra do Fabio, 19/10) — só viram aviso na tela.
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

const INTER_FROM = /@([a-z0-9-]+\.)*(inter\.co|bancointer\.com\.br)$/i;
const NO_REPLY = /^(no-?reply|nao-?responda|do-?not-?reply)/i;

const firstName = (full: string | null | undefined) => {
  const w = String(full || '').trim().split(/\s+/)[0] || '';
  return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '';
};
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase()).replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase());

export interface VistoriaPreview {
  to: string;
  cc: string;
  subject: string;
  body: string;
  replyToId: string | null;
  attachment: { name: string; certidaoId: string } | null;
  anexos: { id: string; name: string; path: string; size: number; checked: boolean }[];
  engajamentoRecebido: boolean;
  consultor: string | null;
  jaSolicitadaEm: string | null;
  avisos: string[];
}


/** Arquivos do imóvel na pasta do cliente no Drive (subpasta IMOVEL): PDF ou imagem de até 8 MB. */
async function arquivosDoImovel(accountId: string, cf: Record<string, any>): Promise<{ id: string; name: string; path: string; size: number; mimeType: string }[]> {
  const link = String(cf.link_pasta_drive || '').trim();
  if (!link) return [];
  try {
    const { extractFolderId, listAllFilesInFolderTree } = await import('./google.service');
    const files = await listAllFilesInFolderTree(accountId, extractFolderId(link), 3);
    return files.filter((f) => /^IMOVEL/i.test(f.path) && /^(application\/pdf|image\/)/.test(f.mimeType) && (f.size || 0) <= 8 * 1024 * 1024);
  } catch { return []; }
}

export async function vistoriaPreview(accountId: string, leadId: string): Promise<VistoriaPreview> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true, contact: { select: { phone: true, email: true } } } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  const nome = titleCase(String(cf.participante_1 || lead.name || '').trim()) || 'Cliente';
  const proposta = String(cf.num_proposta || '').trim();

  // e-mails do Inter já ligados a este card (o vigia liga pelo nº da proposta/nome)
  const emails = await prisma.emailMessage.findMany({
    where: { leadId, folder: 'INBOX', OR: [{ fromAddress: { endsWith: 'inter.co', mode: 'insensitive' } }, { fromAddress: { endsWith: 'bancointer.com.br', mode: 'insensitive' } }] },
    orderBy: { date: 'desc' }, take: 12, select: { id: true, fromAddress: true, fromName: true, subject: true, textBody: true, date: true },
  });
  // o engajamento pode vir no assunto ou só citado no texto de quem respondeu (ex.: assunto "Home Equity - PEDRO" com "[Inter] Engajamento Automático" embaixo)
  const engaj = emails.find((e) => /engajamento/i.test(e.subject || '') || /Engajamento Autom[aá]tico|PR[OÓ]XIMO PASSO:\s*VISTORIA/i.test(e.textBody || ''));
  const pessoa = emails.find((e) => e.fromAddress && INTER_FROM.test(e.fromAddress) && !NO_REPLY.test(e.fromAddress));
  // consultor: quem já respondeu na conversa; senão o e-mail citado no corpo do engajamento ("entre em contato através do email …")
  const doCorpo = engaj?.textBody ? (/[\w.+-]+@inter\.co/i.exec(engaj.textBody) || [])[0]?.toLowerCase() : undefined;
  const to = pessoa?.fromAddress?.toLowerCase() || doCorpo || '';
  const consultor = pessoa?.fromName ? firstName(pessoa.fromName) : null;
  const pai = pessoa || engaj || emails[0] || null;

  const cert = await prisma.certidaoRequest.findFirst({ where: { accountId, leadId, status: 'ISSUED', driveFileId: { not: null } }, orderBy: { finishedAt: 'desc' }, select: { id: true, matricula: true, pdfName: true } });
  const matricula = cert?.matricula || String(cf.numero_matricula || '').trim();
  const cartorio = String(cf.cartorio_registro || '').trim();
  const tel = String(cf.telefone_1 || lead.contact?.phone || '').trim();
  const mail = String(cf.email_1 || lead.contact?.email || '').trim();
  const endImovel = String(cf.endereco_imovel || cf.imovel_endereco || '').trim();

  const doImovel = await arquivosDoImovel(accountId, cf);
  const idCert = cert ? (await prisma.certidaoRequest.findUnique({ where: { id: cert.id }, select: { driveFileId: true } }))?.driveFileId : null;
  // Marcados por padrão: a certidão de ônus da matrícula atual e o cadastro imobiliário (IPTU) do imóvel. NÃO marca "GUIA IPTU" etc.: já veio guia de OUTRO imóvel (Pedro, 19/10) — só vai se alguém conferir e marcar.
  const anexos = doImovel.map((f) => ({ id: f.id, name: f.name, path: f.path, size: f.size, checked: f.id === idCert || (/CADASTRO IMOBILIARIO/i.test(f.name) && !/ 2\.pdf$/i.test(f.name)) }));
  const temMat = anexos.some((a) => a.checked && a.id === idCert);
  const temCad = anexos.some((a) => a.checked && /CADASTRO IMOBILIARIO/i.test(a.name));
  const listaAnexos = [temMat ? 'a matrícula atualizada do imóvel (certidão de ônus)' : '', temCad ? 'o cadastro imobiliário do imóvel (IPTU)' : ''].filter(Boolean);
  const linhas = [
    `Olá${consultor ? `, ${consultor}` : ''}, tudo bem?`,
    '',
    `Seguem os dados para o agendamento da vistoria do imóvel do cliente ${nome}${proposta ? ` (proposta ${proposta})` : ''}.`,
    '',
    'CONTATO',
    `• Responsável para receber o engenheiro: ${nome}`,
    `• Telefone para agendamento: ${tel || '(informar)'}`,
    ...(mail ? [`• E-mail: ${mail}`] : []),
    '',
    `IMÓVEL: ${matricula ? `matrícula nº ${matricula}` : 'conforme a matrícula'}${cartorio ? ` — ${cartorio}` : ''}${endImovel ? `\nEndereço: ${endImovel}` : ''}`,
    ...(listaAnexos.length ? [`Seguem em anexo ${listaAnexos.join(' e ')}.`] : []),
    ...(temCad ? ['A guia do IPTU atual enviamos assim que o cliente nos mandar.'] : []),
    '',
    'Qualquer dúvida, estou à disposição.',
    'Obrigado!',
  ];

  const avisos: string[] = [];
  if (!engaj) avisos.push('O e-mail de engajamento do Inter ainda não chegou para este cliente. Se você enviar agora, será um e-mail novo, e não uma resposta na conversa do Inter.');
  if (!to) avisos.push('Não achei o e-mail do consultor do Inter. Preencha o campo "Para".');
  if (!anexos.some((a) => a.checked)) avisos.push('Nenhum documento do imóvel foi marcado para anexar. O Inter pede sempre com anexo: marque a matrícula e o IPTU.');
  if (!tel) avisos.push('O card não tem telefone do cliente para o engenheiro.');
  avisos.push('O Inter também pede, pelo PORTAL (aba Documentos da proposta), a matrícula do imóvel e a guia do IPTU atual. Este botão só responde o e-mail; o upload no portal é separado.');

  const sentAt = cf._vistoriaRequestedAt ? String(cf._vistoriaRequestedAt) : null;
  return {
    to, cc: '',
    subject: pai?.subject ? `Re: ${cleanSubject(pai.subject)}` : `Vistoria${proposta ? ` - proposta ${proposta}` : ''} - ${nome.toUpperCase()}`,
    body: linhas.join('\n'),
    replyToId: pai?.id || null,
    attachment: cert ? { name: `CERTIDAO DE ONUS - MATRICULA ${cert.matricula}.pdf`, certidaoId: cert.id } : null,
    anexos,
    engajamentoRecebido: !!engaj, consultor, jaSolicitadaEm: sentAt, avisos,
  };
}

export async function solicitarVistoria(p: { accountId: string; userId: string; leadId: string; to: string; cc?: string; subject: string; body: string; replyToId?: string | null; attachDriveFileIds?: string[]; io?: Io }) {
  const lead = await prisma.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { name: true, customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const to = String(p.to || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('Informe o e-mail do consultor do Inter no campo "Para".');
  if (!INTER_FROM.test(to) && !String(process.env.VISTORIA_ALLOW_ANY_RECIPIENT || '')) throw new Error('O destinatário precisa ser um e-mail do Inter (@inter.co).');

  const acc = await prisma.emailAccount.findFirst({ where: { accountId: p.accountId, userId: null }, orderBy: { createdAt: 'asc' } });
  if (!acc) throw new Error('A caixa de e-mail comercial não está configurada.');

  const attachments: { filename: string; contentType: string; content: Buffer }[] = [];
  const ids = Array.from(new Set(p.attachDriveFileIds || []));
  if (!ids.length) throw new Error('O pedido de vistoria vai sempre com anexo: marque ao menos a matrícula do imóvel.');
  const lead2 = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { customFields: true } });
  const permitidos = await arquivosDoImovel(p.accountId, (lead2?.customFields || {}) as Record<string, any>); // só arquivos da pasta IMOVEL deste cliente
  const { downloadDriveFile } = await import('./google.service');
  for (const id of ids) {
    const f = permitidos.find((x) => x.id === id);
    if (!f) throw new Error('Um dos anexos não está na pasta IMOVEL do cliente.');
    attachments.push({ filename: f.name, contentType: f.mimeType, content: await downloadDriveFile(p.accountId, f.id, f.mimeType) });
  }
  const cc = String(p.cc || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

  const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
  await sendEmailFrom({ acc, userId: p.userId, to: [to], cc, subject: p.subject, body: p.body, replyToId: p.replyToId || null, leadId: p.leadId, io: (p.io || ({ to: () => ({ emit: () => {} }) })) as any, attachments });

  const fresh = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: p.leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _vistoriaRequestedAt: new Date().toISOString() } } });
  await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', userId: p.userId, content: `📨 Vistoria solicitada ao Inter (e-mail para ${to}${attachments.length ? `, com ${attachments.length} anexo(s): ${attachments.map((a) => a.filename).join('; ')}` : ''}). Aguardando o engenheiro entrar em contato (até 2 dias úteis).` } }).catch(() => {});
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(p.accountId, { title: '📨 Vistoria solicitada ao Inter', body: lead.name, leadId: p.leadId }).catch(() => {}); } catch { /* aviso */ }
  return { ok: true, to, anexou: attachments.length > 0 };
}
