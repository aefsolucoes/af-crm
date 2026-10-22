import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

/**
 * VENDA FUTURA COM DATA (Fabio 16/10). O cliente que quer o crédito mas NÃO agora combina com a IA a melhor data pra retomar (a IA pergunta; ver ventaFuturaRules em
 * ai-auto-reply.service): a data vira `customFields._vendaFuturaAt` (AAAA-MM-DD). Aqui o poller manda a mensagem de retomada:
 *   • no DIA combinado (07h–21h, Brasília);
 *   • depois, de 30 em 30 dias (ou de 30 em 30 desde a entrada na etapa, se o cliente não quis marcar data), ATÉ o cliente responder (clicar num botão ou escrever) — quem responde passa
 *     a ser atendido pela IA ("Quero retomar" → Prospecção; "ainda não" → nova data); se ele ficar em silêncio de novo, a contagem de 30 dias recomeça da última fala dele.
 * Fora da janela de 24 h do WhatsApp sai o template `venda_futura_retomada`; dentro dela, texto livre. Card com a IA desligada ou "Pediu pra parar lembretes" não recebe (nota + push).
 * Estado no card: _vendaFuturaAt (data combinada), _vendaFuturaSentAt (última mensagem), _vendaFuturaBaseAt (marco inicial dos cards antigos), _vendaFuturaCount.
 */
type Cf = Record<string, any>;
type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

export const VENDA_FUTURA_TEMPLATE = 'venda_futura_retomada';
const EVERY_MS = 30 * 86_400_000;
const WINDOW_MS = 23 * 3_600_000;
const BRT_MS = 3 * 3_600_000;
const STOP_TAG = 'Pediu pra parar lembretes';
const SEND_GAP_MS = 3_000;
const PER_TICK = 25;

/** Quando o card deve receber a mensagem de retomada: 'DATA' (dia combinado chegou) | 'CICLO' (30 dias sem contato) | null. Pura (testável). */
export function vendaFuturaDue(p: { cf: Cf; stageEnteredAt: Date | null; lastInboundAt: Date | null; now?: number }): 'DATA' | 'CICLO' | null {
  const now = p.now ?? Date.now();
  const sent = p.cf._vendaFuturaSentAt ? new Date(p.cf._vendaFuturaSentAt).getTime() : 0;
  const at = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(p.cf._vendaFuturaAt || ''));
  if (at) {
    const inicio = Date.UTC(Number(at[1]), Number(at[2]) - 1, Number(at[3])) + BRT_MS; // 00h de Brasília do dia combinado
    return now >= inicio && sent < inicio ? 'DATA' : null;
  }
  const base = Math.max(p.stageEnteredAt?.getTime() || 0, sent, p.cf._vendaFuturaBaseAt ? new Date(p.cf._vendaFuturaBaseAt).getTime() : 0, p.lastInboundAt?.getTime() || 0);
  return base && now - base >= EVERY_MS ? 'CICLO' : null;
}

let tplCache: { at: number; ok: boolean; body: string | null } | null = null;
/** O template de retomada está APROVADO na Meta? (cache de 10 min) — enquanto não estiver, o poller não envia nada fora da janela. */
async function templateStatus(accountId: string): Promise<{ ok: boolean; body: string | null }> {
  if (tplCache && Date.now() - tplCache.at < 10 * 60_000) return tplCache;
  try {
    const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
    const t = (await listMetaTemplates(accountId)).find((x: any) => x.name === VENDA_FUTURA_TEMPLATE);
    tplCache = { at: Date.now(), ok: t?.status === 'APPROVED', body: t?.components?.find((c: any) => c.type === 'BODY')?.text || null };
  } catch { tplCache = { at: Date.now(), ok: false, body: null }; }
  return tplCache;
}

const hasPhone = (c: { whatsappPhone: string | null; phone: string | null } | null) => {
  const d = String(c?.whatsappPhone || c?.phone || '').replace(/\D/g, '');
  return d.length >= 10 && !/@lid/.test(String(c?.whatsappPhone || ''));
};

async function saveCf(leadId: string, mut: (cf: Cf) => void, extra: Record<string, unknown> = {}) {
  const f = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((f?.customFields || {}) as Cf) };
  mut(cf);
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any, ...extra } });
}

let running = false;
/** Poller (1 min, index.ts): manda a retomada dos cards em Venda Futura que venceram. */
export async function processVendaFutura(io: Io): Promise<void> {
  if (running) return;
  running = true;
  try {
    const hh = new Date(Date.now() - BRT_MS).getUTCHours();
    if (hh < 7 || hh >= 21) return; // horário da A&F (07h–21h)
    const leads = await prisma.lead.findMany({
      where: { status: 'OPEN', archived: false, isGroup: false, stage: { name: { contains: 'Venda Futura', mode: 'insensitive' } }, messages: { some: {} }, NOT: { tags: { has: STOP_TAG } } },
      select: { id: true, accountId: true, name: true, aiAutoReplyActive: true, stageEnteredAt: true, customFields: true, contact: { select: { name: true, whatsappPhone: true, phone: true } } },
      take: 300,
    });
    let enviados = 0;
    for (const l of leads) {
      if (enviados >= PER_TICK) break;
      const cf = (l.customFields || {}) as Cf;
      const lastIn = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      const due = vendaFuturaDue({ cf, stageEnteredAt: l.stageEnteredAt, lastInboundAt: lastIn?.createdAt || null });
      if (!due) continue;
      if (!hasPhone(l.contact)) continue;
      if (cf._vendaFuturaFailAt && Date.now() - new Date(cf._vendaFuturaFailAt).getTime() < 10 * 60_000) continue; // falhou há pouco: tenta de novo em 10 min
      const hoje = new Date(Date.now() - BRT_MS).toISOString().slice(0, 10);
      // IA desligada no card, ou STOP TOTAL no cliente = nada automático pro cliente (Fabio 15/10): avisa a equipe uma vez por dia. O STOP TOTAL antes pulava o card em silêncio e a data marcada
      // à mão (Fabio 22/10, Ronaldo/Andrea: "preciso mandar uma msg na segunda") nunca avisava ninguém.
      if (!l.aiAutoReplyActive || cf._autoPaused) {
        if (cf._vendaFuturaNotifiedAt !== hoje) {
          await saveCf(l.id, (c) => { c._vendaFuturaNotifiedAt = hoje; });
          await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `📅 Chegou a hora de retomar o crédito deste cliente (Venda Futura${due === 'DATA' ? `, data combinada ${String(cf._vendaFuturaAt).split('-').reverse().join('/')}` : ', 30 dias sem contato'}), mas ${cf._autoPaused ? 'o cliente está com STOP TOTAL' : 'a IA está desligada neste card'} — NÃO mandei. Fale com o cliente.` } }).catch(() => {});
          try { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(l.accountId, { title: l.name, body: `Hora de retomar o crédito (Venda Futura) — ${cf._autoPaused ? 'STOP TOTAL' : 'IA desligada'}, fale com o cliente`, leadId: l.id }).catch(() => {}); } catch { /* push é extra */ }
        }
        continue;
      }
      const { remarketingFirstName } = require('./remarketing.service') as typeof import('./remarketing.service');
      const nome = remarketingFirstName({ name: l.name, customFields: cf, contact: l.contact });
      const aberta = !!lastIn && Date.now() - lastIn.createdAt.getTime() < WINDOW_MS;
      let result: { success: boolean; error?: string };
      let previewText = '';
      if (aberta) {
        previewText = `${nome ? `Oi, ${nome}! ` : 'Oi! '}Tudo bem? Combinamos de retomar o seu crédito por esta época. Como estão os planos? Se já estiver na hora, é só me responder por aqui que eu continuo de onde paramos. 😊`;
        const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
        result = await sendOutboundWhatsApp({ accountId: l.accountId, leadId: l.id, content: previewText, io: (io || undefined) as any }) as any;
      } else {
        if (!nome) continue; // sem nome apresentável o template ({{1}}) não sai
        const tpl = await templateStatus(l.accountId);
        if (!tpl.ok) continue; // template ainda não aprovado pela Meta
        previewText = (tpl.body || 'Template de retomada').replace(/\{\{1\}\}/g, nome) + '\n\n[Quero retomar]  [Ainda não é o momento]';
        const { sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
        result = await sendOutboundWhatsAppTemplate({ accountId: l.accountId, leadId: l.id, templateName: VENDA_FUTURA_TEMPLATE, language: 'pt_BR', bodyParams: [nome], previewText, io: (io || undefined) as any }) as any;
      }
      enviados++;
      if (result.success) {
        await saveCf(l.id, (c) => { c._vendaFuturaSentAt = new Date().toISOString(); delete c._vendaFuturaAt; c._vendaFuturaCount = Number(c._vendaFuturaCount || 0) + 1; c._vendaFuturaFails = 0; }, { aiAutoReplyActive: true });
        await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `📅 Venda Futura: mandei a mensagem de retomada (${aberta ? 'texto livre, janela aberta' : `template ${VENDA_FUTURA_TEMPLATE}`}) — ${due === 'DATA' ? 'chegou o dia combinado com o cliente' : '30 dias desde o último contato'}. Repete de 30 em 30 dias até o cliente responder.` } }).catch(() => {});
        logActivity({ accountId: l.accountId, userId: null, userName: 'Venda Futura', action: 'lead_edited', leadId: l.id, leadName: l.name, summary: 'mandou a mensagem de retomada (Venda Futura)' } as any);
        // Aviso da equipe (Fabio 22/10: "agendamentos em push"): a retomada combinada saiu — a conversa volta a andar e alguém precisa acompanhar.
        try { const { sendPushToAccount } = require('./push.service') as typeof import('./push.service'); sendPushToAccount(l.accountId, { title: `📅 Retomada enviada: ${l.name}`.slice(0, 90), body: `Venda Futura${due === 'DATA' ? ' (data combinada)' : ''} — mandei a mensagem de retomada ao cliente`, leadId: l.id }).catch(() => {}); } catch { /* push é extra */ }
        console.log(`[Venda Futura] ${l.name}: retomada enviada (${due})`);
      } else {
        const fails = Number(cf._vendaFuturaFails || 0) + 1;
        console.error(`[Venda Futura] ${l.name}: falha no envio (${fails}/3): ${(result as any).error}`);
        if (fails >= 3) {
          await saveCf(l.id, (c) => { c._vendaFuturaSentAt = new Date().toISOString(); delete c._vendaFuturaAt; c._vendaFuturaFails = 0; });
          await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `⚠️ Venda Futura: o WhatsApp não aceitou a mensagem de retomada 3 vezes (${(result as any).error}). Tento de novo em 30 dias.` } }).catch(() => {});
        } else {
          await saveCf(l.id, (c) => { c._vendaFuturaFails = fails; c._vendaFuturaFailAt = new Date().toISOString(); });
        }
      }
      await new Promise((r) => setTimeout(r, SEND_GAP_MS));
    }
  } finally {
    running = false;
  }
}

/** Card REPROVADO por motivo temporário que a equipe mandou pra Venda Futura (balão "Dúvidas da IA" → `_rejDecision`): vai pra etapa Venda Futura (em vez de Perdidos), a IA fica ligada e,
 *  com a janela aberta, o cliente já recebe a pergunta da melhor data pra tentar de novo (janela fechada: a IA pergunta quando ele responder — o contexto diz "Venda Futura sem data"). */
export async function rejectedToVendaFutura(p: { accountId: string; leadId: string; reasons?: string[]; io?: Io }): Promise<boolean> {
  const lead = await prisma.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true, name: true, status: true, pipelineId: true, customFields: true, stage: { select: { name: true } } } });
  if (!lead || lead.status !== 'OPEN') return false;
  const vf = await prisma.stage.findFirst({ where: { pipelineId: lead.pipelineId, name: { contains: 'Venda Futura', mode: 'insensitive' } }, select: { id: true, name: true } });
  if (!vf) { await prisma.note.create({ data: { leadId: lead.id, type: 'COMMENT', content: '⚠️ A equipe mandou pra Venda Futura, mas este funil não tem a etapa. Mova à mão.' } }).catch(() => {}); return false; }
  const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
  await updateLeadStage(lead.id, p.accountId, vf.id);
  await saveCf(lead.id, (c) => { c._vendaFuturaBaseAt = new Date().toISOString(); delete c._vendaFuturaAt; delete c._rejQuestionAt; delete c._autoCloseAfterNotice; }, { aiAutoReplyActive: true });
  const motivos = (p.reasons || []).join('; ');
  await prisma.note.create({ data: { leadId: lead.id, type: 'STAGE_CHANGE', content: `Estágio: "${lead.stage?.name || '?'}" → "${vf.name}" — reprovado por motivo temporário${motivos ? ` (${motivos})` : ''}; a equipe decidiu Venda Futura. A IA pergunta ao cliente a melhor data pra tentar de novo.` } }).catch(() => {});
  logActivity({ accountId: p.accountId, userId: null, userName: 'Análise automática', action: 'lead_stage_changed', leadId: lead.id, leadName: lead.name, summary: 'reprovado por motivo temporário → Venda Futura' } as any);
  const last = await prisma.message.findFirst({ where: { leadId: lead.id, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
  if (last && Date.now() - last.createdAt.getTime() < WINDOW_MS) {
    const saldo = /saldo devedor/i.test(motivos), minimo = /abaixo do m[ií]nimo/i.test(motivos);
    const ex = saldo && minimo ? 'quitando o saldo devedor do imóvel ou com outro valor de imóvel' : saldo ? 'quitando o saldo devedor do imóvel' : minimo ? 'com outro valor de imóvel' : 'se a sua situação mudar';
    const texto = `Se a situação mudar (por exemplo ${ex}), a gente consegue tentar de novo. Qual seria a melhor data pra gente tratar o seu crédito novamente? Pode ser um mês ou uma data certinha.`;
    const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
    await sendOutboundWhatsApp({ accountId: p.accountId, leadId: lead.id, content: texto, io: (p.io || undefined) as any }).catch(() => {});
  }
  return true;
}
