import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp } from './message.service';
import { contractingAutoOn, manualStep } from './contracting-auto.service';

type Io = Parameters<typeof sendOutboundWhatsApp>[0]['io'];

/**
 * CAIXA DEPOIS DA APROVAÇÃO (Fabio 21/10). Quase toda proposta lista a CAIXA entre os "Bancos solicitados" (em 30 dias: 87 de 94, 83 com os cinco bancos — marcação padrão do formulário). Decisão dele:
 * DEPOIS de mostrar a aprovação ao cliente (e só se algum banco aprovou), o CRM pergunta a quem tem a CAIXA na proposta se REALMENTE quer seguir pela CAIXA. O resto da sequência é da IA da conversa
 * (regra da CAIXA em ai-shared.CORE_RULES): quer mesmo → nome limpo? imóvel tem Habite-se? → só então avisa da documentação ANTECIPADA; nome sujo ou sem Habite-se = "na CAIXA essas são as regras, os bancos
 * privados podem aprovar". Esta função faz só a 1ª pergunta, UMA vez por card, e só pra aprovações avisadas DEPOIS do início da regra (não manda pra cliente antigo).
 */

export const CAIXA_ASK_FROM = new Date('2026-10-21T13:00:00Z');
const MIN_AFTER_NOTICE_MS = 15 * 60_000; // dá tempo do cliente reagir ao aviso de aprovação antes de perguntar da CAIXA
const MAX_AFTER_NOTICE_MS = 3 * 86_400_000; // depois de 3 dias o momento passou

/** A proposta do site lista a CAIXA entre os bancos solicitados? Pura (testável). */
export function listaCaixa(texto: string): boolean {
  return /Bancos solicitados:[^\n]*\bCAIXA\b/i.test(String(texto || ''));
}

export const caixaAskText = (): string => 'Vi que você marcou a CAIXA na sua proposta. Você realmente deseja seguir com a CAIXA?';

export async function processCaixaAsk(accountId: string, io: Io): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false AND l."aiAutoReplyActive" = true
      AND jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_autoNoticeAt') AND NOT jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_caixaAsk')
      AND (l."customFields"->>'_autoNoticeAt')::timestamptz >= ${CAIXA_ASK_FROM}
      AND (l."customFields"->>'_autoNoticeAt')::timestamptz <= now() - interval '15 minutes'
      AND (l."customFields"->>'_autoNoticeAt')::timestamptz >= now() - interval '3 days'
    LIMIT 20`;
  for (const { id } of ids) {
    try { await askOne(accountId, id, io); } catch (e: any) { console.warn('[CAIXA] pergunta:', e?.message); }
  }
}

async function marca(leadId: string, valor: Record<string, unknown>) {
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>), _caixaAsk: valor };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
}

async function askOne(accountId: string, leadId: string, io: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, aiAutoReplyActive: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead || !lead.aiAutoReplyActive) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._autoPaused || cf._caixaAsk) return;
  if (cf._bancosCombinados?.caixa) { await marca(leadId, { skip: 'CAIXA combinada com o cliente antes da proposta (documentação já pedida)', at: new Date().toISOString() }); return; }
  if (!/home equity/i.test(lead.pipeline?.department?.name || '')) { await marca(leadId, { skip: 'não é Home Equity', at: new Date().toISOString() }); return; }
  const prop = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Bancos solicitados' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  if (!prop || !listaCaixa(prop.content)) { await marca(leadId, { skip: 'a proposta não lista a CAIXA', at: new Date().toISOString() }); return; }
  // O cliente já falou da CAIXA por conta própria: a IA da conversa já está no assunto (não pergunta duas vezes).
  const falou = await prisma.message.count({ where: { leadId, direction: 'INBOUND', content: { contains: 'caixa', mode: 'insensitive' }, NOT: { content: { contains: 'Bancos solicitados' } } } });
  if (falou > 0) { await marca(leadId, { skip: 'o cliente já falou da CAIXA', at: new Date().toISOString() }); return; }
  // Chave geral desligada (Fabio 22/10): a equipe faz a triagem da CAIXA à mão; o texto vai pronto na nota.
  if (!(await contractingAutoOn(accountId))) {
    await manualStep({ accountId, leadId, leadName: lead.name, step: 'caixa', pushTitle: '🏦 Proposta lista a CAIXA', pushBody: `${lead.name}: perguntar se quer mesmo seguir pela CAIXA`,
      note: `🏦 A proposta lista a CAIXA e o cliente já foi avisado da aprovação: pergunte se ele quer mesmo seguir pela CAIXA. Passo manual (automação da contratação desligada). Texto pronto:\n“${caixaAskText().replace(/\n+/g, ' ')}”` });
    await marca(leadId, { teamAt: new Date().toISOString(), por: 'equipe (automação da contratação desligada)' });
    return;
  }
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow() || !(await whatsappWindowOpen(leadId))) return; // tenta de novo no próximo minuto (até 3 dias depois do aviso)
  const r = await sendOutboundWhatsApp({ accountId, leadId, content: caixaAskText(), io: io as any });
  if (!r.success) return;
  await marca(leadId, { askedAt: new Date().toISOString() });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '🏦 A proposta lista a CAIXA: depois do aviso de aprovação, perguntei ao cliente se realmente quer seguir pela CAIXA. A IA segue a sequência: quer mesmo? → nome limpo e Habite-se → documentação antecipada (ou: na CAIXA essas são as regras, os bancos privados podem aprovar).' } }).catch(() => {});
}
