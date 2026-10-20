import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { buildSharedAiContext, buildContextBlocks, CORE_RULES } from './ai-shared.service';
import { sendOutboundWhatsApp } from './message.service';
import { createKnowledgeEntry, deleteKnowledgeEntry, searchKnowledge } from './knowledge.service';
import { sendPushToAccount } from './push.service';
import { isVoyageConfigured } from './voyage.service';
import { logActivity } from './activity.service';

/**
 * Balão "Dúvidas da IA" (pedido do Fabio, 2026-09-25): quando a IA que
 * atende o cliente sozinha não sabe responder (falta informação, situação
 * específica do cliente), em vez de só encerrar ela diz ao cliente que vai
 * verificar e PERGUNTA pra equipe num chat interno. O colaborador responde
 * ali, a IA transforma a resposta numa mensagem pro cliente e manda pelo
 * WhatsApp — e, se a resposta for regra geral (vale pra outros clientes),
 * guarda na Base de Conhecimento do setor, pra da próxima vez já saber.
 */


type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

const SELECT = {
  id: true, leadId: true, departmentId: true, question: true, clientMessage: true, status: true,
  answer: true, answeredByName: true, answeredAt: true, sentReply: true, sendError: true,
  knowledgeEntryId: true, knowledgeTitle: true, createdAt: true, kind: true, callWhen: true, callAt: true, attachmentId: true, payload: true,
  lead: { select: { name: true } },
} as const;

/** Por enquanto TODO MUNDO da conta recebe e enxerga todas as dúvidas
 *  (Fabio 28/09: "por enquanto, manda as dúvidas para todos. Mais pra frente
 *  ajusto para encaminhar para cada usuário"). false = volta pro filtro por
 *  setor do card (abaixo). */
export const AI_QUESTIONS_FOR_EVERYONE = true;

/** Quem enxerga a dúvida: admin, quem não tem setor definido (enxerga tudo,
 *  mesma regra do resto do CRM) e quem é do setor do card. */
async function recipientsFor(accountId: string, departmentId: string | null): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { accountId }, select: { id: true, role: true, departmentIds: true } });
  return users
    .filter((u) => AI_QUESTIONS_FOR_EVERYONE || u.role === 'ADMIN' || !u.departmentIds.length || !departmentId || u.departmentIds.includes(departmentId))
    .map((u) => u.id);
}

function emitTo(io: Io, userIds: string[], event: string, payload: unknown) {
  if (!io) return;
  for (const id of userIds) io.to(`user_${id}`).emit(event, payload);
}

export async function createAiTeamQuestion(params: {
  accountId: string; leadId: string; question: string; clientMessage?: string | null; io?: Io;
}) {
  const { accountId, leadId, io } = params;
  const question = params.question.trim().slice(0, 1000);
  if (!question) return null;

  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    select: { name: true, pipeline: { select: { departmentId: true } } },
  });
  if (!lead) return null;
  const departmentId = lead.pipeline?.departmentId ?? null;

  // A IA às vezes reformula a mesma dúvida a cada mensagem do cliente — se
  // já tem uma aberta pra esse card, soma o contexto novo nela em vez de
  // abrir outra (o colaborador responde uma vez só).
  const open = await prisma.aiTeamQuestion.findFirst({ where: { accountId, leadId, status: 'OPEN', kind: 'QUESTION' }, orderBy: { createdAt: 'desc' } });
  const saved = open
    ? await prisma.aiTeamQuestion.update({
        where: { id: open.id },
        data: {
          question: open.question.includes(question) ? open.question : `${open.question}\n${question}`.slice(0, 2000),
          clientMessage: [open.clientMessage, params.clientMessage].filter(Boolean).join('\n').slice(0, 2000) || null,
        },
        select: SELECT,
      })
    : await prisma.aiTeamQuestion.create({
        data: { accountId, leadId, departmentId, question, clientMessage: params.clientMessage?.slice(0, 2000) || null },
        select: SELECT,
      });

  const userIds = await recipientsFor(accountId, departmentId);
  emitTo(io, userIds, 'ai_team_question', { id: saved.id, leadId, leadName: lead.name, question: saved.question, isNew: !open });
  if (!open) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 IA perguntou pra equipe (balão Dúvidas da IA): ${question}` } }).catch(() => {});
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `Dúvida da IA — ${lead.name}`, body: question.slice(0, 140), leadId }, userIds).catch(() => {});
    logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_team_question', leadId, leadName: lead.name, summary: `perguntou pra equipe: ${question.slice(0, 120)}` });
  }
  return saved;
}

/** Dúvida da IA sobre um DOCUMENTO do cliente (Fabio 14/10: "se tiver dúvida em algum, manda a pergunta pra nós — ele precisa trazer o documento em questão pra
 *  gente analisar"): abre no balão com o arquivo anexado (a equipe abre, analisa e responde). Uma pergunta por arquivo. A resposta NÃO vai pro cliente: a IA reconfere o
 *  documento com ela e, se for regra geral, passa a aplicar a regra nos próximos clientes. */
export async function createDocQuestion(params: { accountId: string; leadId: string; attachmentId: string; fileName: string; docType?: string; question: string; io?: Io }) {
  const { accountId, leadId, io } = params;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, pipeline: { select: { departmentId: true } } } });
  if (!lead) return null;
  const ja = await prisma.aiTeamQuestion.findFirst({ where: { accountId, leadId, attachmentId: params.attachmentId, kind: 'DOC_QUESTION' }, select: { id: true } });
  if (ja) return null;
  const question = `📎 ${params.docType ? `${params.docType} — ` : ''}${params.fileName}\n${params.question.trim()}`.slice(0, 1000);
  const departmentId = lead.pipeline?.departmentId ?? null;
  const saved = await prisma.aiTeamQuestion.create({
    data: { accountId, leadId, departmentId, question, kind: 'DOC_QUESTION', attachmentId: params.attachmentId },
    select: SELECT,
  });
  const userIds = await recipientsFor(accountId, departmentId);
  emitTo(io, userIds, 'ai_team_question', { id: saved.id, leadId, leadName: lead.name, question: saved.question, isNew: true });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 A IA ficou em dúvida sobre um documento (${params.docType || 'documento'}) e levou a pergunta pra equipe no balão "Dúvidas da IA": ${params.question.trim()}` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `Dúvida sobre documento — ${lead.name}`, body: params.question.trim().slice(0, 140), leadId }, userIds).catch(() => {});
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_team_question', leadId, leadName: lead.name, summary: `perguntou à equipe sobre um documento: ${params.question.trim().slice(0, 100)}` });
  return saved;
}

/** Dúvida da IA sobre a RESPOSTA do Jonatas (Creditas) por e-mail (Fabio 16/10): quando ele responde à nossa cobrança de posição e NÃO é o pedido do SCR Bacen, a IA leva pra equipe
 *  "o que devo fazer?". A resposta da equipe NÃO vai ao Jonatas: a IA decide (pedir o SCR ao cliente, avisar o cliente ou só registrar) e guarda a regra geral na Base de Conhecimento. */
export async function createEmailQuestion(params: { accountId: string; leadId: string; resumo: string; sugestao?: string; excerpt: string; messageId?: string; io?: Io }) {
  const { accountId, leadId, io } = params;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, pipeline: { select: { departmentId: true } } } });
  if (!lead) return null;
  const departmentId = lead.pipeline?.departmentId ?? null;
  // Mesma dúvida (mesmo e-mail, que chega em mais de uma caixa) já aberta pra este card: não repete.
  if (params.messageId) {
    const ja = await prisma.aiTeamQuestion.findFirst({ where: { accountId, leadId, kind: 'EMAIL_QUESTION', payload: { path: ['messageId'], equals: params.messageId } }, select: { id: true } });
    if (ja) return null;
  }
  const question = `📧 O Jonatas (Creditas) respondeu por e-mail sobre ${lead.name}: ${params.resumo.trim()}${params.sugestao ? `\n💡 Minha sugestão: ${params.sugestao.trim()}` : ''}\nO que devo fazer?`.slice(0, 1000);
  const saved = await prisma.aiTeamQuestion.create({
    data: { accountId, leadId, departmentId, question, kind: 'EMAIL_QUESTION', clientMessage: params.excerpt.slice(0, 2000) || null, ...(params.messageId ? { payload: { messageId: params.messageId } } : {}) },
    select: SELECT,
  });
  const userIds = await recipientsFor(accountId, departmentId);
  emitTo(io, userIds, 'ai_team_question', { id: saved.id, leadId, leadName: lead.name, question: saved.question, isNew: true });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 O Jonatas (Creditas) respondeu por e-mail e NÃO é o pedido do SCR Bacen: levei pra equipe no balão "Dúvidas da IA" (${params.resumo.trim().slice(0, 200)}).` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `Creditas respondeu — ${lead.name}`, body: params.resumo.trim().slice(0, 140), leadId }, userIds).catch(() => {});
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_team_question', leadId, leadName: lead.name, summary: `perguntou à equipe sobre o e-mail do Jonatas: ${params.resumo.trim().slice(0, 100)}` });
  return saved;
}

/** O que a equipe quis dizer com a resposta sobre o e-mail do Jonatas: pedir o SCR ao cliente, avisar o cliente de algo, ou só registrar. + regra geral (aprendizado). */
async function interpretEmailAnswer(question: string, emailExcerpt: string, answer: string): Promise<{ acao: 'PEDIR_BACEN' | 'AVISAR_CLIENTE' | 'SO_REGISTRAR'; regra: { title: string; content: string } | null }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { acao: 'SO_REGISTRAR', regra: null };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 3000,
        system: `Você apoia a A&F Soluções Financeiras (correspondente bancária). O Jonatas, do suporte da Creditas, respondeu por e-mail sobre a análise de crédito de um cliente e a equipe disse o que fazer. Interprete a resposta da equipe. Responda SÓ JSON: {"acao":"PEDIR_BACEN|AVISAR_CLIENTE|SO_REGISTRAR","regra":{"title":"...","content":"..."} ou null}. PEDIR_BACEN = a equipe mandou pedir ao cliente a Autorização SCR Bacen assinada (e identidades). AVISAR_CLIENTE = a equipe quer que o cliente receba uma informação/pedido pelo WhatsApp (ex.: mandar um documento, avisar que o crédito foi negado). SO_REGISTRAR = nada a fazer com o cliente agora (esperar, ou a equipe cuida). "regra" só quando a resposta é uma orientação GERAL pra casos parecidos no futuro (ex.: "quando o Jonatas disser X, faça Y"); title curto e content com a regra em 1–3 frases; senão null.`,
        messages: [{ role: 'user', content: `Pergunta que a IA fez:\n${question}\n\nTrecho do e-mail do Jonatas:\n${emailExcerpt.slice(0, 1500)}\n\nResposta da equipe:\n${answer}` }],
      }),
    });
    if (!res.ok) return { acao: 'SO_REGISTRAR', regra: null };
    const d: any = await res.json();
    const m = String(d?.content?.find((b: any) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/);
    if (!m) return { acao: 'SO_REGISTRAR', regra: null };
    const j = JSON.parse(m[0]);
    const acao = ['PEDIR_BACEN', 'AVISAR_CLIENTE', 'SO_REGISTRAR'].includes(j.acao) ? j.acao : 'SO_REGISTRAR';
    const r = j.regra;
    return { acao, regra: r && typeof r.title === 'string' && typeof r.content === 'string' && r.title.trim() && r.content.trim() ? { title: r.title.trim().slice(0, 200), content: r.content.trim().slice(0, 2000) } : null };
  } catch { return { acao: 'SO_REGISTRAR', regra: null }; }
}

/** A mensagem composta pela IA anuncia APROVAÇÃO de crédito com números? (nunca vai em texto livre) */
export function anunciaAprovacao(text: string): boolean {
  const t = String(text || '');
  return /(pr[eé][-\s]?aprovad|cr[eé]dito[^.\n]{0,30}aprovad|aprovad[oa][^.\n]{0,30}(creditas|santander|inter|banco))/i.test(t) && /R\$\s*[\d.]+(,\d{2})?|\d+\s*meses|parcela/i.test(t);
}

/** AVISAR_CLIENTE sobre a aprovação: registra a pré-aprovação que veio por e-mail (se ainda não está no card) e manda o aviso de aprovação do CRM — dentro da janela de 24 h o texto com as condições,
 *  fora dela o template "ver condições" (o texto completo sai quando o cliente tocar em "Sim, quero saber"). null = não há aprovação pra avisar: segue o fluxo normal. */
async function avisarAprovacaoPeloCrm(q: { id: string; accountId: string; leadId: string; departmentId: string | null; question: string }, answer: string, userId: string, userName: string | null, io: Io) {
  const { backfillPreApprovals } = require('./creditas-preapproval.service') as typeof import('./creditas-preapproval.service');
  const { previewApprovalNotice, sendApprovalNoticeNow } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  await backfillPreApprovals(q.accountId, q.leadId, io).catch((e: any) => console.warn('[Dúvidas da IA] pré-aprovação do e-mail:', e?.message));
  const preview = await previewApprovalNotice(q.leadId).catch(() => null);
  if (!preview) return null;
  const out = await sendApprovalNoticeNow({ accountId: q.accountId, leadId: q.leadId, userId, io });
  if (!out.ok && !out.already) {
    const updated = await prisma.aiTeamQuestion.update({ where: { id: q.id }, data: { answer, answeredByUserId: userId, answeredByName: userName, sendError: out.error || 'Não consegui avisar o cliente' }, select: SELECT });
    emitTo(io, await recipientsFor(q.accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
    return updated;
  }
  const feito = out.already ? 'o cliente já tinha o aviso da aprovação na conversa (nada foi reenviado)' : out.scheduled ? 'aviso da aprovação agendado (sai no próximo horário de envio, 07h–21h)' : (out as any).via === 'template' || preview.mode === 'template' ? 'aprovação registrada e template "ver condições" enviado ao cliente (a janela de 24 h estava fechada)' : 'aprovação registrada e aviso com as condições enviado ao cliente';
  const updated = await prisma.aiTeamQuestion.update({ where: { id: q.id }, data: { status: 'ANSWERED', answer, answeredByUserId: userId, answeredByName: userName, answeredAt: new Date(), sendError: null, sentReply: feito }, select: SELECT });
  await prisma.note.create({ data: { leadId: q.leadId, type: 'COMMENT', content: `Dúvida do e-mail do Jonatas respondida por ${userName || 'alguém da equipe'}: ${answer}\n🤖 ${feito}.` } }).catch(() => {});
  logActivity({ accountId: q.accountId, userId, action: 'ai_team_answered', leadId: q.leadId, summary: 'respondeu a dúvida da IA sobre o e-mail da Creditas: avisou a aprovação' });
  emitTo(io, await recipientsFor(q.accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
  return updated;
}

async function answerEmailQuestion(q: { id: string; accountId: string; leadId: string; departmentId: string | null; question: string }, answer: string, acao: 'PEDIR_BACEN' | 'SO_REGISTRAR', regra: { title: string; content: string } | null, userId: string, userName: string | null, io: Io) {
  let feito = 'a IA só registrou (nada foi enviado ao cliente)';
  if (acao === 'PEDIR_BACEN') {
    const { startScrFromTeam } = require('./creditas-scr.service') as typeof import('./creditas-scr.service');
    const r = await startScrFromTeam(q.accountId, q.leadId).catch((e: any) => ({ ok: false, why: e?.message || String(e) }));
    feito = r.ok ? 'a IA abriu o pedido do SCR Bacen: o formulário vai ao cliente' : `a IA não conseguiu abrir o pedido do SCR (${(r as any).why}) — peça ao cliente à mão`;
  }
  let knowledgeTitle: string | null = null;
  if (regra && isVoyageConfigured()) {
    try { const entry = await createKnowledgeEntry(q.accountId, { ...regra, departmentId: q.departmentId }); knowledgeTitle = entry.title; } catch (e) { console.error('[Dúvidas da IA] Não salvou na Base de Conhecimento:', e); }
  }
  const updated = await prisma.aiTeamQuestion.update({
    where: { id: q.id },
    data: { status: 'ANSWERED', answer, answeredByUserId: userId, answeredByName: userName, answeredAt: new Date(), sendError: null, sentReply: feito, knowledgeTitle },
    select: SELECT,
  });
  await prisma.note.create({ data: { leadId: q.leadId, type: 'COMMENT', content: `Dúvida do e-mail do Jonatas respondida por ${userName || 'alguém da equipe'}: ${answer}\n🤖 ${feito}.${knowledgeTitle ? `\n📚 Guardado na Base de Conhecimento: ${knowledgeTitle}` : ''}` } }).catch(() => {});
  logActivity({ accountId: q.accountId, userId, action: 'ai_team_answered', leadId: q.leadId, summary: 'respondeu uma dúvida da IA sobre o e-mail da Creditas' });
  emitTo(io, await recipientsFor(q.accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
  return updated;
}

/** Reprovação automática por motivo que pode ser TEMPORÁRIO (saldo devedor, imóvel abaixo do mínimo…): ANTES de avisar o cliente e mover o card, a IA pergunta pra equipe pra onde vai
 *  (Venda Futura com data x Perdidos) — Fabio 16/10: "antes manda pergunta pra nós na caixa da IA, pra respondermos e ele ir aprendendo". Nada vai pro cliente até a resposta. */
export async function createRejectionQuestion(params: { accountId: string; leadId: string; reasons: string[]; io?: Io }) {
  const { accountId, leadId, io } = params;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, pipeline: { select: { departmentId: true } } } });
  if (!lead) return null;
  const ja = await prisma.aiTeamQuestion.findFirst({ where: { accountId, leadId, kind: 'REJECTION_QUESTION', status: 'OPEN' }, select: { id: true } });
  if (ja) return null;
  const departmentId = lead.pipeline?.departmentId ?? null;
  const motivos = params.reasons.join('; ');
  const question = `📉 ${lead.name} foi reprovado pelos bancos por um motivo que pode ser TEMPORÁRIO: ${motivos}.\nPra onde vai o card? "Venda Futura" (a IA avisa a negativa, pergunta a melhor data pra tentar de novo e move o card) ou "Perdidos" (segue como hoje)?`.slice(0, 1000);
  const saved = await prisma.aiTeamQuestion.create({ data: { accountId, leadId, departmentId, question, kind: 'REJECTION_QUESTION', clientMessage: motivos.slice(0, 1000) }, select: SELECT });
  const userIds = await recipientsFor(accountId, departmentId);
  emitTo(io, userIds, 'ai_team_question', { id: saved.id, leadId, leadName: lead.name, question: saved.question, isNew: true });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🤖 Reprovado por motivo que pode ser temporário (${motivos}): perguntei à equipe no balão "Dúvidas da IA" se vai pra Venda Futura ou Perdidos. O card fica na Pré-Análise até a resposta.` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `Reprovação — ${lead.name}`, body: 'Venda Futura ou Perdidos? A IA precisa da sua resposta', leadId }, userIds).catch(() => {});
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_team_question', leadId, leadName: lead.name, summary: `perguntou à equipe: reprovação temporária (${motivos.slice(0, 80)})` });
  return saved;
}

async function interpretRejectionAnswer(question: string, answer: string): Promise<{ acao: 'VENDA_FUTURA' | 'PERDIDO' | null; regra: { title: string; content: string } | null }> {
  const t = answer.toLowerCase();
  const rx: 'VENDA_FUTURA' | 'PERDIDO' | null = /venda futura|perguntar a data|tentar de novo|retomar/.test(t) && !/n[aã]o.{0,12}venda futura/.test(t) ? 'VENDA_FUTURA' : /perdid|encerr|desqualific/.test(t) ? 'PERDIDO' : null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { acao: rx, regra: null };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 3000,
        system: `A IA da A&F Soluções Financeiras (correspondente bancária) perguntou à equipe pra onde vai um card reprovado pelos bancos por motivo possivelmente temporário. Interprete a resposta da equipe. Responda SÓ JSON: {"acao":"VENDA_FUTURA|PERDIDO|null","regra":{"title":"...","content":"..."} ou null}. VENDA_FUTURA = o cliente é qualificado e pode tentar de novo depois (a IA pergunta a melhor data e o card vai pra Venda Futura). PERDIDO = encerrar como hoje. null = a resposta não decide. "regra" só se a resposta vale pra casos PARECIDOS no futuro (ex.: "reprovado por saldo devedor → Venda Futura"); title curto (cite o motivo da reprovação) e content com a regra em 1–2 frases dizendo explicitamente "Venda Futura" ou "Perdidos"; senão null.`,
        messages: [{ role: 'user', content: `Pergunta:\n${question}\n\nResposta da equipe:\n${answer}` }],
      }),
    });
    if (!res.ok) return { acao: rx, regra: null };
    const d: any = await res.json();
    const m = String(d?.content?.find((b: any) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/);
    if (!m) return { acao: rx, regra: null };
    const j = JSON.parse(m[0]);
    const acao = j.acao === 'VENDA_FUTURA' || j.acao === 'PERDIDO' ? j.acao : rx;
    const r = j.regra;
    return { acao, regra: r && typeof r.title === 'string' && typeof r.content === 'string' && r.title.trim() && r.content.trim() ? { title: r.title.trim().slice(0, 200), content: r.content.trim().slice(0, 2000) } : null };
  } catch { return { acao: rx, regra: null }; }
}

async function answerRejectionQuestion(q: { id: string; accountId: string; leadId: string; departmentId: string | null; question: string }, answer: string, userId: string, userName: string | null, io: Io) {
  const dec = await interpretRejectionAnswer(q.question, answer);
  if (!dec.acao) throw new Error('Não entendi pra onde vai o card. Responda "Venda Futura" ou "Perdidos" (e, se quiser, o motivo).');
  const f = await prisma.lead.findUnique({ where: { id: q.leadId }, select: { customFields: true } });
  const cf: Record<string, any> = { ...((f?.customFields || {}) as Record<string, any>), _rejDecision: dec.acao, _rejDecisionBy: userName || 'equipe' };
  await prisma.lead.update({ where: { id: q.leadId }, data: { customFields: cf as any } });
  let knowledgeTitle: string | null = null;
  if (dec.regra && isVoyageConfigured()) {
    try { const entry = await createKnowledgeEntry(q.accountId, { ...dec.regra, departmentId: q.departmentId }); knowledgeTitle = entry.title; } catch (e) { console.error('[Dúvidas da IA] Não salvou na Base de Conhecimento:', e); }
  }
  const feito = dec.acao === 'VENDA_FUTURA' ? 'o CRM vai avisar a negativa ao cliente, perguntar a melhor data pra tentar de novo e mover o card pra Venda Futura (em até 1 min)' : 'o CRM segue o fluxo normal: avisa a negativa e move o card pra Perdidos (em até 1 min)';
  const updated = await prisma.aiTeamQuestion.update({
    where: { id: q.id },
    data: { status: 'ANSWERED', answer, answeredByUserId: userId, answeredByName: userName, answeredAt: new Date(), sendError: null, sentReply: feito, knowledgeTitle },
    select: SELECT,
  });
  await prisma.note.create({ data: { leadId: q.leadId, type: 'COMMENT', content: `Dúvida da reprovação respondida por ${userName || 'alguém da equipe'}: ${answer}\n🤖 ${feito}.${knowledgeTitle ? `\n📚 Aprendi: ${knowledgeTitle}` : ''}` } }).catch(() => {});
  logActivity({ accountId: q.accountId, userId, action: 'ai_team_answered', leadId: q.leadId, summary: `respondeu a dúvida da reprovação (${dec.acao === 'VENDA_FUTURA' ? 'Venda Futura' : 'Perdidos'})` });
  emitTo(io, await recipientsFor(q.accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
  return updated;
}

// ───────────────────────── E-mail a banco (Vania/Jonatas) só com autorização ─────────────────────────
// Fabio 17/10 (Admir, 75 anos): o CRM escreveu à Vania e ao Jonatas pedindo retorno de um cliente que nem tinha idade pro crédito. Agora, ANTES de qualquer e-mail
// automático a banco, o CRM abre uma dúvida no balão com os dados do cliente e o e-mail pronto; só envia quando a equipe autoriza. A explicação vira regra na
// Base de Conhecimento — e uma regra já ensinada decide sozinha (pode enviar / não envie) nos próximos casos parecidos.

export interface BankEmailDraft {
  bank: 'INTER' | 'CREDITAS'; empresa: string; quem: string; flag: string; emailAccountId: string; userId: string | null;
  to: string; cc: string[]; subject: string; body: string; motivo: string; nota: string; pushBody: string;
}

const idadeDe = (raw: unknown): number | null => {
  const m = String(raw ?? '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/) || String(raw ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [d, mo, y] = String(raw).includes('/') ? [Number(m[1]), Number(m[2]), Number(m[3])] : [Number(m[3]), Number(m[2]), Number(m[1])];
  if (!y || y < 1900) return null;
  const hoje = new Date(Date.now() - 3 * 3_600_000);
  let a = hoje.getUTCFullYear() - y;
  if (hoje.getUTCMonth() + 1 < mo || (hoje.getUTCMonth() + 1 === mo && hoje.getUTCDate() < d)) a--;
  return a;
};

/** Os dados do cliente pra equipe decidir: ficha, idade (com alerta), pedido, etapa e o que cada banco respondeu. */
async function resumoDoCliente(leadId: string): Promise<string> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true, value: true, stage: { select: { name: true } }, stageEnteredAt: true, creditAnalyses: { where: { dryRun: false }, orderBy: { createdAt: 'desc' }, take: 30, select: { bank: true, status: true, kind: true, detail: true, createdAt: true, proposalNumber: true } } } });
  if (!lead) return '';
  const cf = (lead.customFields || {}) as Record<string, any>;
  const idade1 = idadeDe(cf.nascimento_1);
  const idade2 = idadeDe(cf.nascimento_2);
  const alertas: string[] = [];
  if (idade1 !== null && (idade1 > 69 || idade1 < 18)) alertas.push(`⚠️ IDADE ${idade1} anos: o Inter só aceita de 18 a 69.`);
  if (idade1 !== null && idade1 >= 70) alertas.push(`⚠️ Santander: idade + prazo não pode passar de 80 anos (com ${idade1} anos o prazo máximo fica curto).`);
  const brl = (v: unknown) => (Number(v) > 0 ? `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '');
  const linhas = [
    `👤 ${String(cf.participante_1 || lead.name)} — CPF ${cf.cpf_1 || '—'} — nascimento ${cf.nascimento_1 || '—'}${idade1 !== null ? ` (${idade1} anos)` : ''}`,
    cf.participante_2 ? `👥 2º participante: ${cf.participante_2} — CPF ${cf.cpf_2 || '—'} — nascimento ${cf.nascimento_2 || '—'}${idade2 !== null ? ` (${idade2} anos)` : ''}` : '',
    [cf.telefone_1 && `📞 ${cf.telefone_1}`, cf.email_1 && `✉️ ${cf.email_1}`, cf.renda_1 && `💵 renda ${brl(cf.renda_1) || cf.renda_1}`].filter(Boolean).join(' · '),
    [brl(cf.valor_credito) && `Crédito pedido ${brl(cf.valor_credito)}`, brl(cf.valor_imovel) && `imóvel ${brl(cf.valor_imovel)}`, cf.prazo_financ && `prazo ${cf.prazo_financ}`].filter(Boolean).join(' · '),
    `📍 Etapa: ${lead.stage?.name || '—'}`,
  ].filter(Boolean);
  const rotulo: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
  const vistos = new Set<string>();
  const bancos: string[] = [];
  for (const r of lead.creditAnalyses) {
    if (vistos.has(r.bank)) continue; vistos.add(r.bank);
    const det = String(r.detail || '').replace(/Titular na análise:[^.]*\.\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    bancos.push(`• ${rotulo[r.bank] || r.bank}: ${r.status}${r.proposalNumber ? ` (proposta ${r.proposalNumber})` : ''}${det ? ` — ${det}` : ''}`);
  }
  return `${alertas.length ? alertas.join('\n') + '\n\n' : ''}DADOS DO CLIENTE\n${linhas.join('\n')}${bancos.length ? `\n\nO QUE OS BANCOS RESPONDERAM\n${bancos.join('\n')}` : ''}`;
}

/** Regra que a equipe já ENSINOU sobre e-mail aos bancos. 'ENVIAR' | 'NAO_ENVIAR' | null (sem regra clara → pergunta). */
async function regraDeEmailBanco(accountId: string, leadId: string, p: { empresa: string; motivo: string }, resumo: string): Promise<'ENVIAR' | 'NAO_ENVIAR' | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { pipeline: { select: { departmentId: true } } } });
  const hits = await searchKnowledge(accountId, `e-mail ao banco ${p.empresa} Vania Jonatas pedir retorno enviar não enviar`, 6, lead?.pipeline?.departmentId ?? null).catch(() => []);
  const regras = hits.filter((h) => /e-?mail/i.test(h.content) && /vania|jonatas|banco|inter|creditas/i.test(h.content) && /(enviar|envie|mande|mandar|escrever)/i.test(h.content));
  if (!regras.length) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 2000,
      system: 'Decida se o CRM pode enviar um e-mail de cobrança a um banco (gestora/suporte), SÓ com base nas regras da equipe abaixo. Responda SÓ JSON: {"acao":"ENVIAR|NAO_ENVIAR|PERGUNTAR"}. Use PERGUNTAR se nenhuma regra cobre claramente ESTE caso (na dúvida, PERGUNTAR). ENVIAR só se uma regra autoriza este tipo de caso; NAO_ENVIAR só se uma regra manda não enviar este tipo de caso.',
      messages: [{ role: 'user', content: `E-mail a: ${p.empresa}\nMotivo: ${p.motivo}\n\nDados do cliente:\n${resumo.slice(0, 2500)}\n\nRegras da equipe:\n${regras.map((r) => `- ${r.content.slice(0, 500)}`).join('\n')}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const d: any = await res.json().catch(() => null);
  const m = String(d?.content?.find((b: any) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/);
  try { const j = m ? JSON.parse(m[0]) : null; return j?.acao === 'ENVIAR' || j?.acao === 'NAO_ENVIAR' ? j.acao : null; } catch { return null; }
}

/** Escreve de fato ao banco (depois da autorização ou por regra) — mesma ação que o envio automático sempre fez. */
async function enviarEmailAoBanco(d: BankEmailDraft, leadId: string, accountId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const acc = await prisma.emailAccount.findUnique({ where: { id: d.emailAccountId } });
    if (!acc) return { ok: false, error: 'conta de e-mail não encontrada' };
    const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
    await sendEmailFrom({ acc, userId: d.userId || acc.userId, to: [d.to], cc: d.cc, subject: d.subject, body: d.body, leadId, io: null });
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: d.nota } }).catch(() => {});
    sendPushToAccount(accountId, { title: 'E-mail enviado', body: d.pushBody, leadId }).catch(() => {});
    return { ok: true };
  } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
}

async function marcarCard(leadId: string, patch: Record<string, any>) {
  const f = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((f?.customFields || {}) as Record<string, any>), ...patch } as any } });
}

/** Ponto de entrada do CRM: no lugar de enviar o e-mail ao banco, decide (regra ensinada) ou pergunta à equipe. Devolve o que aconteceu. */
export async function requestBankEmail(params: { accountId: string; leadId: string; leadName: string; draft: BankEmailDraft; io?: Io }): Promise<'enviado' | 'regra-nao-enviar' | 'perguntado' | 'ja-perguntado' | 'erro'> {
  const { accountId, leadId, leadName, draft, io } = params;
  const aberta = await prisma.aiTeamQuestion.findFirst({ where: { accountId, leadId, kind: 'BANK_EMAIL', status: 'OPEN' }, select: { id: true, payload: true } });
  if (aberta && (aberta.payload as any)?.bank === draft.bank) return 'ja-perguntado';
  await marcarCard(leadId, { [draft.flag]: new Date().toISOString() }); // marca já: não pergunta de novo a cada minuto
  const resumo = await resumoDoCliente(leadId);
  const regra = await regraDeEmailBanco(accountId, leadId, { empresa: draft.empresa, motivo: draft.motivo }, resumo).catch(() => null);
  if (regra === 'NAO_ENVIAR') {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🚫 NÃO escrevi ao ${draft.empresa} (${draft.quem}) — ${draft.motivo}: pela regra que a equipe já ensinou, esse tipo de caso não recebe e-mail ao banco.` } }).catch(() => {});
    return 'regra-nao-enviar';
  }
  if (regra === 'ENVIAR') {
    const r = await enviarEmailAoBanco(draft, leadId, accountId);
    if (!r.ok) { await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ Regra da equipe mandava escrever ao ${draft.empresa}, mas o e-mail NÃO saiu (${r.error}). Mande à mão para ${draft.to}.` } }).catch(() => {}); return 'erro'; }
    return 'enviado';
  }
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { pipeline: { select: { departmentId: true } } } });
  const departmentId = lead?.pipeline?.departmentId ?? null;
  const preview = `Para: ${draft.to}${draft.cc.length ? ` (cc ${draft.cc.join(', ')})` : ''}\nAssunto: ${draft.subject}\n\n${draft.body.length > 900 ? draft.body.slice(0, 900) + '…' : draft.body}`;
  const question = `📧 Posso escrever ao ${draft.empresa} (${draft.quem}) sobre ${leadName}?\nMotivo: ${draft.motivo}.\n\n${resumo}\n\n— E-MAIL PRONTO —\n${preview}\n\nResponda "pode enviar" ou "não envie" e explique o porquê: a IA guarda como regra e não pergunta de novo nos casos parecidos.`;
  const saved = await prisma.aiTeamQuestion.create({ data: { accountId, leadId, departmentId, question, kind: 'BANK_EMAIL', clientMessage: draft.motivo.slice(0, 500), payload: { ...draft, leadName } as any }, select: SELECT });
  const userIds = await recipientsFor(accountId, departmentId);
  emitTo(io, userIds, 'ai_team_question', { id: saved.id, leadId, leadName, question: saved.question, isNew: true });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⏳ O CRM ia escrever ao ${draft.empresa} (${draft.motivo}), mas agora espera a sua autorização no balão "Dúvidas da IA" (com os dados do cliente e o e-mail pronto). Nada foi enviado.` } }).catch(() => {});
  sendPushToAccount(accountId, { title: `E-mail ao ${draft.empresa} — ${leadName}`, body: 'Autoriza o envio? Os dados do cliente estão no balão', leadId }, userIds).catch(() => {});
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_team_question', leadId, leadName, summary: `pediu autorização para escrever ao ${draft.empresa}` });
  return 'perguntado';
}

async function interpretBankEmailAnswer(question: string, answer: string): Promise<{ acao: 'ENVIAR' | 'NAO_ENVIAR' | null; regra: { title: string; content: string } | null }> {
  const t = answer.toLowerCase();
  const nao = /\bn[aã]o\b.{0,20}(envi|mand|escrev)|cancel|n[aã]o precisa|nem (envi|mand)|descart/.test(t);
  const sim = /(pode|autoriz|libero|envi|mand|escrev|ok\b|sim\b)/.test(t);
  const rx: 'ENVIAR' | 'NAO_ENVIAR' | null = nao ? 'NAO_ENVIAR' : sim ? 'ENVIAR' : null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { acao: rx, regra: null };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5', max_tokens: 3000,
        system: `A IA da A&F Soluções Financeiras (correspondente bancária) pediu autorização à equipe para escrever a um banco (Vania do Inter / Jonatas da Creditas) pedindo retorno de um cliente. Interprete a resposta. Responda SÓ JSON: {"acao":"ENVIAR|NAO_ENVIAR|null","regra":{"title":"...","content":"..."}|null}. acao: ENVIAR se a equipe autoriza o envio; NAO_ENVIAR se manda não enviar; null se não deu pra entender. regra: SÓ se a equipe deu uma explicação que vale para casos parecidos (ex.: idade fora do limite dos bancos, imóvel que não atende, quando vale ou não cobrar o banco); escreva em português, GERAL, SEM nome, CPF, valor ou dado de cliente; title = pergunta curta começando por "E-mail aos bancos:"; content = a regra em 1 a 3 frases dizendo QUANDO enviar e QUANDO NÃO enviar e que se trata de e-mail ao banco (Vania/Jonatas). Sem explicação geral: regra null.`,
        messages: [{ role: 'user', content: `Pergunta:\n${question.slice(0, 3000)}\n\nResposta da equipe:\n${answer}` }],
      }),
    });
    if (!res.ok) return { acao: rx, regra: null };
    const d: any = await res.json();
    const m = String(d?.content?.find((b: any) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/);
    if (!m) return { acao: rx, regra: null };
    const j = JSON.parse(m[0]);
    const acao = j.acao === 'ENVIAR' || j.acao === 'NAO_ENVIAR' ? j.acao : rx;
    const r = j.regra;
    return { acao, regra: r && typeof r.title === 'string' && typeof r.content === 'string' && r.title.trim() && r.content.trim() ? { title: r.title.trim().slice(0, 200), content: r.content.trim().slice(0, 2000) } : null };
  } catch { return { acao: rx, regra: null }; }
}

async function answerBankEmailQuestion(q: { id: string; accountId: string; leadId: string; departmentId: string | null; question: string; payload: unknown }, answer: string, userId: string, userName: string | null, io: Io) {
  const dec = await interpretBankEmailAnswer(q.question, answer);
  if (!dec.acao) throw new Error('Não entendi. Responda "pode enviar" ou "não envie" (e explique o porquê, que a IA guarda como regra).');
  const draft = q.payload as BankEmailDraft | null;
  if (!draft || !draft.to) throw new Error('O rascunho do e-mail se perdeu — peça de novo ou escreva à mão.');
  let feito: string;
  if (dec.acao === 'ENVIAR') {
    const r = await enviarEmailAoBanco(draft, q.leadId, q.accountId);
    if (!r.ok) throw new Error(`O e-mail não saiu (${r.error}). Tente de novo ou escreva à mão para ${draft.to}.`);
    feito = `e-mail enviado ao ${draft.empresa} (${draft.to})`;
  } else {
    await prisma.note.create({ data: { leadId: q.leadId, type: 'COMMENT', content: `🚫 E-mail ao ${draft.empresa} NÃO enviado por decisão de ${userName || 'alguém da equipe'}: ${answer}` } }).catch(() => {});
    feito = `não escrevi ao ${draft.empresa}`;
  }
  let knowledgeTitle: string | null = null;
  if (dec.regra && isVoyageConfigured()) {
    try { const entry = await createKnowledgeEntry(q.accountId, { ...dec.regra, departmentId: q.departmentId }); knowledgeTitle = entry.title; } catch (e) { console.error('[Dúvidas da IA] Não salvou na Base de Conhecimento:', e); }
  }
  const updated = await prisma.aiTeamQuestion.update({
    where: { id: q.id },
    data: { status: 'ANSWERED', answer, answeredByUserId: userId, answeredByName: userName, answeredAt: new Date(), sendError: null, sentReply: feito, knowledgeTitle },
    select: SELECT,
  });
  await prisma.note.create({ data: { leadId: q.leadId, type: 'COMMENT', content: `Autorização do e-mail ao banco respondida por ${userName || 'alguém da equipe'}: ${answer}\n🤖 ${feito}.${knowledgeTitle ? `\n📚 Aprendi: ${knowledgeTitle}` : ''}` } }).catch(() => {});
  logActivity({ accountId: q.accountId, userId, action: 'ai_team_answered', leadId: q.leadId, summary: `respondeu a autorização do e-mail ao ${draft.empresa} (${dec.acao === 'ENVIAR' ? 'enviar' : 'não enviar'})` });
  emitTo(io, await recipientsFor(q.accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
  return updated;
}

/** Dúvidas que o usuário enxerga: todas as abertas + as respondidas nos
 *  últimos 7 dias (histórico curto, o balão não é arquivo). */
export async function listAiTeamQuestions(accountId: string, scopeDepartmentIds: string[]) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await prisma.aiTeamQuestion.findMany({
    where: {
      accountId,
      OR: [{ status: 'OPEN' }, { createdAt: { gte: since } }],
      ...(scopeDepartmentIds.length ? { AND: [{ OR: [{ departmentId: null }, { departmentId: { in: scopeDepartmentIds } }] }] } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 60,
    select: SELECT,
  });
  // Dúvida de documento: devolve o arquivo em questão pro balão mostrar/abrir.
  const attIds = rows.map((r) => r.attachmentId).filter((x): x is string => !!x);
  const atts = attIds.length ? await prisma.messageAttachment.findMany({ where: { id: { in: attIds } }, select: { id: true, fileName: true, mimeType: true } }) : [];
  const byId = new Map(atts.map((a) => [a.id, a]));
  return rows.map((r) => ({ ...r, attachment: r.attachmentId ? byId.get(r.attachmentId) || null : null }));
}

/** Perguntas abertas / respostas recentes da equipe sobre ESTE card — entra
 *  no prompt da IA pra ela não inventar nem perguntar de novo o mesmo. */
export async function teamQuestionsContext(leadId: string): Promise<string> {
  const rows = await prisma.aiTeamQuestion.findMany({
    where: { leadId, kind: { not: 'DOC_QUESTION' }, OR: [{ status: 'OPEN' }, { status: 'ANSWERED', answeredAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }] },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { status: true, question: true, answer: true, kind: true, callWhen: true },
  });
  if (!rows.length) return '';
  const lines = rows.map((r) => r.kind === 'CALL_REQUEST'
    ? (r.status === 'OPEN'
      ? `- LIGAÇÃO: o cliente pediu ligação (${r.callWhen}) e você ainda está confirmando o horário — se ele perguntar, diga que já já confirma; não prometa o horário.`
      : `- LIGAÇÃO: ${r.answer}`)
    : r.status === 'OPEN'
    ? `- AINDA SEM RESPOSTA: ${r.question}`
    : `- Pergunta: ${r.question}\n  Resposta da equipe: ${r.answer}`);
  return `--- DÚVIDAS DESTE CLIENTE QUE VOCÊ JÁ LEVOU PRA EQUIPE ---
${lines.join('\n')}
Se o cliente voltar num assunto ainda sem resposta, não responda nada sobre ele ("noReply": true) — a resposta chega pelo balão; não abra outra pergunta nem invente. Se ele trouxer outro assunto, responda o outro. Respostas da equipe valem como verdade pra este cliente.`;
}

export async function composeClientReply(accountId: string, leadId: string, question: string, answer: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada');
  const ctx = await buildSharedAiContext(accountId, leadId, `${question}\n${answer}`, {
    historyTake: 12, historyRoleLabels: { inbound: 'Cliente', outbound: 'Atendente' },
  });
  if (!ctx) throw new Error('Card não encontrado');

  const system = `Você atende clientes da A&F Soluções Financeiras pelo WhatsApp. Você tinha dito ao cliente que ia verificar uma dúvida com a equipe; a equipe respondeu pelo chat interno do CRM. Agora:
0. NUNCA anuncie aprovação de crédito nem escreva valores/prazos/parcelas aprovados: isso o CRM envia pelo aviso padrão (se a equipe mandou "avisar da aprovação", escreva só uma frase curta dizendo que o resumo da aprovação segue em seguida).
1. Escreva a mensagem pro cliente passando a resposta da equipe — fiel ao que a equipe disse (não acrescente fato, valor, prazo ou promessa que não esteja na resposta), no tom da conversa, curta. Não conte que perguntou pra equipe nem cite nomes; só dê a resposta, como quem voltou com a informação. Se a resposta da equipe tiver comentário interno sobre o cliente, não repasse — só a informação que responde a dúvida.
1b. EMISSÃO DE DOCUMENTOS (Fabio 19/10): a A&F emite certidões/documentos e você pode dizer isso, mas só no horário comercial (veja "HORÁRIO AGORA" no contexto). DENTRO: pode dizer que a gente vai emitir e que envia assim que sair. FORA: diga só que consegue emitir (sem citar o nome da empresa), sem "vou emitir agora", "já te envio", "te mando assim que sair" nem "só um instante". Nunca prometa horário. Se o cliente já mandou o documento que a equipe pediu, só agradeça e siga. NUNCA diga que algo que o cliente mandou "não serve"/"não é esse"/"não a guia" se a equipe não disse isso com todas as letras (no IPTU do Home Equity a guia, o carnê ou a capa já servem).
2. Decida se a resposta é uma REGRA GERAL que vale pra outros clientes (ex.: "imóvel só com escritura, sem matrícula, não serve de garantia") ou se é só sobre a situação DESTE cliente (ex.: "o crédito dele já foi pro banco"). Se for regra geral, devolva em "knowledge" um título curto (a dúvida, genérica, sem nome de cliente) e o conteúdo (a regra, genérica, completa o suficiente pra ser entendida sozinha). Se não for, "knowledge": null. SÓ é regra geral se a equipe deixou claro que vale pra todos os clientes (ou é um fato fixo do produto/banco dito com todas as letras). Resposta CURTA de operação sobre o pedido deste cliente ("precisa ser a CND", "pode", "avisa que vou gerar", "isso mesmo") é do CASO: "knowledge": null. NUNCA acrescente à regra o que a equipe não disse (ex.: "e não a guia/carnê") e NUNCA grave como regra qual documento o banco exige ou NÃO aceita a partir de resposta curta ou ambígua — na dúvida, null.

${CORE_RULES}

Responda SOMENTE com JSON válido, sem markdown: {"reply": "<mensagem pro cliente>", "knowledge": {"title": "<...>", "content": "<...>"} ou null}

${buildContextBlocks(ctx)}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      // Pensa antes de responder e o raciocínio conta no limite — limite
      // pequeno deixa a resposta vazia (mesmo aprendizado da auto-resposta).
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: `Dúvida que você levou pra equipe:\n${question}\n\nResposta da equipe:\n${answer}` }],
    }),
  });
  if (!response.ok) throw new Error(`IA indisponível (${response.status})`);
  const data = await response.json() as { content: { type: string; text?: string }[] };
  const raw = data.content?.find((b) => b.type === 'text')?.text?.trim() || '';
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('A IA não devolveu a mensagem');
  const parsed = JSON.parse(match[0]);
  const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
  if (!reply) throw new Error('A IA não devolveu a mensagem');
  const k = parsed.knowledge;
  const knowledge = k && typeof k.title === 'string' && typeof k.content === 'string' && k.title.trim() && k.content.trim()
    ? { title: k.title.trim().slice(0, 200), content: k.content.trim().slice(0, 2000) }
    : null;
  return { reply, knowledge };
}

/**
 * Colaborador respondeu no balão: a IA escreve a mensagem pro cliente, manda
 * pelo WhatsApp (API Oficial) e, se for regra geral, grava na Base de
 * Conhecimento do setor. Se o envio falhar (ex.: janela de 24h fechada),
 * a dúvida volta pra ABERTA com o erro, pro colaborador resolver pela Inbox.
 */
export async function answerAiTeamQuestion(params: {
  accountId: string; questionId: string; userId: string; answer: string; io?: Io;
}) {
  const { accountId, questionId, userId, io } = params;
  const answer = params.answer.trim().slice(0, 2000);
  if (!answer) throw new Error('Escreva a resposta');

  // Dois colaboradores respondendo ao mesmo tempo mandariam duas mensagens
  // pro cliente — a IA leva uns segundos pra escrever, então trava por dúvida.
  if (answering.has(questionId)) throw new Error('Alguém já está respondendo essa dúvida');
  answering.add(questionId);
  try {
    return await answerLocked(accountId, questionId, userId, answer, io);
  } finally {
    answering.delete(questionId);
  }
}

const answering = new Set<string>();

async function answerLocked(accountId: string, questionId: string, userId: string, answer: string, io: Io) {
  const q = await prisma.aiTeamQuestion.findFirst({ where: { id: questionId, accountId } });
  if (!q) throw new Error('Dúvida não encontrada');
  if (q.status !== 'OPEN') throw new Error('Essa dúvida já foi resolvida');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });

  if (q.kind === 'DOC_QUESTION') return answerDocQuestion(q, answer, userId, user?.name || null, io);
  if (q.kind === 'REJECTION_QUESTION') return answerRejectionQuestion(q, answer, userId, user?.name || null, io);
  if (q.kind === 'BANK_EMAIL') return answerBankEmailQuestion(q, answer, userId, user?.name || null, io);
  if (q.kind === 'EMAIL_QUESTION') {
    const dec = await interpretEmailAnswer(q.question, q.clientMessage || '', answer);
    if (dec.acao !== 'AVISAR_CLIENTE') return answerEmailQuestion(q, answer, dec.acao, dec.regra, userId, user?.name || null, io);
    // AVISAR_CLIENTE: se a notícia é a APROVAÇÃO, usa o aviso de aprovação do CRM (registra a pré-aprovação do e-mail, e com a janela de 24 h fechada manda o template "ver condições").
    // Os números nunca vêm de texto livre da IA. Senão, segue o fluxo normal abaixo (a IA escreve a mensagem a partir da resposta da equipe).
    const viaAviso = await avisarAprovacaoPeloCrm(q, answer, userId, user?.name || null, io);
    if (viaAviso) return viaAviso;
  }

  // Texto livre só vale dentro da janela de 24 h do WhatsApp: fora dela o envio falhava DEPOIS (a Meta recusa com 131047) e a dúvida aparecia como respondida (Maria Selmi, 19/10).
  const { whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!(await whatsappWindowOpen(q.leadId))) {
    const erro = 'Janela de 24 h do WhatsApp fechada: a mensagem não pode ir como texto livre. Reabra a conversa com um template (botão "Usar template" na conversa) e responda de novo.';
    const updated = await prisma.aiTeamQuestion.update({ where: { id: q.id }, data: { answer, answeredByUserId: userId, answeredByName: user?.name || null, sendError: erro }, select: SELECT });
    emitTo(io, await recipientsFor(accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
    return updated;
  }

  const { reply, knowledge } = await composeClientReply(accountId, q.leadId, q.question, answer);

  // Aprovação NUNCA vai em texto livre da IA (Fabio 19/10): se a mensagem anuncia aprovação com valores, vai o aviso padrão do CRM; sem aprovação registrada, não envia nada.
  if (anunciaAprovacao(reply)) {
    const viaAviso = await avisarAprovacaoPeloCrm(q, answer, userId, user?.name || null, io);
    if (viaAviso) return viaAviso;
    const erro = 'A mensagem anunciava uma aprovação por texto livre, e isso não pode: a aprovação sai sempre pelo aviso padrão. Não há aprovação registrada pra avisar — registre o resultado (Análise de Crédito → Resultado) e use "Avisar cliente".';
    const updated = await prisma.aiTeamQuestion.update({ where: { id: q.id }, data: { answer, answeredByUserId: userId, answeredByName: user?.name || null, sendError: erro }, select: SELECT });
    emitTo(io, await recipientsFor(accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
    return updated;
  }

  const sent = await sendOutboundWhatsApp({ accountId, leadId: q.leadId, content: reply, io: io || undefined });
  if (!sent.success) {
    const updated = await prisma.aiTeamQuestion.update({
      where: { id: q.id },
      data: { answer, answeredByUserId: userId, answeredByName: user?.name || null, sendError: sent.error },
      select: SELECT,
    });
    emitTo(io, await recipientsFor(accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
    return updated;
  }

  let knowledgeEntryId: string | null = null;
  let knowledgeTitle: string | null = null;
  if (knowledge && isVoyageConfigured()) {
    try {
      const entry = await createKnowledgeEntry(accountId, { ...knowledge, departmentId: q.departmentId });
      knowledgeEntryId = entry.id;
      knowledgeTitle = entry.title;
    } catch (err) {
      console.error('[Dúvidas da IA] Não salvou na Base de Conhecimento:', err);
    }
  }

  const updated = await prisma.aiTeamQuestion.update({
    where: { id: q.id },
    data: {
      status: 'ANSWERED', answer, answeredByUserId: userId, answeredByName: user?.name || null, answeredAt: new Date(),
      sentReply: reply, sendError: null, knowledgeEntryId, knowledgeTitle,
    },
    select: SELECT,
  });
  await prisma.note.create({
    data: { leadId: q.leadId, type: 'COMMENT', content: `Dúvida respondida por ${user?.name || 'alguém da equipe'}: ${answer}\n🤖 IA passou ao cliente: "${reply}"${knowledgeTitle ? `\n📚 Guardado na Base de Conhecimento: ${knowledgeTitle}` : ''}` },
  }).catch(() => {});
  logActivity({ accountId, userId, action: 'ai_team_answered', leadId: q.leadId, summary: 'respondeu uma dúvida da IA' });
  emitTo(io, await recipientsFor(accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
  return updated;
}

/** A equipe respondeu a dúvida de um documento: nada vai pro cliente. A IA reconfere o arquivo com a resposta, grava o veredito no card e, se a equipe deu uma regra geral,
 *  guarda pra aplicar nos próximos clientes (aparece como "Aprendi: …" no balão; "desfazer" tira). Depois retoma a conferência da documentação do card. */
async function answerDocQuestion(q: { id: string; accountId: string; leadId: string; departmentId: string | null; question: string; attachmentId: string | null }, answer: string, userId: string, userName: string | null, io: Io) {
  const { resolveDocDoubt } = require('./doc-review.service') as typeof import('./doc-review.service');
  const veredito = q.attachmentId ? await resolveDocDoubt(q.accountId, q.leadId, q.attachmentId, q.question, answer).catch(() => undefined) : undefined;
  const regra = veredito?.regra || null;
  const updated = await prisma.aiTeamQuestion.update({
    where: { id: q.id },
    data: {
      status: 'ANSWERED', answer, answeredByUserId: userId, answeredByName: userName, answeredAt: new Date(), sendError: null,
      knowledgeTitle: regra ? regra.slice(0, 200) : null,
    },
    select: SELECT,
  });
  const resumo = veredito ? (veredito.resultado === 'OK' ? 'a IA reconferiu e o documento está OK' : `a IA reconferiu e o documento tem problema: ${veredito.problemas.join('; ') || 'ver resposta da equipe'}`) : 'a IA não conseguiu reler o arquivo agora — confira o documento à mão';
  await prisma.note.create({ data: { leadId: q.leadId, type: 'COMMENT', content: `Dúvida de documento respondida por ${userName || 'alguém da equipe'}: ${answer}\n🤖 ${resumo}.${regra ? `\n📚 Aprendi (vale pros próximos clientes): ${regra}` : ''}` } }).catch(() => {});
  logActivity({ accountId: q.accountId, userId, action: 'ai_team_answered', leadId: q.leadId, summary: 'respondeu uma dúvida da IA sobre documento' });
  emitTo(io, await recipientsFor(q.accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
  // Retoma a conferência (se o card ainda está em "Aguardando Documentação"): sem mais dúvida, segue o fluxo normal (problema → avisa o cliente; tudo certo → avança).
  const { checkDocsComplete } = require('./docs-checker.service') as typeof import('./docs-checker.service');
  checkDocsComplete(q.accountId, q.leadId, io as any).catch((e) => console.error('[Docs] reconferência após a dúvida:', e?.message || e));
  return updated;
}

/** "Eu assumo": fecha a dúvida sem a IA responder e desliga a IA do card —
 *  o colaborador vai falar com o cliente direto pela Inbox. */
export async function dismissAiTeamQuestion(params: { accountId: string; questionId: string; userId: string; io?: Io }) {
  const { accountId, questionId, userId, io } = params;
  const q = await prisma.aiTeamQuestion.findFirst({ where: { id: questionId, accountId } });
  if (!q) throw new Error('Dúvida não encontrada');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const updated = await prisma.aiTeamQuestion.update({
    where: { id: q.id },
    data: { status: 'DISMISSED', answeredByUserId: userId, answeredByName: user?.name || null, answeredAt: new Date() },
    select: SELECT,
  });
  const { count } = await prisma.lead.updateMany({ where: { id: q.leadId, accountId, aiAutoReplyActive: true }, data: { aiAutoReplyActive: false } });
  if (count) io?.to(`lead:${q.leadId}`).emit('lead_ai_toggled', { leadId: q.leadId, active: false });
  await prisma.note.create({ data: { leadId: q.leadId, type: 'COMMENT', content: `${user?.name || 'Alguém da equipe'} assumiu a dúvida da IA e vai falar direto com o cliente. IA desligada neste card.` } }).catch(() => {});
  emitTo(io, await recipientsFor(accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
  return updated;
}

/** Desfaz o aprendizado (a IA achou que era regra geral e não era). */
export async function forgetAiTeamKnowledge(params: { accountId: string; questionId: string; io?: Io }) {
  const q = await prisma.aiTeamQuestion.findFirst({ where: { id: params.questionId, accountId: params.accountId } });
  if (!q) throw new Error('Dúvida não encontrada');
  if (q.knowledgeEntryId) await deleteKnowledgeEntry(q.knowledgeEntryId, params.accountId).catch(() => false);
  const updated = await prisma.aiTeamQuestion.update({
    where: { id: q.id }, data: { knowledgeEntryId: null, knowledgeTitle: null }, select: SELECT,
  });
  emitTo(params.io, await recipientsFor(params.accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
  return updated;
}

// ───────────────────────── Pedido de ligação ─────────────────────────
// Fabio 28/09: "sempre verificar se a Andreia consegue fazer a ligação; se
// sim, agendar o horário com o cliente". A IA pega o horário que o cliente
// quer e abre o popup pra todos; confirmar manda a confirmação, o pedido de
// permissão de ligação (se ainda não autorizou) e cria a tarefa da Andreia.

/** Cliente quer ligação no horário `when` — abre (ou atualiza) o popup. */
export async function createCallRequest(params: {
  accountId: string; leadId: string; when: string; callAt?: Date | null; clientMessage?: string | null; io?: Io;
}) {
  const { accountId, leadId, io } = params;
  const when = params.when.trim().slice(0, 120);
  if (!when) return null;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, pipeline: { select: { departmentId: true } } } });
  if (!lead) return null;
  const departmentId = lead.pipeline?.departmentId ?? null;
  const question = `Quer receber ligação ${when}. A Andreia consegue ligar nesse horário?`;
  const callAt = params.callAt && !isNaN(params.callAt.getTime()) ? params.callAt : null;
  const open = await prisma.aiTeamQuestion.findFirst({ where: { accountId, leadId, status: 'OPEN', kind: 'CALL_REQUEST' } });
  const changed = !open || open.callWhen !== when;
  const saved = open
    ? await prisma.aiTeamQuestion.update({ where: { id: open.id }, data: { question, callWhen: when, callAt, clientMessage: params.clientMessage?.slice(0, 2000) || open.clientMessage }, select: SELECT })
    : await prisma.aiTeamQuestion.create({ data: { accountId, leadId, departmentId, kind: 'CALL_REQUEST', question, callWhen: when, callAt, clientMessage: params.clientMessage?.slice(0, 2000) || null }, select: SELECT });
  const userIds = await recipientsFor(accountId, departmentId);
  // Horário novo/alterado reabre o popup pra todo mundo (isNew).
  emitTo(io, userIds, 'ai_team_question', { id: saved.id, leadId, leadName: lead.name, question, isNew: changed });
  if (changed) {
    await prisma.note.create({ data: { leadId, type: 'CALL', content: `📞 Cliente pediu ligação ${when} — aguardando a Andreia confirmar o horário.` } }).catch(() => {});
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `Pedido de ligação — ${lead.name}`, body: `Quer receber ligação ${when}. A Andreia consegue?`, leadId }, userIds).catch(() => {});
    logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_team_question', leadId, leadName: lead.name, summary: `cliente pediu ligação ${when}` });
  }
  return saved;
}

/** "Sim, a Andreia consegue": confirma com o cliente, manda o pedido de
 *  permissão de ligação (se ainda não autorizou) e cria a tarefa da Andreia. */
export async function confirmCallRequest(params: { accountId: string; questionId: string; userId: string; io?: Io }) {
  const { accountId, questionId, userId, io } = params;
  if (answering.has(questionId)) throw new Error('Alguém já está respondendo esse pedido');
  answering.add(questionId);
  try {
    const q = await prisma.aiTeamQuestion.findFirst({ where: { id: questionId, accountId, kind: 'CALL_REQUEST' } });
    if (!q) throw new Error('Pedido de ligação não encontrado');
    if (q.status !== 'OPEN') throw new Error('Esse pedido já foi resolvido');
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    const lead = await prisma.lead.findFirst({ where: { id: q.leadId, accountId }, select: { name: true, contactId: true, pipeline: { select: { departmentId: true } }, contact: { select: { whatsappPhone: true, phone: true } } } });
    if (!lead) throw new Error('Card não encontrado');

    const reply = `Combinado! Te ligo ${q.callWhen} por aqui pelo WhatsApp.`;
    const sent = await sendOutboundWhatsApp({ accountId, leadId: q.leadId, content: reply, io: io || undefined });
    if (!sent.success) {
      const updated = await prisma.aiTeamQuestion.update({ where: { id: q.id }, data: { sendError: sent.error }, select: SELECT });
      emitTo(io, await recipientsFor(accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
      return updated;
    }

    // Pedido de permissão só agora, com o horário confirmado (Fabio 28/09).
    let permissionNote = '';
    try {
      const calling = require('./whatsapp-calling.service') as typeof import('./whatsapp-calling.service');
      const wa = require('./whatsapp.service') as typeof import('./whatsapp.service');
      const phoneRaw = calling.pickRealPhone(lead.contact);
      const config = await wa.getWhatsAppConfig(accountId, lead.pipeline?.departmentId ?? null);
      const state = phoneRaw && config?.phoneNumberId && config.accessToken
        ? await calling.getCallPermissionState({ phoneNumberId: config.phoneNumberId, accessToken: config.accessToken } as any, wa.normalizeBrazilianWhatsAppPhone(phoneRaw))
        : null;
      if (state?.permitted) permissionNote = 'cliente já tinha autorizado ligação';
      else if (lead.contactId) {
        const perm = await calling.sendCallPermissionRequest(accountId, lead.pipeline?.departmentId ?? null, lead.contactId, q.leadId, io);
        permissionNote = perm.ok ? 'pedido de permissão de ligação enviado' : `pedido de permissão NÃO saiu: ${perm.error}`;
      }
    } catch (err: any) {
      permissionNote = `pedido de permissão NÃO saiu: ${err?.message}`;
    }

    // Tarefa pra Andreia (quem liga) — se não achar, fica com quem confirmou.
    const andreia = await prisma.user.findFirst({ where: { accountId, name: { startsWith: 'Andreia', mode: 'insensitive' } }, select: { id: true } });
    const dueAt = q.callAt || new Date(Date.now() + 60 * 60 * 1000);
    await prisma.task.create({ data: { title: `📞 Ligar para ${lead.name} — ${q.callWhen}`, dueAt, userId: andreia?.id || userId, leadId: q.leadId } }).catch((err) => console.error('[Ligação] tarefa não criada:', err?.message));

    const updated = await prisma.aiTeamQuestion.update({
      where: { id: q.id },
      data: { status: 'ANSWERED', answer: `Confirmado: a Andreia liga ${q.callWhen}.`, answeredByUserId: userId, answeredByName: user?.name || null, answeredAt: new Date(), sentReply: reply, sendError: null },
      select: SELECT,
    });
    await prisma.note.create({ data: { leadId: q.leadId, type: 'CALL', content: `📞 Ligação agendada ${q.callWhen} (confirmada por ${user?.name || 'alguém da equipe'}) — tarefa criada pra Andreia; ${permissionNote || 'permissão não verificada'}.` } }).catch(() => {});
    logActivity({ accountId, userId, action: 'ai_team_answered', leadId: q.leadId, summary: `confirmou ligação ${q.callWhen}` });
    emitTo(io, await recipientsFor(accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
    return updated;
  } finally {
    answering.delete(questionId);
  }
}

/** A Andreia não consegue no horário do cliente: propõe outro. A resposta do
 *  cliente volta pra IA, que abre um novo pedido com o horário combinado. */
export async function proposeCallTime(params: { accountId: string; questionId: string; userId: string; time: string; io?: Io }) {
  const { accountId, questionId, userId, io } = params;
  const time = params.time.trim().slice(0, 120);
  if (!time) throw new Error('Escreva o horário que a Andreia consegue');
  // 15/10 (Silas de Sena Brito): o Fabio escreveu "Pode sim !" no campo "outro horário" e o cliente recebeu "Nesse horário não vou conseguir. Pode ser Pode sim !?".
  // "Sim/pode" sozinho é CONFIRMAÇÃO do horário pedido; e o que não parece dia/hora nem sai pro cliente.
  if (/^(sim|pode( sim)?|consigo( sim)?|confirm\w*|ok|beleza|claro|combinado|fechado|certo|isso( mesmo)?)[\s!.?]*$/i.test(time)) return confirmCallRequest({ accountId, questionId, userId, io });
  if (!/\d|\b(hoje|amanh[ãa]|manh[ãa]|tarde|noite|meio[- ]?dia|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|semana)\b/i.test(time)) {
    throw new Error('Isso não parece um horário — escreva o dia e a hora que a Andreia consegue (ex.: amanhã às 14h). Se ela pode no horário do cliente, use "Sim, confirmar".');
  }
  const q = await prisma.aiTeamQuestion.findFirst({ where: { id: questionId, accountId, kind: 'CALL_REQUEST' } });
  if (!q) throw new Error('Pedido de ligação não encontrado');
  if (q.status !== 'OPEN') throw new Error('Esse pedido já foi resolvido');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const reply = `Nesse horário não vou conseguir. Pode ser ${time}?`;
  const sent = await sendOutboundWhatsApp({ accountId, leadId: q.leadId, content: reply, io: io || undefined });
  if (!sent.success) {
    const updated = await prisma.aiTeamQuestion.update({ where: { id: q.id }, data: { sendError: sent.error }, select: SELECT });
    emitTo(io, await recipientsFor(accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
    return updated;
  }
  const updated = await prisma.aiTeamQuestion.update({
    where: { id: q.id },
    data: { status: 'ANSWERED', answer: `A Andreia não consegue ${q.callWhen}; propôs ${time} (esperando o cliente).`, answeredByUserId: userId, answeredByName: user?.name || null, answeredAt: new Date(), sentReply: reply, sendError: null },
    select: SELECT,
  });
  await prisma.note.create({ data: { leadId: q.leadId, type: 'CALL', content: `📞 ${user?.name || 'Equipe'} propôs outro horário pra ligação: ${time} (cliente tinha pedido ${q.callWhen}).` } }).catch(() => {});
  emitTo(io, await recipientsFor(accountId, q.departmentId), 'ai_team_question_updated', { id: q.id });
  return updated;
}
