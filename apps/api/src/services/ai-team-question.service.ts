import { PrismaClient } from '@prisma/client';
import { buildSharedAiContext, buildContextBlocks, CORE_RULES } from './ai-shared.service';
import { sendOutboundWhatsApp } from './message.service';
import { createKnowledgeEntry, deleteKnowledgeEntry } from './knowledge.service';
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

const prisma = new PrismaClient();

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

const SELECT = {
  id: true, leadId: true, departmentId: true, question: true, clientMessage: true, status: true,
  answer: true, answeredByName: true, answeredAt: true, sentReply: true, sendError: true,
  knowledgeEntryId: true, knowledgeTitle: true, createdAt: true,
  lead: { select: { name: true } },
} as const;

/** Quem enxerga a dúvida: admin, quem não tem setor definido (enxerga tudo,
 *  mesma regra do resto do CRM) e quem é do setor do card. */
async function recipientsFor(accountId: string, departmentId: string | null): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { accountId }, select: { id: true, role: true, departmentIds: true } });
  return users
    .filter((u) => u.role === 'ADMIN' || !u.departmentIds.length || !departmentId || u.departmentIds.includes(departmentId))
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
  const open = await prisma.aiTeamQuestion.findFirst({ where: { accountId, leadId, status: 'OPEN' }, orderBy: { createdAt: 'desc' } });
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

/** Dúvidas que o usuário enxerga: todas as abertas + as respondidas nos
 *  últimos 7 dias (histórico curto, o balão não é arquivo). */
export async function listAiTeamQuestions(accountId: string, scopeDepartmentIds: string[]) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return prisma.aiTeamQuestion.findMany({
    where: {
      accountId,
      OR: [{ status: 'OPEN' }, { createdAt: { gte: since } }],
      ...(scopeDepartmentIds.length ? { AND: [{ OR: [{ departmentId: null }, { departmentId: { in: scopeDepartmentIds } }] }] } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 60,
    select: SELECT,
  });
}

/** Perguntas abertas / respostas recentes da equipe sobre ESTE card — entra
 *  no prompt da IA pra ela não inventar nem perguntar de novo o mesmo. */
export async function teamQuestionsContext(leadId: string): Promise<string> {
  const rows = await prisma.aiTeamQuestion.findMany({
    where: { leadId, OR: [{ status: 'OPEN' }, { status: 'ANSWERED', answeredAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } }] },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { status: true, question: true, answer: true },
  });
  if (!rows.length) return '';
  const lines = rows.map((r) => r.status === 'OPEN'
    ? `- AINDA SEM RESPOSTA: ${r.question}`
    : `- Pergunta: ${r.question}\n  Resposta da equipe: ${r.answer}`);
  return `--- DÚVIDAS DESTE CLIENTE QUE VOCÊ JÁ LEVOU PRA EQUIPE ---
${lines.join('\n')}
Se o cliente voltar num assunto ainda sem resposta, diga que ainda está verificando (não abra outra pergunta nem invente). Respostas da equipe valem como verdade pra este cliente.`;
}

export async function composeClientReply(accountId: string, leadId: string, question: string, answer: string) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY não configurada');
  const ctx = await buildSharedAiContext(accountId, leadId, `${question}\n${answer}`, {
    historyTake: 12, historyRoleLabels: { inbound: 'Cliente', outbound: 'Atendente' },
  });
  if (!ctx) throw new Error('Card não encontrado');

  const system = `Você atende clientes da A&F Soluções Financeiras pelo WhatsApp. Você tinha dito ao cliente que ia verificar uma dúvida com a equipe; a equipe respondeu pelo chat interno do CRM. Agora:
1. Escreva a mensagem pro cliente passando a resposta da equipe — fiel ao que a equipe disse (não acrescente fato, valor, prazo ou promessa que não esteja na resposta), no tom da conversa, curta. Não conte que perguntou pra equipe nem cite nomes; só dê a resposta, como quem voltou com a informação. Se a resposta da equipe tiver comentário interno sobre o cliente, não repasse — só a informação que responde a dúvida.
2. Decida se a resposta é uma REGRA GERAL que vale pra outros clientes (ex.: "imóvel só com escritura, sem matrícula, não serve de garantia") ou se é só sobre a situação DESTE cliente (ex.: "o crédito dele já foi pro banco"). Se for regra geral, devolva em "knowledge" um título curto (a dúvida, genérica, sem nome de cliente) e o conteúdo (a regra, genérica, completa o suficiente pra ser entendida sozinha). Se não for, "knowledge": null.

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

  const { reply, knowledge } = await composeClientReply(accountId, q.leadId, q.question, answer);

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
