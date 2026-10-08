import { PrismaClient } from '@prisma/client';
import { logActivity } from './activity.service';

/**
 * Cliente tocou em "Não tenho interesse" (botão dos templates de boas-vindas/
 * follow-up) — pedido do Fabio 26/09:
 *  1. o card vai pra Perdido na hora (sai do funil ativo → funil "Perdidos");
 *  2. a gente pergunta o motivo, na frase que ele mesmo usa com cliente;
 *  3. o motivo entra na hora com o que já temos (o botão que ele tocou) —
 *     "não precisa esperar a cliente responder"; se ele responder a pergunta,
 *     a resposta complementa o motivo e vira nota no card.
 *
 * (De 06/10 a 08/10 o "não" em Home Equity ia pro estágio Remarketing; o
 * Fabio desfez: "não" sempre vai pra Perdido, venha do boas-vindas, do
 * follow-up ou do remarketing — remarketing é só pra quem não deu retorno.)
 */

const prisma = new PrismaClient();

const NO_INTEREST_RE = /^n[ãa]o,?\s*(tenho\s+(mais\s+)?interesse|obrigad[oa])\b/i;
// Trecho da pergunta do motivo (a mesma frase que o Fabio usa à mão).
const REASON_QUESTION_MARK = 'motivo do seu desinteresse';

function normalize(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function firstName(lead: { name: string; customFields: unknown }): string {
  const cf = (lead.customFields || {}) as Record<string, unknown>;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  return callableFirstName(cf.participante_1, lead.name) || '';
}

/** Retorna true se tratou o clique (quem chama não passa pra IA/automação). */
export async function handleNoInterestButton(accountId: string, leadId: string, text: string, io: any): Promise<boolean> {
  if (!NO_INTEREST_RE.test(text.trim())) return false;
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    select: {
      id: true, name: true, status: true, customFields: true, stageId: true, stage: { select: { name: true } },
      pipeline: { select: { name: true, departmentId: true, department: { select: { id: true, name: true } } } },
    },
  });
  if (!lead) return false;
  if (lead.status === 'LOST') return true; // clique repetido
  // Clique repetido logo depois de já ter tratado (a última mensagem nossa é
  // a pergunta do motivo): sem isso o 2º clique tiraria do Remarketing pra Perdido.
  const lastOut = await prisma.message.findFirst({
    where: { leadId, direction: 'OUTBOUND', channel: 'WHATSAPP' },
    orderBy: { createdAt: 'desc' },
    select: { content: true },
  });
  if (lastOut?.content?.includes(REASON_QUESTION_MARK)) return true;
  // Card já em contratação/concluído: botão antigo clicado fora de hora — deixa pro time.
  if (/contrata|conclu/i.test(lead.pipeline?.name || '')) return false;

  const button = text.trim();
  const lostReason = `Cliente tocou em "${button}"`;
  const { updateLead } = require('./lead.service') as typeof import('./lead.service');
  const { moveLeadToPerdidos } = require('./named-pipeline.service') as typeof import('./named-pipeline.service');
  await updateLead(lead.id, accountId, { status: 'LOST', lostReason }, io);
  await moveLeadToPerdidos({ accountId, leadId: lead.id, departmentId: lead.pipeline?.departmentId, byName: 'Assistente IA', userId: null, motivo: lostReason, io });
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_status_changed', leadId: lead.id, leadName: lead.name, summary: `marcou o card como Perdido: cliente tocou em "${button}"` });

  const nome = firstName(lead);
  const pergunta = `Tudo bem${nome ? `, ${nome}` : ''}, obrigado pelo retorno. Só pra gente melhorar: o motivo do seu desinteresse foi algo específico? O produto não era o que você procurava, as taxas não ficaram boas ou ficou faltando alguma opção de banco?`;
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const sent = await sendOutboundWhatsApp({ accountId, leadId: lead.id, content: pergunta, io });
  console.log(`[Sem interesse] ${lead.name}: Perdido + pergunta do motivo ${sent.success ? 'enviada' : 'FALHOU'}`);
  return true;
}

/** Resume a resposta do cliente num motivo curto pro card. */
async function summarizeReason(answer: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fallback = answer.trim().replace(/\s+/g, ' ').slice(0, 150);
  if (!apiKey) return fallback;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 2048,
        system: 'O cliente disse que não tem interesse num crédito/financiamento e explicou o motivo. Resuma o motivo em até 12 palavras, em português, sem aspas (ex.: "taxas altas", "já fechou com outro banco", "vai deixar pra depois"). Se ele mudou de ideia e quer seguir, responda exatamente: VOLTOU A TER INTERESSE. Responda só o resumo.',
        messages: [{ role: 'user', content: answer.slice(0, 2000) }],
      }),
    });
    const data: any = await res.json();
    const t = String(data?.content?.find((b: any) => b.type === 'text')?.text || '').trim().replace(/^["']|["']$/g, '');
    return t ? t.slice(0, 150) : fallback;
  } catch {
    return fallback;
  }
}

/** Primeira resposta do cliente (card Perdido ou no Remarketing) depois da pergunta do motivo
 *  — nossa ou do time, mesma frase: complementa o motivo da perda e vira
 *  nota no card. Não responde nada ao cliente. */
export async function maybeCaptureLostReason(accountId: string, leadId: string, text: string, io: any): Promise<void> {
  if (!text.trim()) return;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, lostReason: true } });
  if (!lead) return;
  const lastOut = await prisma.message.findFirst({
    where: { leadId, direction: 'OUTBOUND', channel: 'WHATSAPP' },
    orderBy: { createdAt: 'desc' },
    select: { content: true, createdAt: true },
  });
  if (!lastOut?.content?.includes(REASON_QUESTION_MARK)) return;
  if (Date.now() - lastOut.createdAt.getTime() > 7 * 24 * 60 * 60 * 1000) return;
  // Só a PRIMEIRA resposta depois da pergunta (a atual já está gravada).
  const answers = await prisma.message.count({ where: { leadId, direction: 'INBOUND', createdAt: { gt: lastOut.createdAt } } });
  if (answers > 1) return;
  const motivo = await summarizeReason(text);
  const voltou = /VOLTOU A TER INTERESSE/i.test(motivo);
  const base = (lead.lostReason || 'Sem interesse').replace(/\s+—\s+motivo:.*$/i, '');
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      lostReason: voltou ? `${base} — depois disse que quer seguir` : `${base} — motivo: ${motivo}`,
      notes: {
        create: {
          type: 'COMMENT',
          content: voltou
            ? `⚠️ O cliente estava sem interesse, mas respondeu que quer seguir: "${text.trim().slice(0, 300)}". Vale retomar o atendimento.`
            : `Motivo do desinteresse (resposta do cliente): ${motivo}\n"${text.trim().slice(0, 300)}"`,
        },
      },
    },
  });
  io?.to(`lead:${lead.id}`).emit('lead_updated', { leadId: lead.id });
  console.log(`[Sem interesse] ${lead.name}: motivo registrado — ${voltou ? 'VOLTOU A TER INTERESSE' : motivo}`);
}
