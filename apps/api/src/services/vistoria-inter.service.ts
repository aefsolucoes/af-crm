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
  const contatoCard = String(cf.contato_vistoria || '').trim(); // campo "Contato vistoria" do card: manda mais que o telefone do cliente
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
    ...(contatoCard
      ? [`• Responsável para receber o engenheiro / telefone para agendamento: ${contatoCard}`]
      : [`• Responsável para receber o engenheiro: ${nome}`, `• Telefone para agendamento: ${tel || '(informar)'}`]),
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


// ─── Laudo digital do Inter (apartamento): a extensão "Vistoria Inter" preenche o formulário avaliacaoimovel.bancointer.com.br/<proposta> ───────────────────────────
// Fabio 20/10 (caso Pedro): a IA junta os dados do imóvel no card, a extensão preenche as 6 etapas e PARA na tela "Confira os dados preenchidos" — quem marca "me responsabilizo" e envia é a equipe.
// Respostas FIXAS decididas pelo Fabio ("sempre"): condição do imóvel = "Não apresenta nenhuma dessas condições"; conservação do apto = Bom; padrão de acabamento = Normal; conservação do condomínio = Bom.

export type LaudoJob = {
  leadId: string; leadName: string; proposta: string; link: string; cep: string; numero: string; complemento: string;
  area: number; quartos: number; banheiros: number; suites: number; vagas: number; ano: string;
  fixos: { condicao: string; conservacao: string; padrao: string; condominio: string };
};

const LAUDO_FIXOS = { condicao: 'Não apresenta nenhuma dessas condições', conservacao: 'BOM', padrao: 'NORMAL', condominio: 'BOM' };
const inteiro = (v: unknown): number => { const m = String(v ?? '').match(/\d+/); return m ? parseInt(m[0], 10) : NaN; };

/** Monta o job do laudo a partir do card; devolve também o que falta. Pura nos dados (testável). */
export function buildLaudoJob(leadId: string, leadName: string, cf: Record<string, any>): { job: LaudoJob | null; faltando: string[] } {
  const faltando: string[] = [];
  const proposta = String(cf.num_proposta || '').trim();
  if (!proposta) faltando.push('número da proposta do Inter');
  if (!/inter/i.test(String(cf.instituicao || '')) && !proposta) faltando.push('proposta do Inter');
  if (!/apart/i.test(String(cf.imovel_tipo || ''))) faltando.push('tipo do imóvel = Apartamento (casa tem visita de engenheiro, não laudo digital)');
  const link = String(cf.link_laudo_inter || '').trim();
  if (!/^https:\/\/[^\s]*bancointer\.com\.br\//i.test(link)) faltando.push('link do laudo digital (vem no e-mail do Inter/BPO — campo "Link do laudo Inter")');
  const cep = String(cf.imovel_cep || '').replace(/\D/g, '');
  if (cep.length !== 8) faltando.push('CEP do imóvel');
  const numero = String(cf.imovel_numero || '').trim();
  if (!numero) faltando.push('número do imóvel');
  const areaNum = parseFloat(String(cf.imovel_area_util || '').replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(areaNum) || areaNum <= 0) faltando.push('área útil (m²)');
  const ano = String(cf.imovel_ano_construcao || '').match(/\d{4}/)?.[0] || '';
  if (!ano) faltando.push('ano de construção');
  const q = inteiro(cf.imovel_dormitorios), b = inteiro(cf.imovel_banheiros), su = inteiro(cf.imovel_suites);
  if (!Number.isFinite(q)) faltando.push('dormitórios');
  if (!Number.isFinite(b)) faltando.push('banheiros');
  if (!Number.isFinite(su)) faltando.push('suítes');
  const vTxt = String(cf.imovel_vagas_exclusivas ?? '').trim();
  const v = /^(nenhum|n[aã]o|sem)/i.test(vTxt) ? 0 : inteiro(vTxt);
  if (!vTxt) faltando.push('vagas de garagem');
  if (faltando.length) return { job: null, faltando };
  return {
    faltando: [],
    job: { leadId, leadName, proposta, link, cep, numero, complemento: String(cf.imovel_complemento || '').trim(), area: Math.round(areaNum), quartos: q, banheiros: b, suites: su, vagas: Number.isFinite(v) ? v : 0, ano, fixos: LAUDO_FIXOS },
  };
}

const laudoLink = (cf: Record<string, any>) => String(cf.link_laudo_inter || '').trim();

export async function laudoPreview(accountId: string, leadId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  const r = buildLaudoJob(leadId, lead.name, cf);
  return { ...r, status: String(cf._laudoStatus || ''), requestedAt: cf._laudoRequestedAt || null, filledAt: cf._laudoFilledAt || null, link: laudoLink(cf) || null };
}

export async function requestLaudo(accountId: string, leadId: string, userId: string) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  const { job, faltando } = buildLaudoJob(leadId, lead.name, cf);
  if (!job) throw new Error(`Faltam dados no card: ${faltando.join(', ')}.`);
  if (cf._laudoStatus === 'REQUESTED' || cf._laudoStatus === 'RUNNING') throw new Error('O laudo já está na fila da extensão.');
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf, _laudoStatus: 'REQUESTED', _laudoRequestedAt: new Date().toISOString(), _laudoFilledAt: null } } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', userId, content: '📝 Laudo digital do Inter na fila: a extensão "Vistoria Inter" vai preencher o formulário e parar na tela de conferência (quem envia é a equipe).' } }).catch(() => {});
  return { ok: true };
}

const horaBrasilia = () => new Date(Date.now() - 3 * 3600_000).getUTCHours();

/** A extensão pergunta "tem laudo pra preencher?" (a cada minuto, 07h–22h). Um por vez; RUNNING há mais de 20 min é dado como falha. */
export async function claimLaudo(accountId: string): Promise<LaudoJob | null> {
  const h = horaBrasilia();
  if (h < 7 || h >= 22) return null;
  const rows = await prisma.$queryRaw<{ id: string; name: string; customFields: any }[]>`SELECT id, name, "customFields" FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false AND "customFields"->>'_laudoStatus' IN ('REQUESTED', 'RUNNING') ORDER BY ("customFields"->>'_laudoRequestedAt') ASC LIMIT 5`;
  for (const r of rows) {
    const cf = (r.customFields || {}) as Record<string, any>;
    if (cf._laudoStatus === 'RUNNING') {
      if (Date.now() - new Date(String(cf._laudoClaimedAt || 0)).getTime() > 20 * 60_000) {
        await prisma.lead.update({ where: { id: r.id }, data: { customFields: { ...cf, _laudoStatus: 'FAILED' } } });
        await prisma.note.create({ data: { leadId: r.id, type: 'COMMENT', content: '⚠️ O preenchimento do laudo do Inter não terminou em 20 min (a janela da extensão fechou ou travou). Peça de novo no botão do card.' } }).catch(() => {});
      }
      continue;
    }
    const { job } = buildLaudoJob(r.id, r.name, cf);
    if (!job) { await prisma.lead.update({ where: { id: r.id }, data: { customFields: { ...cf, _laudoStatus: 'FAILED' } } }); continue; }
    await prisma.lead.update({ where: { id: r.id }, data: { customFields: { ...cf, _laudoStatus: 'RUNNING', _laudoClaimedAt: new Date().toISOString() } } });
    return job;
  }
  return null;
}

export async function reportLaudo(accountId: string, leadId: string, d: { event: string; detail?: string; reason?: string }) {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  const push = (title: string, body: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };
  if (d.event === 'filled') {
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf, _laudoStatus: 'FILLED', _laudoFilledAt: new Date().toISOString() } } });
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📝 Laudo digital do Inter PREENCHIDO pela extensão — falta a equipe conferir e ENVIAR (marcar "me responsabilizo" e clicar em enviar): ${laudoLink(cf)}${d.detail ? `\n${String(d.detail).slice(0, 500)}` : ''}` } }).catch(() => {});
    push('📝 Laudo do Inter preenchido', `${lead.name}: falta conferir e enviar`);
  } else if (d.event === 'failed') {
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf, _laudoStatus: 'FAILED' } } });
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ A extensão NÃO conseguiu preencher o laudo digital do Inter: ${String(d.reason || 'erro').slice(0, 400)}. Link: ${laudoLink(cf)}` } }).catch(() => {});
    push('⚠️ Laudo do Inter não foi preenchido', `${lead.name}: ${String(d.reason || '').slice(0, 90)}`);
  } else if (d.event === 'step') {
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf, _laudoClaimedAt: new Date().toISOString() } } }); // sinal de vida (evita o "RUNNING há 20 min")
  }
  return { ok: true };
}
