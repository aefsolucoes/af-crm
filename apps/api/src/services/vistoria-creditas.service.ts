import { prisma } from '../lib/prisma';
import { cleanSubject } from './inter-email.service';
import { arquivosDoImovel, moverParaVistoria } from './vistoria-inter.service';

/**
 * Botão "Solicitar vistoria Creditas" do card (Fabio 03/11: "já temos base que é por e-mail para o Jonatas"). A vistoria da Creditas é pedida por e-mail ao Jonatas (suporte da
 * Creditas), com o NOME e o TELEFONE do cliente pro agendamento e, em anexo, a certidão de ônus (matrícula) e a capa do IPTU do imóvel. O CRM monta o e-mail (revisável na tela)
 * e, quando já existe a conversa da Creditas sobre este cliente ("Crédito Pré Aprovado - NOME ID: … CPF: …"), responde NELA, pela caixa comercial. Nada sai sem alguém clicar em
 * "Enviar à Creditas". Faltando certidão ou IPTU, o e-mail abre mesmo assim, com o aviso.
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

export const CREDITAS_VISTORIA_EMAIL = 'jonatas.carmona@creditas.com';
const CREDITAS_FROM = /@([a-z0-9-]+\.)*creditas\.com(\.br)?$/i;

const titleCase = (s: string) => s.toLowerCase().replace(/(^|\s)(\S)/g, (_m, a, b) => a + b.toUpperCase()).replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (m) => m.toLowerCase());
const fmtCpf = (v: unknown) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : ''; };

export interface VistoriaCreditasPreview {
  to: string;
  cc: string;
  subject: string;
  body: string;
  replyToId: string | null;
  anexos: { id: string; name: string; path: string; size: number; checked: boolean }[];
  jaSolicitadaEm: string | null;
  temCreditas: boolean;
  contatoVazio: boolean;
  avisos: string[];
}

/** Pergunta ao cliente quem acompanha a vistoria — hoje é a regra única de todos os bancos (vistoria-contato.service, Fabio 14/11): Financiamento = vendedor/corretor/outra pessoa;
 *  Home Equity = sugere o próprio cliente e confirma. Conversa fechada = template "Olá, tudo bem?" e a pergunta na resposta. Mantido aqui pros chamadores antigos (botão, CAIXA). */
export async function pedirContatoVistoria(accountId: string, leadId: string, userId: string, io?: Io): Promise<'ja_tem' | 'mensagem' | 'template' | 'aguardando'> {
  const { pedirContato } = require('./vistoria-contato.service') as typeof import('./vistoria-contato.service');
  return pedirContato(accountId, leadId, { userId: userId || null, banco: 'Creditas', io: io as any });
}

/** Bloco CONTATO do e-mail ao Jonatas (contato confirmado com o cliente). */
export function linhasContatoCreditas(c: { nome: string; telefone: string }): string[] {
  const { fmtFone } = require('./vistoria-contato.service') as typeof import('./vistoria-contato.service');
  return [`• Nome: ${c.nome}`, `• Telefone: ${fmtFone(c.telefone)}`];
}

type Arquivo = { id: string; name: string; path: string; size: number; mimeType: string; tipo?: string };

/** Arquivos do imóvel que podem ir no e-mail: a pasta IMOVEL do Drive + os anexos da conversa já classificados como documento do imóvel (certidão/matrícula/IPTU). */
async function arquivosPermitidos(accountId: string, leadId: string, cf: Record<string, any>): Promise<Arquivo[]> {
  const out: Arquivo[] = await arquivosDoImovel(accountId, cf);
  const tipos = (cf._docInfo || {}) as Record<string, string>;
  const ids = Object.keys(tipos).filter((k) => /CERTIDAO DE ONUS|MATRICULA|IPTU|CADASTRO IMOBILIARIO/i.test(String(tipos[k]).split('|')[0]));
  if (ids.length) {
    const atts = await prisma.messageAttachment.findMany({ where: { leadId, id: { in: ids }, driveFileId: { not: null } }, select: { id: true, driveFileId: true, fileName: true, mimeType: true } });
    for (const a of atts) {
      if (!a.driveFileId || out.some((f) => f.id === a.driveFileId) || !/^(application\/pdf|image\/)/.test(a.mimeType)) continue;
      out.push({ id: a.driveFileId, name: a.fileName, path: 'conversa', size: 0, mimeType: a.mimeType, tipo: String(tipos[a.id]).split('|')[0] });
    }
  }
  return out;
}

/** Tipo do arquivo pelo nome (a pasta IMOVEL usa o nome do tipo: "CERTIDAO DE ONUS…", "MATRICULA DO IMOVEL…", "CAPA IPTU…") ou pela classificação do anexo. */
function tipoDoArquivo(nome: string, tipoAnexo?: string): 'ONUS' | 'CAPA_IPTU' | 'IPTU_OUTRO' | 'GUIA_IPTU' | 'IPTU_CERTIDAO' | null {
  const n = `${tipoAnexo || ''} ${nome}`.toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (/CERTIDAO DE ONUS|MATRICULA DO IMOVEL|INTEIRO TEOR/.test(n)) return 'ONUS';
  if (/CAPA IPTU/.test(n)) return 'CAPA_IPTU';
  if (/CADASTRO IMOBILIARIO|NOTIFICACAO IPTU/.test(n)) return 'IPTU_OUTRO';
  if (/GUIA IPTU/.test(n)) return 'GUIA_IPTU';
  // Certidão de débitos do IPTU (negativa ou positiva) traz a INSCRIÇÃO imobiliária — vale quando não há capa/cadastro/guia (Fabio 05/11, Milena).
  if (/CND IPTU|CERTIDAO.*(IPTU|DEBITOS)/.test(n)) return 'IPTU_CERTIDAO';
  return null;
}

/** Bloco aparece no card quando há aprovação da Creditas (ou a vistoria já foi pedida). Leve: sem Drive. */
export async function vistoriaCreditasStatus(accountId: string, leadId: string): Promise<{ aplicavel: boolean; jaSolicitadaEm: string | null; contatoVazio: boolean; contatoPerguntadoEm: string | null }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  const em = cf._vistoriaCreditasAt;
  const aprovada = await prisma.creditAnalysis.findFirst({ where: { leadId, bank: 'CREDITAS', dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] } }, select: { id: true } });
  return { aplicavel: !!aprovada || !!em, jaSolicitadaEm: em ? String(em) : null, contatoVazio: !String(cf.contato_vistoria || '').trim(), contatoPerguntadoEm: cf._vistoriaContatoAsk?.at ? String(cf._vistoriaContatoAsk.at) : null };
}

export async function vistoriaCreditasPreview(accountId: string, leadId: string): Promise<VistoriaCreditasPreview> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true, contact: { select: { phone: true } } } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  const acc = await prisma.emailAccount.findFirst({ where: { accountId, userId: null }, orderBy: { createdAt: 'asc' }, select: { id: true } });

  // Proposta da Creditas deste card: ID (nº da proposta) e o CPF de quem está nela.
  const creditas = await prisma.creditAnalysis.findFirst({ where: { leadId, bank: 'CREDITAS', dryRun: false, proposalNumber: { not: null } }, orderBy: [{ chosen: 'desc' }, { createdAt: 'desc' }], select: { proposalNumber: true, holderCpf: true, holderName: true, status: true } });
  const nome = titleCase(String(creditas?.holderName || cf.participante_1 || lead.name || '').trim()) || 'Cliente';
  const cpf = fmtCpf(creditas?.holderCpf) || fmtCpf(cf.cpf_1);
  const idCreditas = String(creditas?.proposalNumber || '').trim();

  // Conversa da Creditas sobre este cliente (o Jonatas manda "Crédito Pré Aprovado - NOME ID: … CPF: …"): responde nela; senão, e-mail novo.
  const emails = acc ? await prisma.emailMessage.findMany({
    where: { leadId, emailAccountId: acc.id, OR: [{ fromAddress: { contains: 'creditas.com', mode: 'insensitive' } }, { subject: { contains: 'Pré Aprovado', mode: 'insensitive' } }] },
    orderBy: { date: 'desc' }, take: 15, select: { id: true, fromAddress: true, subject: true, ccList: true, folder: true },
  }) : [];
  const daCreditas = emails.filter((e) => e.fromAddress && CREDITAS_FROM.test(e.fromAddress));
  const pai = daCreditas.find((e) => /vistoria/i.test(e.subject || '')) || daCreditas.find((e) => /pr[eé][ -]?aprovad/i.test(e.subject || '')) || daCreditas[0] || null;
  const ccPai = ((pai?.ccList as unknown as { address?: string }[] | null) || []).map((c) => String(c?.address || '').toLowerCase()).filter((a) => CREDITAS_FROM.test(a) && a !== CREDITAS_VISTORIA_EMAIL);

  // Contato SÓ confirmado com o cliente (Fabio 14/11) — sem ele o e-mail não sai: o CRM pergunta e o pedido fica armado (vistoria-contato.service).
  const contato = (require('./vistoria-contato.service') as typeof import('./vistoria-contato.service')).contatoConfirmado(cf);
  const endImovel = String(cf.endereco_imovel || cf.imovel_endereco || '').trim();
  const matricula = String(cf.numero_matricula || '').trim();

  const doImovel = await arquivosPermitidos(accountId, leadId, cf);
  const cert = await prisma.certidaoRequest.findFirst({ where: { accountId, leadId, status: 'ISSUED', driveFileId: { not: null } }, orderBy: { finishedAt: 'desc' }, select: { driveFileId: true } });
  const comTipo = doImovel.map((f) => ({ f, tipo: f.id === cert?.driveFileId ? 'ONUS' as const : tipoDoArquivo(f.name, f.tipo) }));
  // Marcados: UMA certidão de ônus (a emitida pelo ONR; senão a que o cliente mandou, sem as cópias " 2.pdf") e UMA capa do IPTU (sem capa: o cadastro/notificação do IPTU;
  // a GUIA de pagamento só se não houver nada disso — já veio guia de OUTRO imóvel, então fica o aviso pra conferir).
  const primeiro = (t: string) => comTipo.find((x) => x.tipo === t && !/ \d\.\w+$/i.test(x.f.name)) || comTipo.find((x) => x.tipo === t);
  const onus = (cert && comTipo.find((x) => x.f.id === cert.driveFileId)) || primeiro('ONUS');
  const iptu = primeiro('CAPA_IPTU') || primeiro('IPTU_OUTRO') || primeiro('GUIA_IPTU') || primeiro('IPTU_CERTIDAO');
  const marcados = new Set([onus?.f.id, iptu?.f.id].filter(Boolean) as string[]);
  // Matrícula/ônus em FOTOS separadas por folha ("… - PAG 1", "- PAG 2"… — Fabio 05/11): vão TODAS as folhas da mesma matrícula.
  const pag = onus ? /^(.*) - PAG \d+/i.exec(onus.f.name.replace(/\.\w+$/, '')) : null;
  if (pag) for (const x of comTipo) if (x.f.name.toUpperCase().startsWith(`${pag[1].toUpperCase()} - PAG `) && !/FOTO ANTERIOR/i.test(x.f.name)) marcados.add(x.f.id);
  const anexos = doImovel.map((f) => ({ id: f.id, name: f.path === 'conversa' && f.tipo ? `${f.tipo} (${f.name})` : f.name, path: f.path, size: f.size, checked: marcados.has(f.id) }));

  const linhas = [
    'Olá, Jonatas, tudo bem?',
    '',
    `Seguem os dados para o agendamento da vistoria do imóvel do cliente ${nome}${idCreditas ? ` (ID ${idCreditas})` : ''}${cpf ? `, CPF ${cpf}` : ''}.`,
    '',
    'CONTATO PARA O AGENDAMENTO',
    ...(contato ? linhasContatoCreditas(contato) : ['• (aguardando o cliente confirmar quem acompanha a vistoria)']),
    ...(matricula || endImovel ? ['', `IMÓVEL: ${matricula ? `matrícula nº ${matricula}` : ''}${matricula && endImovel ? ' — ' : ''}${endImovel}`] : []),
    '',
    `Seguem em anexo ${[onus ? 'a certidão de ônus (matrícula) do imóvel' : '', iptu ? 'a capa do IPTU' : ''].filter(Boolean).join(' e ') || 'os documentos do imóvel'}.`,
    '',
    'Qualquer dúvida, estou à disposição.',
    'Obrigado!',
  ];

  const avisos: string[] = [];
  if (!creditas) avisos.push('Não achei proposta da Creditas com número neste card — confira se é o cliente certo.');
  if (!String(cf.link_pasta_drive || '').trim()) avisos.push('O card não tem pasta do Drive vinculada: os documentos do imóvel não foram encontrados.');
  if (!onus) avisos.push('Faltou a CERTIDÃO DE ÔNUS (matrícula) na pasta IMOVEL do cliente — o e-mail sai sem ela se você não anexar.');
  if (!iptu) avisos.push('Faltou a CAPA DO IPTU na pasta IMOVEL do cliente — o e-mail sai sem ela se você não anexar.');
  else if (iptu.tipo === 'GUIA_IPTU') avisos.push('Não achei a capa do IPTU; marquei a GUIA do IPTU — confira se é do mesmo imóvel.');
  if (!contato) avisos.push(`⚠️ O contato da vistoria ainda não foi confirmado com o cliente (campo "Contato vistoria" vazio ou sem nome e telefone). Ao enviar, o CRM pergunta a ele quem acompanha o engenheiro${cf._vistoriaContatoAsk?.at ? ` (já perguntado em ${new Date(cf._vistoriaContatoAsk.at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })} — esperando a resposta)` : ''} e o pedido sai sozinho, com esse contato, quando ele responder. Se você já confirmou, preencha o campo antes de enviar.`);
  if (!pai) avisos.push('Ainda não há conversa da Creditas sobre este cliente na caixa comercial: vai como e-mail novo ao Jonatas.');

  return {
    to: CREDITAS_VISTORIA_EMAIL,
    cc: [...new Set(ccPai)].join(', '),
    subject: pai?.subject ? `Re: ${cleanSubject(pai.subject)}` : `VISTORIA CLIENTE - ${nome.toUpperCase()}${idCreditas ? ` ID: ${idCreditas}` : ''}${cpf ? ` CPF: ${cpf}` : ''}`,
    body: linhas.join('\n'),
    replyToId: pai?.id || null,
    anexos,
    jaSolicitadaEm: cf._vistoriaCreditasAt ? String(cf._vistoriaCreditasAt) : null,
    temCreditas: !!creditas,
    contatoVazio: !contato,
    avisos,
  };
}

/** Envia o pedido de vistoria à Creditas (só quando alguém clica em "Enviar à Creditas"). */
export async function solicitarVistoriaCreditas(p: { accountId: string; userId: string; leadId: string; to: string; cc?: string; subject: string; body: string; replyToId?: string | null; attachDriveFileIds?: string[]; io?: Io }) {
  const lead = await prisma.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { name: true, customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const to = String(p.to || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new Error('Informe o e-mail da Creditas no campo "Para".');
  if (!CREDITAS_FROM.test(to) && !String(process.env.VISTORIA_ALLOW_ANY_RECIPIENT || '')) throw new Error('O destinatário precisa ser um e-mail da Creditas (@creditas.com).');
  // Sem o contato da vistoria confirmado com o cliente o pedido NÃO sai (Fabio 14/11): pergunta + pedido armado, que sai sozinho com o contato.
  {
    const vc = require('./vistoria-contato.service') as typeof import('./vistoria-contato.service');
    const g = await vc.garantirContatoVistoria(p.accountId, p.leadId, { banco: 'Creditas', userId: p.userId, io: p.io });
    if (!g.ok) {
      if (g.estado !== 'erro') await vc.armarVistoria(p.leadId, { banco: 'CREDITAS', userId: p.userId, to, cc: p.cc || '', subject: p.subject, body: p.body, replyToId: p.replyToId || null, attachDriveFileIds: p.attachDriveFileIds || [] });
      throw new Error(vc.textoEsperandoContato(g, 'Creditas', g.estado !== 'erro'));
    }
  }

  const acc = await prisma.emailAccount.findFirst({ where: { accountId: p.accountId, userId: null }, orderBy: { createdAt: 'asc' } });
  if (!acc) throw new Error('A caixa de e-mail comercial não está configurada.');

  const permitidos = await arquivosPermitidos(p.accountId, p.leadId, (lead.customFields || {}) as Record<string, any>); // só documentos do imóvel deste cliente
  const { downloadDriveFile } = await import('./google.service');
  const attachments: { filename: string; contentType: string; content: Buffer }[] = [];
  for (const id of Array.from(new Set(p.attachDriveFileIds || []))) {
    const f = permitidos.find((x) => x.id === id);
    if (!f) throw new Error('Um dos anexos não é documento do imóvel deste cliente.');
    attachments.push({ filename: f.name, contentType: f.mimeType, content: await downloadDriveFile(p.accountId, f.id, f.mimeType) });
  }
  const cc = String(p.cc || '').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);

  const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
  const enviar = (conta: typeof acc, copias: string[]) => sendEmailFrom({ acc: conta, userId: p.userId, to: [to], cc: [...new Set([...cc, ...copias])].filter((a) => a.toLowerCase() !== conta.address.toLowerCase()), subject: p.subject, body: p.body, replyToId: p.replyToId || null, leadId: p.leadId, io: (p.io || ({ to: () => ({ emit: () => {} }) })) as any, attachments });
  let via = acc.address;
  try {
    await enviar(acc, []);
  } catch (e: any) {
    // CAIXA RESERVA (Fabio 12/11, a mesma do Inter): comercial@ suspenso no Titan (535) → sai pela caixa pessoal do 1º admin, no mesmo fio. Só no erro de login.
    const msg = String(e?.message || e);
    if (!/\b535\b|invalid login|authentication failed|EAUTH/i.test(msg)) throw e;
    const dono = await prisma.user.findFirst({ where: { accountId: p.accountId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    const reserva = dono ? await prisma.emailAccount.findFirst({ where: { accountId: p.accountId, userId: dono.id, NOT: { id: acc.id } }, orderBy: { createdAt: 'asc' } }) : null;
    if (!reserva) throw new Error(`${msg} — a caixa ${acc.address} está com erro de login e não há caixa reserva`);
    try { await enviar(reserva, []); via = reserva.address; } catch (e2: any) { throw new Error(`${msg} — e pela caixa reserva ${reserva.address}: ${e2?.message || e2}`); }
  }

  const fresh = await prisma.lead.findUnique({ where: { id: p.leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: p.leadId }, data: { customFields: { ...((fresh?.customFields || {}) as any), _vistoriaCreditasAt: new Date().toISOString() } } });
  await prisma.note.create({ data: { leadId: p.leadId, type: 'COMMENT', userId: p.userId, content: `📨 Vistoria solicitada à Creditas (e-mail para ${to}${attachments.length ? `, com ${attachments.length} anexo(s): ${attachments.map((a) => a.filename).join('; ')}` : ', sem anexo'}).${via !== acc.address ? ` Saiu pelo ${via} (o ${acc.address} está com erro de login no envio).` : ''}` } }).catch(() => {});
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(p.accountId, { title: '📨 Vistoria solicitada à Creditas', body: lead.name, leadId: p.leadId }).catch(() => {}); } catch { /* aviso */ }
  // Vistoria solicitada = o card vai pra "Vistoria do Imóvel" (Fabio 03/11), como no Inter e no Santander.
  await moverParaVistoria(p.accountId, p.leadId, 'vistoria solicitada à Creditas', p.io);
  return { ok: true, to, anexou: attachments.length };
}

/** Pedido AUTOMÁTICO da vistoria da Creditas (Fabio 14/11: o laudo do outro banco reprovou o imóvel e o cliente aceitou seguir pela Creditas — "sim, pedir sozinho").
 *  Sem "Contato vistoria" confirmado: pergunta ao cliente quem acompanha o engenheiro (07h–21h) e espera a resposta (vistoria-contato.service, Fabio 14/11).
 *  Depois manda o mesmo e-mail do botão ao Jonatas, com a certidão de ônus e o IPTU marcados na pasta. 'enviada' | 'aguardando'. */
export async function pedirVistoriaCreditasSozinho(accountId: string, leadId: string, io?: Io): Promise<'enviada' | 'aguardando'> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!lead) throw new Error('Card não encontrado');
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._vistoriaCreditasAt) return 'enviada';
  const dono = await prisma.user.findFirst({ where: { accountId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  if (!dono) throw new Error('sem administrador na conta');
  // Contato da vistoria confirmado com o cliente antes do pedido (Fabio 14/11 — regra única, vistoria-contato.service). Pergunta só 07h–21h.
  {
    const vc = require('./vistoria-contato.service') as typeof import('./vistoria-contato.service');
    const g = await vc.garantirContatoVistoria(accountId, leadId, { banco: 'Creditas', io, respeitarHorario: true });
    if (!g.ok) {
      if (g.estado === 'erro') throw new Error(vc.textoEsperandoContato(g, 'Creditas', false));
      return 'aguardando';
    }
  }
  const pv = await vistoriaCreditasPreview(accountId, leadId);
  await solicitarVistoriaCreditas({ accountId, userId: dono.id, leadId, to: pv.to, cc: pv.cc, subject: pv.subject, body: pv.body, replyToId: pv.replyToId, attachDriveFileIds: pv.anexos.filter((a) => a.checked).map((a) => a.id), io });
  if (pv.avisos.some((a) => /CERTIDÃO DE ÔNUS|CAPA DO IPTU/.test(a))) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ Vistoria da Creditas pedida sozinha, mas: ${pv.avisos.filter((a) => /CERTIDÃO DE ÔNUS|CAPA DO IPTU/.test(a)).join(' ')}` } }).catch(() => {});
    try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: '⚠️ Vistoria Creditas sem documento do imóvel', body: 'Pedida sozinha, mas faltou certidão de ônus ou IPTU na pasta — confira.', leadId }).catch(() => {}); } catch { /* aviso */ }
  }
  return 'enviada';
}
