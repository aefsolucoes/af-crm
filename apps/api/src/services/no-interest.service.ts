import { PrismaClient } from '@prisma/client';
import { logActivity } from './activity.service';

/**
 * Cliente tocou em "Não tenho interesse" (botão dos templates de boas-vindas/
 * follow-up) — pedido do Fabio 26/09:
 *  1. o card vai pra Perdido na hora (sai do funil ativo → funil "Perdidos");
 *  2. a gente pergunta o motivo, na frase que ele mesmo usa com cliente;
 *  3. a resposta do cliente vira o motivo da perda no card.
 * O marcador "(motivo ainda não informado)" no lostReason é o que diz que
 * ainda estamos esperando essa resposta.
 */

const prisma = new PrismaClient();

const NO_INTEREST_RE = /^n[ãa]o,?\s*(tenho\s+(mais\s+)?interesse|obrigad[oa])\b/i;
const PENDING_REASON = '(motivo ainda não informado)';

function firstName(lead: { name: string; customFields: unknown }): string {
  const cf = (lead.customFields || {}) as Record<string, unknown>;
  const raw = String(cf.participante_1 || lead.name || '').trim().split(/\s+/)[0] || '';
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase() : '';
}

/** Retorna true se tratou o clique (quem chama não passa pra IA/automação). */
export async function handleNoInterestButton(accountId: string, leadId: string, text: string, io: any): Promise<boolean> {
  if (!NO_INTEREST_RE.test(text.trim())) return false;
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, accountId },
    select: { id: true, name: true, status: true, customFields: true, pipeline: { select: { name: true, departmentId: true } } },
  });
  if (!lead) return false;
  if (lead.status === 'LOST') return true; // clique repetido
  // Card já em contratação/concluído: botão antigo clicado fora de hora — deixa pro time.
  if (/contrata|conclu/i.test(lead.pipeline?.name || '')) return false;

  const button = text.trim();
  const lostReason = `Tocou em "${button}" ${PENDING_REASON}`;
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

/** Mensagem do cliente num card Perdido que ainda espera o motivo: vira o
 *  motivo da perda (e nota no card). Não responde nada ao cliente. */
export async function maybeCaptureLostReason(accountId: string, leadId: string, text: string, io: any): Promise<void> {
  if (!text.trim()) return;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId, status: 'LOST' }, select: { id: true, name: true, lostReason: true } });
  if (!lead?.lostReason?.includes(PENDING_REASON)) return;
  const motivo = await summarizeReason(text);
  const voltou = /VOLTOU A TER INTERESSE/i.test(motivo);
  const button = lead.lostReason.match(/"([^"]+)"/)?.[1] || 'Não tenho interesse';
  await prisma.lead.update({
    where: { id: lead.id },
    data: {
      lostReason: voltou ? `Tocou em "${button}", mas depois disse que quer seguir` : `${button} — ${motivo}`,
      notes: {
        create: {
          type: 'COMMENT',
          content: voltou
            ? `⚠️ O cliente tinha tocado em "${button}", mas respondeu que quer seguir: "${text.trim().slice(0, 300)}". Vale reabrir o card.`
            : `Motivo do desinteresse (resposta do cliente): ${motivo}\n"${text.trim().slice(0, 300)}"`,
        },
      },
    },
  });
  io?.to(`lead:${lead.id}`).emit('lead_updated', { leadId: lead.id });
  console.log(`[Sem interesse] ${lead.name}: motivo registrado — ${voltou ? 'VOLTOU A TER INTERESSE' : motivo}`);
}
