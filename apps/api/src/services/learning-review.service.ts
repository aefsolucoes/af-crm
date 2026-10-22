import { prisma } from '../lib/prisma';
import { createLearnQuestion } from './ai-team-question.service';
import { searchKnowledge } from './knowledge.service';

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/**
 * APRENDIZADO POR CONVERSA (Fabio 22/10: "toda conversa que a IA OU A GENTE tenha com cliente e for algo relevante, a IA do CRM mande em push pra eu ir respondendo e ela aprendendo").
 * Poller (10 min, 07h–21h): pega conversas de WhatsApp que "assentaram" (última mensagem há 25 min ou mais, com atividade nas últimas 8 h), com cliente + resposta da IA ou da equipe, e a IA (Haiku) decide se
 * há algo RELEVANTE e GERAL pra aprender: correção da equipe à IA, fato novo (bancos, processo, documentos, prazos, custos), objeção nova com a resposta que funcionou, erro da IA, combinado que vira regra.
 * Se houver, abre um aprendizado (AiTeamQuestion kind LEARN, só administrador vê) + push com a lição proposta. O Fabio responde "sim", escreve a lição certa ou "não": a lição vira entrada na Base de
 * Conhecimento (ai-team-question.service). NADA vai pro cliente. Limites: 10 aprendizados por dia e 15 em aberto; cada conversa é revista no máximo uma vez por trecho (customFields._learnReviewAt).
 */

const MODEL = 'claude-haiku-4-5-20251001';
const BRT_MS = 3 * 3600_000;
const SETTLE_MS = 25 * 60_000;
const LOOKBACK_MS = 8 * 3600_000;
const PER_TICK = 3;
const MAX_PER_DAY = 10;
const MAX_OPEN = 15;

const SYSTEM = `Você ajuda a A&F Soluções Financeiras (correspondente bancário: crédito com garantia de imóvel/Home Equity e financiamento habitacional) a ensinar a IA que atende clientes pelo WhatsApp. Abaixo está um trecho de conversa entre um cliente e a IA ("IA") e/ou a equipe ("Equipe"). Decida se há UMA lição GERAL, útil pra outros clientes, que a IA ainda não sabe.

É RELEVANTE quando: (1) a equipe corrigiu a IA ou respondeu algo que a IA não sabia (fato sobre bancos, processo, documentos, prazos, custos, regras); (2) o cliente fez uma objeção/pergunta nova e a resposta dada (pela equipe ou pela IA) merece virar regra; (3) a IA errou (informação errada, inventada, fora do escopo, tom ruim) e a equipe ou o cliente mostrou o erro; (4) a conversa fixou um combinado que vira regra do processo.
NÃO é relevante: cumprimentos, envio rotineiro de documentos, cobrança de andamento, agendamentos, assuntos pessoais, respostas que só repetem o que a BASE (abaixo) já diz, e qualquer coisa específica demais de um único cliente.

A lição: 1 a 3 frases, no imperativo pra IA ("Quando o cliente …, responda …"), GERAL — sem nome, CPF, telefone, endereço ou valores do cliente. Título curto (até 8 palavras). Não invente nada que não esteja na conversa. Nunca proponha lição que anuncie aprovação de crédito.

Responda SOMENTE com JSON, sem markdown: {"relevante":false} ou {"relevante":true,"titulo":"...","resumo":"o que aconteceu, 1 frase (pode usar o primeiro nome do cliente)","licao":"...","tipo":"CORRECAO|OBJECAO|FATO|ERRO_DA_IA|COMBINADO"}`;

export type LearnCandidate = { relevante: boolean; titulo: string; resumo: string; licao: string; tipo: string };

/** Interpreta a resposta da IA. Pura (testável). */
export function parseLearnCandidate(raw: string): LearnCandidate | null {
  const m = /\{[\s\S]*\}/.exec(String(raw || ''));
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (j.relevante !== true) return { relevante: false, titulo: '', resumo: '', licao: '', tipo: '' };
    const licao = String(j.licao || '').trim().slice(0, 900);
    const resumo = String(j.resumo || '').trim().slice(0, 300);
    if (licao.length < 25 || resumo.length < 10) return null;
    return { relevante: true, titulo: String(j.titulo || 'Aprendizado da conversa').trim().slice(0, 120), resumo, licao, tipo: String(j.tipo || '').slice(0, 20) };
  } catch { return null; }
}

async function ask(contexto: string): Promise<LearnCandidate | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODEL, max_tokens: 800, system: SYSTEM, messages: [{ role: 'user', content: contexto }] }),
    });
    if (!r.ok) { console.error('[Aprendizado] Erro Anthropic:', r.status, (await r.text()).slice(0, 200)); return null; }
    const data = await r.json() as { content: { type: string; text?: string }[] };
    return parseLearnCandidate(data.content?.find((b) => b.type === 'text')?.text || '');
  } catch (e: any) { console.error('[Aprendizado] falha:', e?.message); return null; }
}

let running = false;
export async function processLearningReview(io: Io): Promise<void> {
  if (running) return;
  running = true;
  try {
    const hh = new Date(Date.now() - BRT_MS).getUTCHours();
    if (hh < 7 || hh >= 21) return;
    const since = new Date(Date.now() - LOOKBACK_MS);
    const settled = new Date(Date.now() - SETTLE_MS);
    const rows = await prisma.$queryRaw<{ leadId: string; accountId: string }[]>`
      SELECT m."leadId", l."accountId", max(m."createdAt") AS last
      FROM "Message" m JOIN "Lead" l ON l.id = m."leadId"
      WHERE m.channel = 'WHATSAPP' AND m."createdAt" >= ${since} AND l."isGroup" = false AND l.archived = false
      GROUP BY m."leadId", l."accountId" HAVING max(m."createdAt") <= ${settled}
      ORDER BY last DESC LIMIT 40`;
    if (!rows.length) return;
    const diaBrt = new Date(Date.now() - BRT_MS).toISOString().slice(0, 10);
    const inicioDia = new Date(`${diaBrt}T00:00:00-03:00`);
    const stats = new Map<string, { hoje: number; abertos: number }>();
    let feitos = 0;
    for (const r of rows) {
      if (feitos >= PER_TICK) break;
      let st = stats.get(r.accountId);
      if (!st) {
        st = { hoje: await prisma.aiTeamQuestion.count({ where: { accountId: r.accountId, kind: 'LEARN', createdAt: { gte: inicioDia } } }), abertos: await prisma.aiTeamQuestion.count({ where: { accountId: r.accountId, kind: 'LEARN', status: 'OPEN' } }) };
        stats.set(r.accountId, st);
      }
      if (st.hoje >= MAX_PER_DAY || st.abertos >= MAX_OPEN) continue;
      try {
        const criou = await uma(r.accountId, r.leadId, since, io);
        if (criou === 'revisou') feitos++;
        if (criou === 'criou') { feitos++; st.hoje++; st.abertos++; }
      } catch (e: any) { console.warn('[Aprendizado]', e?.message); }
    }
  } finally { running = false; }
}

async function uma(accountId: string, leadId: string, since: Date, io: Io): Promise<'pulou' | 'revisou' | 'criou'> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, customFields: true, pipeline: { select: { departmentId: true } } } });
  if (!lead) return 'pulou';
  const cf = (lead.customFields || {}) as Record<string, any>;
  const desde = cf._learnReviewAt ? new Date(Math.max(since.getTime(), new Date(cf._learnReviewAt).getTime())) : since;
  const msgs = await prisma.message.findMany({ where: { leadId, channel: 'WHATSAPP', createdAt: { gt: desde }, deleted: false }, orderBy: { createdAt: 'asc' }, take: 40, select: { direction: true, content: true, sentByUserId: true, templateName: true, createdAt: true } });
  const inbound = msgs.filter((m) => m.direction === 'INBOUND');
  const resposta = msgs.filter((m) => m.direction === 'OUTBOUND' && !m.templateName && m.content.length > 0);
  if (msgs.length < 3 || !inbound.length || resposta.reduce((n, m) => n + m.content.length, 0) < 100) return 'pulou'; // conversa curta/rotineira: nem marca (pode crescer depois)
  // marca já (cada trecho é revisto uma vez, mesmo se a IA falhar)
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...((fresh?.customFields || {}) as Record<string, any>), _learnReviewAt: new Date().toISOString() } as any } });

  const quem = (m: (typeof msgs)[number]) => (m.direction === 'INBOUND' ? 'Cliente' : m.templateName ? 'Template automático' : m.sentByUserId ? 'Equipe' : 'IA');
  const trecho = msgs.map((m) => `${quem(m)}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 420)}`).join('\n');
  const ultimaDoCliente = inbound[inbound.length - 1].content;
  const hits = await searchKnowledge(accountId, ultimaDoCliente, 3, lead.pipeline?.departmentId).catch(() => []);
  const base = hits.length ? hits.slice(0, 3).map((h, i) => `[${i + 1}] ${h.content.replace(/\s+/g, ' ').slice(0, 360)}`).join('\n') : '(nada relacionado)';
  const cand = await ask(`--- BASE DE CONHECIMENTO (o que a IA já sabe sobre o assunto) ---\n${base}\n\n--- TRECHO DA CONVERSA ---\n${trecho}`);
  if (!cand || !cand.relevante) return 'revisou';
  const q = await createLearnQuestion({ accountId, leadId, resumo: cand.resumo, licao: cand.licao, titulo: cand.titulo, tipo: cand.tipo, excerpt: trecho, io });
  return q ? 'criou' : 'revisou';
}
