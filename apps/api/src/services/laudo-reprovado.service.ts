import { prisma } from '../lib/prisma';

/**
 * LAUDO QUE REPROVA O IMÓVEL (Fabio 14/11). O banco respondeu que a avaliação/vistoria NÃO aprovou o imóvel como garantia:
 *  - IA do card DESLIGADA → só avisa a equipe por push (+ nota no card), nada vai ao cliente ("IA desligada, apenas informa a equipe por push");
 *  - IA LIGADA, sem aprovação em OUTRO banco → avisa o cliente da negativa do banco sobre o imóvel e leva o card pra Perdidos;
 *  - IA LIGADA, com aprovação em outro banco → avisa o cliente que vai tentar pelo outro banco já aprovado (com o nome do banco) e manda a proposta dele com o botão
 *    "Seguir com esta". Se o cliente concordar (botão, ou "sim" por escrito → a IA marca o banco), a ⭐ vai pra esse banco, o card volta pra "Documentação Recebida" e a
 *    vistoria desse banco segue pelo fluxo normal (vistoria-ai: Santander pela Letícia; com a chave da contratação automática desligada, passo manual com push).
 * Hoje só o e-mail do Inter detecta o laudo reprovado (inter-email.service). Estado em customFields._laudoReprovado.
 * Fora das 07h–21h espera; conversa fechada → template de atualização, e a mensagem sai quando o cliente responder (até 2 dias; depois, push pra equipe).
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
type Status = 'NOVO' | 'TEMPLATE' | 'AVISADO_PERDIDO' | 'OFERECIDO' | 'ESCOLHEU' | 'EQUIPE';
/** O e-mail fala em pendência/correção/reavaliação ("não foi aprovado ainda", "reenviar a matrícula"): não é negativa definitiva — só a equipe é avisada. Pura. */
export const reprovacaoDuvidosa = (texto: string) => /pend[eê]ncia|reenvi|corrig|regulariz|aguard|\bainda\b|reavali|nova\s+(vistoria|avalia)|recurso|contest/i.test(texto);
export type LaudoReprovado = { banco: string; at: string; status: Status; duvidoso?: boolean; emailId?: string; outro?: string | null; analysisId?: string | null; templateAt?: string; avisadoAt?: string; escolheuAt?: string; motivo?: string };

const ESPERA_TEMPLATE_MS = 2 * 86_400_000;
export const NOME_BANCO: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
/** "no Inter" / "na Creditas" / "no Santander". Pura. */
export const noBanco = (b: string) => `${b === 'CREDITAS' ? 'na' : 'no'} ${NOME_BANCO[b] || b}`;
const doBanco = (b: string) => `${b === 'CREDITAS' ? 'da' : 'do'} ${NOME_BANCO[b] || b}`;
const peloBanco = (b: string) => `${b === 'CREDITAS' ? 'pela' : 'pelo'} ${NOME_BANCO[b] || b}`;
const inicio = (nome: string, resto: string) => (nome ? `${nome}, ${resto}` : resto.charAt(0).toUpperCase() + resto.slice(1));

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };

async function salva(leadId: string, lr: LaudoReprovado) {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_laudoReprovado}', ${JSON.stringify(lr)}::jsonb, true) WHERE id = ${leadId}`;
}
async function ler(leadId: string): Promise<LaudoReprovado | null> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  return (((l?.customFields || {}) as Record<string, any>)._laudoReprovado as LaudoReprovado) || null;
}

/** Textos ao cliente. Puros (testáveis). */
export function textoSemOutroBanco(nome: string, banco: string): string {
  return inicio(nome, `recebemos o retorno ${doBanco(banco)} sobre a avaliação do imóvel e, infelizmente, a engenharia do banco não aprovou o imóvel como garantia. 😔 Com isso, por esse banco não vai ser possível seguir.\n\nSinto muito! Se você tiver outro imóvel com matrícula pra colocar em garantia, é só me avisar que a gente tenta de novo.`);
}
export function textoComOutroBanco(nome: string, banco: string, outro: string): string {
  return inicio(nome, `recebemos o retorno ${doBanco(banco)} sobre a avaliação do imóvel e, infelizmente, a engenharia do banco não aprovou o imóvel. 😔\n\nMas você também tem crédito aprovado ${noBanco(outro)}, então a gente pode tentar seguir ${outro === 'CREDITAS' ? 'por ela' : 'por ele'}! Vou te mandar a proposta ${doBanco(outro)} aqui embaixo: se você concordar, é só tocar em *Seguir com esta* que eu já solicito a vistoria do imóvel ${peloBanco(outro)}.`);
}

/** Outro banco do Home Equity ainda aprovado (o último veredito de cada banco), fora o que reprovou o imóvel — o de MAIOR valor (Fabio: sempre a proposta maior). */
async function outroBancoAprovado(leadId: string, bancoReprovou: string): Promise<{ bank: string; analysisId: string; valor: string } | null> {
  const an = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const opts = (await an.optionsFromAnalyses(leadId).catch(() => null)) || [];
  const ids = opts.map((o) => o.analysisId).filter((x): x is string => !!x);
  if (!ids.length) return null;
  const rows = await prisma.creditAnalysis.findMany({ where: { id: { in: ids } }, select: { id: true, bank: true, approvedValue: true, netValue: true } });
  const cands = rows.filter((r) => r.bank !== bancoReprovou && r.bank in NOME_BANCO).sort((a, b) => (Number(b.netValue || b.approvedValue) || 0) - (Number(a.netValue || a.approvedValue) || 0));
  const top = cands[0];
  if (!top) return null;
  const opt = opts.find((o) => o.analysisId === top.id);
  return { bank: top.bank, analysisId: top.id, valor: opt?.valor || '' };
}

/** O e-mail do banco disse que o laudo reprovou o imóvel: registra (uma vez por e-mail) e já trata. */
export async function iniciarLaudoReprovado(accountId: string, leadId: string, banco: string, emailId: string, motivo: string, io?: Io): Promise<void> {
  const atual = await ler(leadId);
  if (atual?.emailId === emailId) return;
  if (atual && atual.banco === banco && ['AVISADO_PERDIDO', 'OFERECIDO', 'ESCOLHEU'].includes(atual.status)) return; // o mesmo banco já reprovou e já foi tratado
  const lr: LaudoReprovado = { banco, at: new Date().toISOString(), status: 'NOVO', emailId, motivo: motivo.replace(/\s+/g, ' ').slice(0, 300) };
  await salva(leadId, lr);
  if (!reprovacaoDuvidosa(lr.motivo || '')) await note(leadId, `🏚️ O ${NOME_BANCO[banco] || banco} REPROVOU o imóvel na avaliação (laudo/vistoria). O card não vai pra Análise Jurídica.`);
  await processarUm(accountId, leadId, io);
}

/** Poller (1 min, credit-auto): reprovações à espera do horário ou da resposta ao template. */
export async function processLaudoReprovado(accountId: string, io?: Io): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false AND "customFields"->'_laudoReprovado'->>'status' IN ('NOVO', 'TEMPLATE') LIMIT 20`;
  for (const { id } of ids) await processarUm(accountId, id, io).catch((e: any) => console.error('[Laudo reprovado]', e?.message));
}

async function processarUm(accountId: string, leadId: string, io?: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, status: true, aiAutoReplyActive: true, customFields: true, pipeline: { select: { departmentId: true, department: { select: { name: true } } } } } });
  if (!lead || lead.status !== 'OPEN') return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const lr = cf._laudoReprovado as LaudoReprovado | undefined;
  if (!lr || !['NOVO', 'TEMPLATE'].includes(lr.status) || cf._autoPaused) return;
  const outro = await outroBancoAprovado(leadId, lr.banco);
  const B = NOME_BANCO[lr.banco] || lr.banco;
  const O = outro ? NOME_BANCO[outro.bank] || outro.bank : '';
  const paraEquipe = async (porque: string, duvidoso = false) => {
    await salva(leadId, { ...lr, status: 'EQUIPE', duvidoso, outro: outro?.bank || null, analysisId: outro?.analysisId || null });
    if (duvidoso) {
      await note(leadId, `🏚️ E-mail do ${B} sobre a avaliação do imóvel — ${porque}. Nada foi ao cliente e o card não mudou de etapa.`);
      push(accountId, `🏚️ ${lead.name}: ${B} — confira a avaliação do imóvel`, 'O e-mail fala em imóvel não aprovado, mas com pendência/reavaliação. Nada foi ao cliente.', leadId);
      return;
    }
    const oQue = outro
      ? `o cliente tem aprovação ${noBanco(outro.bank)}${outro.valor ? ` (${outro.valor})` : ''}: avise-o, ofereça ${"seguir " + peloBanco(outro.bank)} (aba Financiamento → "Encaminhar aprovação ao cliente", com o botão "Seguir com esta") e, se ele concordar, solicite a vistoria ${peloBanco(outro.bank)}.`
      : 'o cliente não tem aprovação em outro banco: avise-o da negativa do banco sobre o imóvel e mova o card pra Perdidos.';
    await note(leadId, `🏚️ ${B} reprovou o imóvel no laudo — ${porque}. Nada foi ao cliente: ${oQue}`);
    push(accountId, `🏚️ ${lead.name}: ${B} reprovou o imóvel`, outro ? `Tem aprovação ${noBanco(outro.bank)}${outro.valor ? ` (${outro.valor})` : ''}: ofereça seguir por ele.` : 'Sem aprovação em outro banco: avise o cliente e mova pra Perdidos.', leadId);
  };
  // IA desligada (Fabio 14/11): só a equipe fica sabendo.
  if (!lead.aiAutoReplyActive) return paraEquipe('a IA deste card está desligada');
  // Negativa que não parece definitiva (pendência, reenvio, reavaliação): a equipe confere antes de falar com o cliente ou mandar pra Perdidos.
  if (reprovacaoDuvidosa(lr.motivo || '')) return paraEquipe('o e-mail fala em pendência/correção/reavaliação, então pode não ser a negativa final — confira o e-mail', true);

  const an = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!an.inNoticeWindow()) return; // fora das 07h–21h: tenta no próximo minuto
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name) || '';
  const msg = require('./message.service') as typeof import('./message.service');
  if (!(await an.whatsappWindowOpen(leadId))) {
    if (lr.status === 'NOVO') {
      const { templateAtualizacaoDoLead } = require('./template-atualizacao') as typeof import('./template-atualizacao');
      const t = await msg.sendOutboundWhatsAppTemplate({ accountId, leadId, ...(await templateAtualizacaoDoLead(leadId, nome || 'cliente')), io: io as any });
      if (!t.success) return paraEquipe(`a conversa está fechada e o template de atualização não saiu (${t.error})`);
      await salva(leadId, { ...lr, status: 'TEMPLATE', templateAt: new Date().toISOString() });
      await note(leadId, `🏚️ Laudo reprovado: a conversa está fechada — mandei o template de atualização; o aviso ao cliente sai quando ele responder.`);
      return;
    }
    if (lr.templateAt && Date.now() - Date.parse(lr.templateAt) > ESPERA_TEMPLATE_MS) return paraEquipe('o cliente não respondeu o template de atualização em 2 dias');
    return;
  }

  if (!outro) {
    const env = await msg.sendOutboundWhatsApp({ accountId, leadId, content: textoSemOutroBanco(nome, lr.banco), io: io as any });
    if (!env.success) return paraEquipe(`a mensagem ao cliente não saiu (${env.error || 'erro'})`);
    const motivo = `Imóvel reprovado na avaliação do ${B} (sem aprovação em outro banco)`;
    const { updateLead } = require('./lead.service') as typeof import('./lead.service');
    await updateLead(leadId, accountId, { status: 'LOST', lostReason: motivo }, io as any);
    const { moveLeadToPerdidos } = require('./named-pipeline.service') as typeof import('./named-pipeline.service');
    await moveLeadToPerdidos({ accountId, leadId, departmentId: lead.pipeline?.departmentId, byName: 'Assistente IA', userId: null, motivo, io: io as any });
    await salva(leadId, { ...lr, status: 'AVISADO_PERDIDO', outro: null, analysisId: null, avisadoAt: new Date().toISOString() });
    await note(leadId, `🏚️ ${B} reprovou o imóvel e o cliente não tem aprovação em outro banco: avisei o cliente da negativa e o card foi pra Perdidos.`);
    push(accountId, `🏚️ ${lead.name}: ${B} reprovou o imóvel`, 'Sem aprovação em outro banco: cliente avisado, card em Perdidos.', leadId);
    return;
  }

  const env = await msg.sendOutboundWhatsApp({ accountId, leadId, content: textoComOutroBanco(nome, lr.banco, outro.bank), io: io as any });
  if (!env.success) return paraEquipe(`a mensagem ao cliente não saiu (${env.error || 'erro'})`);
  await new Promise((r) => setTimeout(r, 1500)); // a proposta chega depois do aviso
  const fw = await an.forwardApprovalToClient({ accountId, leadId, analysisId: outro.analysisId, io, porIa: true }).catch((e: any) => ({ ok: false, error: String(e?.message || e) }));
  await salva(leadId, { ...lr, status: 'OFERECIDO', outro: outro.bank, analysisId: outro.analysisId, avisadoAt: new Date().toISOString() });
  await note(leadId, `🏚️ ${B} reprovou o imóvel. O cliente tem aprovação ${noBanco(outro.bank)}${outro.valor ? ` (${outro.valor})` : ''}: avisei e ${fw.ok ? `mandei a proposta ${doBanco(outro.bank)} com o botão "Seguir com esta"` : `NÃO consegui mandar a proposta (${(fw as any).error || 'erro'}) — encaminhe pela aba Financiamento`}. Se ele concordar, a ⭐ vai pro ${O}, o card volta pra "Documentação Recebida" e a vistoria segue por ele.`);
  push(accountId, `🏚️ ${lead.name}: ${B} reprovou o imóvel`, `Ofereci seguir ${noBanco(outro.bank)}${fw.ok ? '' : ' (a proposta não saiu — encaminhe você)'}.`, leadId);
}

/** A ⭐ mudou (botão "Seguir com esta", IA pelo "sim" do cliente, ou a equipe): se foi pro banco oferecido depois do laudo reprovado, a vistoria passa a ser por ele —
 *  card volta pra "Documentação Recebida" e o estado da vistoria anterior sai (vistoria-ai pega o card com o banco novo). Chamado por chooseAnalysis. */
export async function escolheuOutroBanco(accountId: string, leadId: string, bank: string, io?: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, status: true, pipelineId: true, customFields: true, stage: { select: { name: true } } } });
  const lr = ((lead?.customFields || {}) as Record<string, any>)._laudoReprovado as LaudoReprovado | undefined;
  if (!lead || lead.status !== 'OPEN' || !lr || !['OFERECIDO', 'EQUIPE'].includes(lr.status) || bank === lr.banco || !(bank in NOME_BANCO)) return;
  if (lr.outro && lr.outro !== bank) return;
  const O = NOME_BANCO[bank];
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = (COALESCE("customFields", '{}'::jsonb) - '_vistoriaRequestedAt' - '_vistoriaAi') #- '{_manualSteps,vistoria}' WHERE id = ${leadId}`;
  await salva(leadId, { ...lr, status: 'ESCOLHEU', outro: bank, escolheuAt: new Date().toISOString() });
  const doc = await prisma.stage.findFirst({ where: { pipelineId: lead.pipelineId, name: 'Documentação Recebida' }, select: { id: true, name: true } });
  if (doc && lead.stage?.name !== doc.name) {
    const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
    await updateLeadStage(leadId, accountId, doc.id);
    await prisma.note.create({ data: { leadId, type: 'STAGE_CHANGE', content: `Estágio: "${lead.stage?.name || '—'}" → "${doc.name}" — o ${NOME_BANCO[lr.banco] || lr.banco} reprovou o imóvel e o cliente vai ${"seguir " + peloBanco(bank)}` } }).catch(() => {});
  }
  await note(leadId, `🏚️ O cliente concordou em ${"seguir " + peloBanco(bank)} depois do imóvel reprovado ${noBanco(lr.banco)}: ⭐ ${noBanco(bank)}, card em "Documentação Recebida" e a vistoria ${doBanco(bank)} segue pelo fluxo da vistoria (com a automação da contratação desligada, a equipe recebe o passo manual com push).`);
  io?.to(`lead:${leadId}`).emit('lead_updated', { leadId });
}

/** Linha do contexto da IA (ai-shared). */
export function aiLaudoReprovadoLinha(cf: Record<string, any>): string {
  const lr = cf?._laudoReprovado as LaudoReprovado | undefined;
  if (!lr?.status) return '';
  const B = NOME_BANCO[lr.banco] || lr.banco;
  const O = lr.outro ? NOME_BANCO[lr.outro] || lr.outro : '';
  const codigoIa = lr.outro === 'CREDIMORAR' ? 'SANTANDER' : lr.outro;
  if (lr.status === 'OFERECIDO' && O) return `IMÓVEL REPROVADO NO LAUDO DO ${B.toUpperCase()}: o ${B} não aprovou o imóvel na avaliação. O cliente já foi avisado e recebeu a proposta ${doBanco(lr.outro!)} com o botão "Seguir com esta". NUNCA diga que segue pelo ${B}. Se ele concordar em ${"seguir " + peloBanco(lr.outro!)} ("sim", "pode", "quero", "vamos"), marque "chooseBank": "${codigoIa}" e diga que você já vai solicitar a vistoria do imóvel ${peloBanco(lr.outro!)}. Se ele não quiser, pergunte se tem outro imóvel com matrícula pra colocar em garantia; se recusar tudo, "markLost": "Imóvel reprovado na avaliação do ${B}".`;
  if (lr.status === 'ESCOLHEU' && O) return `IMÓVEL REPROVADO NO LAUDO DO ${B.toUpperCase()}: o cliente aceitou ${"seguir " + peloBanco(lr.outro!)}; a vistoria agora é ${peloBanco(lr.outro!)}. Não fale mais do ${B}.`;
  if (lr.status === 'AVISADO_PERDIDO') return `IMÓVEL REPROVADO NO LAUDO DO ${B.toUpperCase()}: o cliente já foi avisado de que, com esse imóvel, não dá pra seguir. Se ele trouxer OUTRO imóvel com matrícula, peça que preencha a proposta de novo com ele.`;
  if (lr.status === 'EQUIPE' && lr.duvidoso) return `AVALIAÇÃO DO IMÓVEL (${B}): chegou um e-mail do banco sobre a avaliação do imóvel e a equipe está conferindo. Não fale de resultado da vistoria/laudo; se o cliente perguntar, diga que a equipe está acompanhando com o banco e já retorna.`;
  if (lr.status === 'EQUIPE') return `IMÓVEL REPROVADO NO LAUDO DO ${B.toUpperCase()}: o ${B} não aprovou o imóvel na avaliação e a equipe está cuidando do caso. NUNCA diga que segue pelo ${B} nem que a vistoria está em andamento; se o cliente perguntar, diga com jeito que o banco não aprovou o imóvel${O ? ` e que dá pra tentar ${"seguir " + peloBanco(lr.outro!)}, onde ele também tem crédito aprovado (se ele concordar, marque "chooseBank": "${codigoIa}")` : ' e pergunte se ele tem outro imóvel com matrícula pra garantia'}.`;
  return '';
}
