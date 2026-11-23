import { prisma } from '../lib/prisma';
import { callableFirstName } from '../lib/text';
import { sendOutboundWhatsAppTemplate, sendOutboundWhatsApp } from './message.service';
import { logActivity } from './activity.service';

/* Feedback do processo concluído (Fabio 14/11: "faz um template de feedback em UTILIDADE para encaminhar aos clientes quando finalizar os processos";
 *  "temos um template de feedback pronto com link para fazer avaliação no Google, usa o link").
 *  - Gatilho: card marcado Ganho (vai pro funil Concluído). No dia seguinte, das 09h às 21h, sai o template da área do card (uma vez por card), mesmo com a
 *    IA do card desligada — só o Stop total segura. Card reaberto/perdido antes disso não recebe. Só cards marcados Ganho a partir de 14/11.
 *  - Botões [Ótima] [Boa] [Poderia ser melhor]: a resposta vira nota no card e o cliente recebe o agradecimento com o link de avaliação do Google (o link vai
 *    na mensagem livre, com a conversa aberta pela resposta dele — no template puxaria a categoria pra Marketing). "Poderia ser melhor" → push pra equipe e
 *    pergunta o que melhorar; o comentário seguinte (também depois de "Boa") vira nota + push. Resposta por texto em vez do botão: nota + push. */

export const FEEDBACK_TEMPLATES = { credito: 'processo_concluido_credito', habitacional: 'processo_concluido_habitacional' } as const;
// O link de avaliação no Google vem dos dados da empresa da conta (lib/empresa.ts, plano do piloto 23/11).
const BOTOES = ['Ótima', 'Boa', 'Poderia ser melhor'] as const;
type Botao = typeof BOTOES[number];
const PERGUNTA = 'Como foi sua experiência com o nosso atendimento neste processo?';
// Os botões vão no texto gravado ("…\n\n[A]  [B]  [C]") pra conversa do CRM desenhá-los como no WhatsApp.
const BOTOES_PREVIEW = BOTOES.map((b) => `[${b}]`).join('  ');
// Só cards marcados Ganho a partir do dia em que isto entrou no ar (os 8 de agosto–outubro ficam de fora).
const CORTE = Date.parse('2026-11-14T03:00:00Z');
const DIA = 86_400_000;
const BRT = -3 * 3_600_000;
const JANELA_RESPOSTA = 3 * DIA;
const POR_RODADA = 10;

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
export type FeedbackState = {
  enviadoAt?: string; template?: string; ganhoAt?: string;
  resposta?: Botao | 'texto'; respostaAt?: string; respostaTexto?: string;
  aguardaComentario?: boolean; comentarioAt?: string;
  falhaAt?: string; falha?: string;
};

const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const horaBrt = (ms = Date.now()) => new Date(ms + BRT).getUTCHours();
const diaBrt = (ms: number) => new Date(ms + BRT).toISOString().slice(0, 10);
const emHorario = () => { const h = horaBrt(); return h >= 9 && h < 21; };

/** Texto do template (o que a Meta aprova) — {{1}} = primeiro nome. */
export function feedbackTemplateBody(habitacional: boolean): string {
  const assunto = habitacional ? 'financiamento habitacional' : 'crédito com garantia de imóvel';
  return `Oi {{1}}, tudo bem? Seu processo de ${assunto} foi concluído. Obrigado por confiar na gente! ${PERGUNTA}`;
}

function templateDaArea(area: string | null | undefined, nome: string) {
  const fh = /habita/i.test(area || '');
  return {
    templateName: fh ? FEEDBACK_TEMPLATES.habitacional : FEEDBACK_TEMPLATES.credito,
    language: 'pt_BR',
    bodyParams: [nome],
    previewText: `${feedbackTemplateBody(fh).replace('{{1}}', nome)}\n\n${BOTOES_PREVIEW}`,
  };
}

const push = (accountId: string, title: string, body: string, leadId: string) => {
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ }
};

async function salvarEstado(leadId: string, patch: Partial<FeedbackState>): Promise<void> {
  // Relê o card na hora de gravar (outros serviços mexem no customFields ao mesmo tempo).
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  const st: Record<string, unknown> = { ...(cf._feedbackConcluido || {}), ...patch };
  for (const k of Object.keys(st)) if (st[k] === undefined) delete st[k];
  cf._feedbackConcluido = st;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}

// Status dos dois templates na Meta (só sai depois de aprovado). Consulta de 15 em 15 min enquanto não aprova.
const aprovados = new Set<string>();
let ultimaConsulta = 0;
async function templatesAprovados(accountId: string): Promise<Set<string>> {
  if (aprovados.size === 2 || Date.now() - ultimaConsulta < 15 * 60_000) return aprovados;
  ultimaConsulta = Date.now();
  try {
    const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
    for (const t of await listMetaTemplates(accountId)) {
      if (Object.values(FEEDBACK_TEMPLATES).includes(t?.name) && String(t?.status || '').toUpperCase() === 'APPROVED') aprovados.add(t.name);
    }
  } catch (e: any) { console.error('[Feedback] status dos templates na Meta:', e?.message || e); }
  return aprovados;
}

/** Quando o card foi marcado Ganho (a nota que a rota grava ao mudar o status / ao migrar pro Concluído). */
async function ganhoEm(leadId: string): Promise<number | null> {
  const n = await prisma.note.findFirst({
    where: { leadId, OR: [{ content: { startsWith: 'Status alterado para "Ganho"' } }, { content: { contains: 'ao ser marcado como Ganho' } }] },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  });
  return n ? n.createdAt.getTime() : null;
}

/** Poller (10 min): manda o template no dia seguinte ao Ganho. */
export async function processFeedbackConcluido(io?: Io): Promise<void> {
  if (!emHorario()) return;
  const leads = await prisma.lead.findMany({
    where: { status: 'WON', archived: false, isGroup: false, pipeline: { name: 'Concluído' }, updatedAt: { gte: new Date(CORTE) } },
    select: { id: true, accountId: true, name: true, customFields: true, contact: { select: { name: true } }, pipeline: { select: { department: { select: { name: true } } } } },
    take: 200,
  });
  let enviados = 0;
  for (const l of leads) {
    if (enviados >= POR_RODADA) break;
    const cf = (l.customFields || {}) as Record<string, any>;
    const st = (cf._feedbackConcluido || {}) as FeedbackState;
    if (st.enviadoAt || cf._autoPaused) continue;
    if (st.falhaAt && Date.now() - Date.parse(st.falhaAt) < DIA) continue; // falhou (sem telefone, Meta recusou): tenta de novo amanhã
    const ganho = await ganhoEm(l.id);
    if (!ganho || ganho < CORTE || diaBrt(ganho) === diaBrt(Date.now())) continue; // só no dia seguinte ao Ganho
    const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, l.name, l.contact?.name) || 'cliente';
    const t = templateDaArea(l.pipeline?.department?.name, nome);
    if (!(await templatesAprovados(l.accountId)).has(t.templateName)) continue;
    const r = await sendOutboundWhatsAppTemplate({ accountId: l.accountId, leadId: l.id, ...t, io: io || undefined });
    if (!r.success) {
      await salvarEstado(l.id, { falhaAt: new Date().toISOString(), falha: String(r.error || '').slice(0, 160) });
      console.error(`[Feedback] ${l.name}: template não saiu — ${r.error}`);
      continue;
    }
    await salvarEstado(l.id, { enviadoAt: new Date().toISOString(), template: t.templateName, ganhoAt: new Date(ganho).toISOString(), falhaAt: undefined, falha: undefined });
    await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `📨 Processo concluído: mandei o template de feedback "${PERGUNTA}" (botões ${BOTOES.join(' / ')}).` } }).catch(() => {});
    enviados++;
    await new Promise((res) => setTimeout(res, 1500));
  }
  if (enviados) console.log(`[Feedback] ${enviados} template(s) de feedback do processo concluído enviado(s)`);
}

function botaoDe(text: string): Botao | null {
  const t = norm(text).replace(/[.!]+$/, '');
  return BOTOES.find((b) => norm(b) === t) || null;
}

function agradecimento(botao: Botao, nome: string, linkGoogle: string): string {
  const oi = nome ? `, ${nome}` : '';
  const link = `Se puder, deixe sua avaliação no Google, ajuda muito a gente: ${linkGoogle}`;
  if (botao === 'Ótima') return `Que bom saber${oi}! Muito obrigado. ${link}`;
  if (botao === 'Boa') return `Obrigado pelo retorno${oi}! ${link}\n\nE se tiver algo que a gente possa melhorar, é só me contar por aqui.`;
  return `Obrigado pela sinceridade${oi}. O que a gente poderia ter feito melhor? Pode me contar por aqui, vai direto pra nossa equipe.\n\nE se quiser, também pode deixar sua avaliação no Google: ${linkGoogle}`;
}

/** Resposta do cliente ao template de feedback. true = tratada (nada mais responde essa mensagem). */
export async function maybeHandleFeedbackReply(accountId: string, leadId: string, text: string, isButton: boolean, io: Io): Promise<boolean> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true, contact: { select: { name: true } } } });
  if (!lead) return false;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const st = cf._feedbackConcluido as FeedbackState | undefined;
  if (!st?.enviadoAt) return false;
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name, lead.contact?.name) || '';
  const agora = new Date().toISOString();
  const trecho = (text || '').trim().slice(0, 500);

  if (isButton) {
    const botao = botaoDe(text);
    if (!botao) return false;
    const primeira = !st.resposta || st.resposta === 'texto';
    await salvarEstado(leadId, { resposta: botao, respostaAt: agora, aguardaComentario: botao !== 'Ótima', comentarioAt: undefined });
    const ruim = botao === 'Poderia ser melhor';
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `${ruim ? '⚠️' : '⭐'} Feedback do processo concluído: o cliente respondeu "${botao}".${primeira ? ` Mandei o agradecimento com o link de avaliação do Google${ruim || botao === 'Boa' ? ' e perguntei o que a gente pode melhorar' : ''}.` : ' (trocou a resposta)'}` } }).catch(() => {});
    logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId, leadName: lead.name, summary: `feedback do processo concluído: "${botao}"` });
    if (ruim) push(accountId, `⚠️ Feedback ruim — ${lead.name}`, 'Respondeu "Poderia ser melhor" ao feedback do processo concluído. Perguntei o que melhorar.', leadId);
    if (primeira) await sendOutboundWhatsApp({ accountId, leadId, content: agradecimento(botao, nome, (await (require('../lib/empresa') as typeof import('../lib/empresa')).dadosDaConta(accountId)).avaliacaoGoogle), io: io || undefined });
    return true;
  }

  // Comentário depois de "Boa"/"Poderia ser melhor" (a gente perguntou o que melhorar).
  if (st.resposta && st.resposta !== 'texto' && st.aguardaComentario && !st.comentarioAt && st.respostaAt && Date.now() - Date.parse(st.respostaAt) < JANELA_RESPOSTA && trecho) {
    await salvarEstado(leadId, { comentarioAt: agora, aguardaComentario: false });
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `💬 Comentário do feedback (respondeu "${st.resposta}"): ${trecho}` } }).catch(() => {});
    push(accountId, `💬 Feedback — ${lead.name}`, `Comentário do cliente: ${trecho.slice(0, 140)}`, leadId);
    await sendOutboundWhatsApp({ accountId, leadId, content: 'Obrigado por contar! Já passei pra nossa equipe.', io: io || undefined });
    return true;
  }

  // Respondeu por texto em vez do botão: grava e avisa a equipe (a conversa segue normal).
  if (!st.resposta && Date.now() - Date.parse(st.enviadoAt) < JANELA_RESPOSTA && trecho) {
    await salvarEstado(leadId, { resposta: 'texto', respostaAt: agora, respostaTexto: trecho });
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⭐ Feedback do processo concluído (por texto, sem o botão): ${trecho}` } }).catch(() => {});
    push(accountId, `⭐ Feedback — ${lead.name}`, `Respondeu o feedback por texto: ${trecho.slice(0, 140)}`, leadId);
  }
  return false;
}
