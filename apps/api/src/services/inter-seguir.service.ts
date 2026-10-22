import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp } from './message.service';
import { contractingAutoOn } from './contracting-auto.service';

type Io = Parameters<typeof sendOutboundWhatsApp>[0]['io'];

/**
 * CONFIRMAÇÃO DO CLIENTE PARA "SEGUIR COM PROPOSTA" DO INTER (Fabio 21/10, caso Luiz Fernando: a proposta do Inter estava "Aprovada — Aguardando aprovação do cliente" e o e-mail de engajamento, que libera
 * a vistoria, só chega depois do "Seguir com proposta" no portal; sobre pedir a confirmação ao cliente: "PODE PERGUNTAR AO CLIENTE").
 * O CRM só PERGUNTA e REGISTRA a resposta; o clique no portal (aceite do cliente, sem volta) fica com a EQUIPE:
 *  1) documentação completa + segue pelo Inter + sem e-mail de engajamento (gatilho: vigia da vistoria) → o CRM pergunta no WhatsApp "Você confirma que quer seguir com a proposta do Inter?" (uma vez;
 *     só com a IA do card ligada, na janela de 24 h e das 07h às 21h; senão nota + push à equipe);
 *  2) só um SIM claro, em resposta a ESSA pergunta (tem que ser a última mensagem enviada), grava CONFIRMED com a frase do cliente e avisa a equipe (nota + push) pra clicar em "Seguir com proposta";
 *  3) NÃO claro grava DECLINED e avisa a equipe.
 * Estado em customFields._interSeguir = { status: ASKED | CONFIRMED | DECLINED, … }.
 */

const MARCA = 'confirma que quer seguir com a proposta do Inter';
export const interSeguirAskText = (): string => `Pra liberar a vistoria do imóvel, preciso da sua confirmação: você ${MARCA}? Responda SIM para confirmar. Depois da sua confirmação, o banco manda um e-mail de engajamento e a gente já solicita a vistoria.`;

const NEGATIVA = /(^\s*n[aã]o\b|^\s*nao\b|n[aã]o quero|nao quero|desist|prefiro (outro|a |o )|outro banco|cancel|n[aã]o vou|espera|aguarde|ainda n[aã]o)/i;
const SIM = /^\s*(sim|s|pode|pode sim|pode seguir|pode dar andamento|pode prosseguir|quero|quero sim|quero seguir|confirmo|confirmado|autorizo|vamos|vamos sim|bora|isso|isso mesmo|com certeza|claro|ok|okay|beleza|t[aá] bom|tudo bem|combinado|fechado|👍)[\s!.,😊🙏👍]*$/i;
const SIM_FRASE = /\b(pode seguir|pode dar andamento|pode prosseguir|quero seguir|confirmo|autorizo|vamos seguir|quero sim|sim,? quero)\b/i;

/** Resposta do cliente: SIM claro / NÃO / outra coisa (não decide). Pura (testável). */
export function respostaSeguir(text: string): 'SIM' | 'NAO' | null {
  const t = String(text || '').trim();
  if (!t || t.length > 80) return null;
  if (NEGATIVA.test(t)) return 'NAO';
  if (SIM.test(t) || SIM_FRASE.test(t)) return 'SIM';
  return null;
}

type St = { status?: string; askedAt?: string; confirmedAt?: string; confirmedText?: string; proposalNumber?: string; detail?: string; teamAt?: string };

async function salva(leadId: string, patch: St) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  cf._interSeguir = { ...(cf._interSeguir || {}), ...patch };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}
const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };

/** Número da proposta do Inter aprovada que o cliente vai seguir (a mais recente). */
async function propostaInter(leadId: string): Promise<string | null> {
  const r = await prisma.creditAnalysis.findFirst({ where: { leadId, bank: 'INTER', dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] }, proposalNumber: { not: null } }, orderBy: { createdAt: 'desc' }, select: { proposalNumber: true } });
  return r?.proposalNumber || null;
}

/** Chamado pelo vigia da vistoria quando falta o e-mail de engajamento do Inter: pergunta ao cliente UMA vez (ou avisa a equipe se não puder). */
export async function ensureInterSeguir(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const st = (cf._interSeguir || {}) as St;
  if (cf._autoPaused || st.status) return; // já perguntado / respondido
  const numero = await propostaInter(leadId);
  if (!numero) return;
  const avisaEquipe = async (motivo: string) => {
    if (st.teamAt) return;
    await salva(leadId, { teamAt: new Date().toISOString() });
    await note(leadId, `🤝 Proposta do Inter ${numero} aprovada, aguardando o "Seguir com proposta" (aceite do cliente no portal; sem ele o Inter não manda o e-mail de engajamento e a vistoria não sai). ${motivo}`);
    push(accountId, '🤝 Seguir com proposta (Inter)', `${lead.name}: precisa da confirmação do cliente pra seguir com o Inter`, leadId);
  };
  if (!lead.aiAutoReplyActive) { await avisaEquipe('IA do card desligada: confirme com o cliente e clique em "Seguir com proposta" no portal.'); return; }
  if (!(await contractingAutoOn(accountId))) { await avisaEquipe('Automação da contratação desligada: confirme com o cliente e clique em "Seguir com proposta" no portal.'); return; }
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  if (!(await whatsappWindowOpen(leadId))) { await avisaEquipe('A janela de 24 h do WhatsApp está fechada: a pergunta sai assim que o cliente responder qualquer mensagem.'); return; }
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: interSeguirAskText(), io: io as any });
  if (!r.success) return;
  await salva(leadId, { status: 'ASKED', askedAt: new Date().toISOString(), proposalNumber: numero });
  await note(leadId, `🤝 Perguntei ao cliente se ele confirma seguir com a proposta do Inter (${numero}). Se responder SIM, a equipe recebe um aviso pra clicar em "Seguir com proposta" no portal.`);
}

/** Hook da mensagem recebida: resposta do cliente à pergunta do "Seguir". */
export async function onClientReply(accountId: string, leadId: string, text: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const st = ((lead?.customFields || {}) as Record<string, any>)._interSeguir as St | undefined;
  if (!lead || !st || st.status !== 'ASKED') return;
  const resp = respostaSeguir(text);
  if (!resp) return; // outra coisa: a IA da conversa responde; a pergunta segue valendo
  // a pergunta precisa ser a ÚLTIMA mensagem enviada (senão o "sim" pode estar respondendo outra coisa)
  const ultima = await prisma.message.findFirst({ where: { leadId, direction: 'OUTBOUND' }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  if (!ultima || !ultima.content.includes(MARCA)) return;
  if (resp === 'NAO') {
    await salva(leadId, { status: 'DECLINED', detail: text.slice(0, 120) });
    await note(leadId, `🤝 O cliente NÃO confirmou seguir com o Inter (“${text.slice(0, 120)}”). Nada foi feito no portal; fale com ele.`);
    push(accountId, '🤝 Cliente não confirmou o Inter', lead.name, leadId);
    return;
  }
  await salva(leadId, { status: 'CONFIRMED', confirmedAt: new Date().toISOString(), confirmedText: text.slice(0, 120) });
  await note(leadId, `✅ O cliente CONFIRMOU seguir com a proposta do Inter: “${text.slice(0, 120)}”. CLIQUE em "Seguir com proposta" no portal do Inter (proposta ${st.proposalNumber || ''}); o e-mail de engajamento chega em seguida e a vistoria sai sozinha.`);
  push(accountId, '✅ Cliente confirmou o Inter: clicar em Seguir', `${lead.name}: proposta ${st.proposalNumber || ''}`, leadId);
}
