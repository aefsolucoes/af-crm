import { prisma } from '../lib/prisma';
import { cleanSubject } from './inter-email.service';

/**
 * Pagamento ao vendedor — Inter (Fabio 29/10, Alexandro): "sempre que o card for para a etapa de PAGAMENTO AO VENDEDOR, o CRM identifica qual e-mail do Inter
 * se refere a este processo e encaminha a CERTIDÃO DE ÔNUS PÓS-REGISTRO (a que está na pasta do Drive) para pagamento ao vendedor". Só processos do Inter;
 * o fluxo dos outros bancos vem depois.
 * Responde NA MESMA CONVERSA do consultor do Inter (e-mails ligados ao card), pela MESMA caixa que recebeu/conversa (nunca troca de remetente), com a certidão em anexo. Uma vez por card
 * (`_onusPosRegistroSentAt`); faltando o e-mail do Inter ou a certidão, não envia: nota + push dizendo o que falta.
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };
const INTER_FROM = /@([a-z0-9-]+\.)*(inter\.co|bancointer\.com\.br)$/i;
const NO_REPLY = /^(no-?reply|nao-?responda|do-?not-?reply|contato@relacionamento)/i;
const firstName = (full: string | null | undefined) => { const w = String(full || '').trim().split(/\s+/)[0] || ''; return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''; };
const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase()).replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase());

export const ETAPA_PAGAMENTO_VENDEDOR = /pagamento ao vendedor/i;
export const nomeOnusPosRegistro = (matricula: string | null | undefined) => `CERTIDAO DE ONUS POS REGISTRO${matricula ? ` - MATRICULA ${matricula}` : ''}.pdf`;

/** Renomeia no Drive a certidão de ônus (a última emitida pelo CRM; senão a de ônus/matrícula mais recente da pasta IMOVEL) pra "CERTIDAO DE ONUS POS REGISTRO" (Fabio 29/10). */
export async function renomearOnusPosRegistro(accountId: string, leadId: string): Promise<{ ok: boolean; de?: string; para?: string; motivo?: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!lead) return { ok: false, motivo: 'card não encontrado' };
  const cf = (lead.customFields || {}) as Record<string, any>;
  const { arquivosDoImovel } = require('./vistoria-inter.service') as typeof import('./vistoria-inter.service');
  const doImovel = await arquivosDoImovel(accountId, cf).catch(() => []);
  const cert = await prisma.certidaoRequest.findFirst({ where: { accountId, leadId, status: 'ISSUED', driveFileId: { not: null } }, orderBy: { finishedAt: 'desc' }, select: { driveFileId: true, matricula: true } });
  const arq = (cert && doImovel.find((f) => f.id === cert.driveFileId)) || [...doImovel].reverse().find((f) => /ONUS|MATRICULA/i.test(f.name)) || null;
  if (!arq) return { ok: false, motivo: 'não achei a certidão de ônus na pasta IMOVEL' };
  const para = nomeOnusPosRegistro(cert?.matricula || String(cf.numero_matricula || '').trim());
  if (arq.name === para) return { ok: true, de: arq.name, para };
  const { renameFile } = await import('./google.service');
  await renameFile(accountId, arq.id, para);
  return { ok: true, de: arq.name, para };
}

/** O processo segue pelo Inter? (banco do card, ou a aprovação escolhida/maior do Inter) */
async function processoDoInter(leadId: string, cf: Record<string, any>): Promise<boolean> {
  if (/inter/i.test(String(cf.instituicao || cf.banco || ''))) return true;
  if (/inter/i.test(String(cf._fhChosen ? JSON.stringify(cf._fhChosen) : ''))) return true;
  const escolhida = await prisma.creditAnalysis.findFirst({ where: { leadId, dryRun: false, chosen: true }, select: { bank: true } });
  return !!escolhida && /^INTER/.test(escolhida.bank);
}

const avisar = async (accountId: string, leadId: string, nome: string, texto: string) => {
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: texto } }).catch(() => {});
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: '🏦 Pagamento ao vendedor (Inter)', body: `${nome}: ${texto.replace(/^\S+\s*/, '').slice(0, 160)}`, leadId }).catch(() => {}); } catch { /* push é só aviso */ }
};

export async function enviarOnusPosRegistroInter(p: { accountId: string; leadId: string; userId?: string | null; io?: Io; manual?: boolean }): Promise<{ ok: boolean; motivo?: string; to?: string; anexo?: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { name: true, customFields: true } });
  if (!lead) return { ok: false, motivo: 'card não encontrado' };
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (!(await processoDoInter(p.leadId, cf))) return { ok: false, motivo: 'o processo não é do Inter (o fluxo dos outros bancos ainda não existe)' };
  if (cf._onusPosRegistroSentAt && !p.manual) return { ok: false, motivo: `já enviado em ${cf._onusPosRegistroSentAt}` };
  const nome = titleCase(String(cf.participante_1 || lead.name || '').trim()) || 'Cliente';

  // E-mail do Inter deste processo: os ligados ao card; vale o do consultor (pessoa), não o no-reply.
  const emails = await prisma.emailMessage.findMany({
    where: { leadId: p.leadId, OR: [{ fromAddress: { endsWith: 'inter.co', mode: 'insensitive' } }, { fromAddress: { endsWith: 'bancointer.com.br', mode: 'insensitive' } }] },
    orderBy: { date: 'desc' }, take: 20, select: { id: true, fromAddress: true, fromName: true, subject: true, date: true, emailAccountId: true },
  });
  const pessoa = emails.find((e) => e.fromAddress && INTER_FROM.test(e.fromAddress) && !NO_REPLY.test(e.fromAddress));
  if (!pessoa) {
    await avisar(p.accountId, p.leadId, lead.name, '⚠️ Pagamento ao vendedor (Inter): NÃO enviei a certidão de ônus pós-registro — não há e-mail do consultor do Inter ligado a este card. Vincule o e-mail do Inter na tela E-mail (botão "Vincular") e peça de novo (Jarvis: "manda a certidão pós-registro do cliente pro Inter").');
    return { ok: false, motivo: 'sem e-mail do consultor do Inter ligado ao card' };
  }

  // Certidão de ônus pós-registro: a última emitida pelo CRM (ONR) e guardada no Drive; sem ela, o arquivo de ônus/matrícula mais recente da pasta IMOVEL.
  const { arquivosDoImovel } = require('./vistoria-inter.service') as typeof import('./vistoria-inter.service');
  const doImovel = await arquivosDoImovel(p.accountId, cf).catch(() => []);
  const cert = await prisma.certidaoRequest.findFirst({ where: { accountId: p.accountId, leadId: p.leadId, status: 'ISSUED', driveFileId: { not: null } }, orderBy: { finishedAt: 'desc' }, select: { driveFileId: true, matricula: true, finishedAt: true } });
  const arquivo = (cert && doImovel.find((f) => f.id === cert.driveFileId)) || [...doImovel].reverse().find((f) => /ONUS|MATRICULA/i.test(f.name)) || null;
  if (!arquivo) {
    await avisar(p.accountId, p.leadId, lead.name, '⚠️ Pagamento ao vendedor (Inter): NÃO enviei — não achei a certidão de ônus pós-registro na pasta IMOVEL do Drive. Peça a certidão (Jarvis: "pede a certidão de ônus do cliente") e, quando sair, peça o envio de novo.');
    return { ok: false, motivo: 'sem certidão de ônus na pasta IMOVEL' };
  }

  // Responde SEMPRE pela caixa que RECEBEU o e-mail do Inter / que está conversando com o consultor (Fabio 29/10: "precisa ser o e-mail que recebeu, ou o e-mail que está conversando").
  // Nunca troca pela comercial: se essa caixa não existir mais, não envia.
  const acc = await prisma.emailAccount.findFirst({ where: { id: pessoa.emailAccountId, accountId: p.accountId } });
  if (!acc) { await avisar(p.accountId, p.leadId, lead.name, '⚠️ Pagamento ao vendedor (Inter): NÃO enviei — a caixa de e-mail que conversa com o consultor do Inter não está mais ligada ao CRM.'); return { ok: false, motivo: 'a caixa que conversa com o Inter não está ligada ao CRM' }; }
  const { downloadDriveFile } = await import('./google.service');
  // O anexo vai com o nome "CERTIDAO DE ONUS POS REGISTRO" (e o arquivo é renomeado no Drive também).
  if (!/POS REGISTRO/i.test(arquivo.name)) { try { const r = await renomearOnusPosRegistro(p.accountId, p.leadId); if (r.ok && r.para) arquivo.name = r.para; } catch { /* segue com o nome atual */ } }
  const content = await downloadDriveFile(p.accountId, arquivo.id, arquivo.mimeType);
  const consultor = pessoa.fromName ? firstName(pessoa.fromName) : '';
  const matricula = cert?.matricula || String(cf.numero_matricula || '').trim();
  const body = [
    `Olá${consultor ? `, ${consultor}` : ''}, tudo bem?`,
    '',
    `Segue em anexo a certidão de ônus atualizada pós-registro do imóvel do cliente ${nome}${matricula ? ` (matrícula nº ${matricula})` : ''}, para seguirmos com o pagamento ao vendedor.`,
    '',
    'Qualquer dúvida, estou à disposição.',
    'Obrigado!',
  ].join('\n');
  const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
  await sendEmailFrom({ acc, userId: p.userId || null, to: [pessoa.fromAddress!.toLowerCase()], cc: [], subject: `Re: ${cleanSubject(pessoa.subject || `Pagamento ao vendedor - ${nome.toUpperCase()}`)}`, body, replyToId: pessoa.id, leadId: p.leadId, io: (p.io || ({ to: () => ({ emit: () => {} }) })) as any, attachments: [{ filename: arquivo.name, contentType: arquivo.mimeType, content }] } as any);

  const fresh = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: p.leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _onusPosRegistroSentAt: new Date().toISOString() } } });
  await avisar(p.accountId, p.leadId, lead.name, `📨 Pagamento ao vendedor (Inter): certidão de ônus pós-registro (${arquivo.name}) enviada a ${pessoa.fromAddress} na conversa "${cleanSubject(pessoa.subject || '')}".`);
  return { ok: true, to: pessoa.fromAddress!, anexo: arquivo.name };
}
