import { prisma } from '../lib/prisma';
import { sendOutboundWhatsAppTemplate, sendOutboundWhatsApp } from './message.service';
import { logActivity } from './activity.service';

/* "Ainda deseja prosseguir com o crédito?" (template ainda_deseja_prosseguir, Utilidade, botões "Sim, tenho interesse" / "Não tenho interesse") — Fabio 28/10.
 *  - Disparo: clientes de Home Equity que JÁ estavam em "Aguardando Documentação" em 28/10 ("quando criar, pode encaminhar aos clientes que estão em aguardando
 *    documentação"). Só sai depois que a Meta aprova o template, das 07h às 21h, e espera quem falou com a gente nos últimos 2 dias ou acabou de entrar na etapa.
 *  - "Não tenho interesse": o fluxo de sempre (no-interest.service: Perdido + pergunta do motivo) + etiqueta "Aprovado sem andamento".
 *  - "Sim, tenho interesse": liga a IA do card e confere a documentação — o cliente recebe o que falta (ou "recebi tudo"); sem nenhum arquivo, a IA responde.
 *    Se ele continuar sem completar, o lembrete de documentos de sempre (automação de 3 em 3 dias, template follow_up_doc) roda mais 3 vezes e então este template
 *    sai de novo (processProsseguir). */

export const PROSSEGUIR_TEMPLATE = 'ainda_deseja_prosseguir';
const PROSSEGUIR_TEXT = 'Ainda deseja prosseguir com o crédito?';
export const TAG_APROVADO_SEM_ANDAMENTO = 'Aprovado sem andamento';
const DOC_REMINDER_TEMPLATE = 'follow_up_doc';
const LEMBRETES_ANTES_DE_REPETIR = 3;
const DIA = 86_400_000;
const BRT = -3 * 3_600_000;
// Disparo único: só cards que já estavam na etapa em 28/10; a campanha tenta até 04/11 (quem estava conversando recebe quando a conversa esfriar).
const CAMPANHA_CORTE = Date.parse('2026-10-29T03:00:00Z');
const CAMPANHA_ATE = Date.parse('2026-11-05T03:00:00Z');
const POR_RODADA = 10;

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
export type ProsseguirState = { enviadoAt?: string; vezes?: number; simAt?: string | null };

const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const emHorario = (ms = Date.now()) => { const h = new Date(ms + BRT).getUTCHours(); return h >= 7 && h < 21; };

/** Manda o template e guarda no card (`_prosseguir`). */
export async function sendProsseguir(accountId: string, leadId: string, motivo: string, io?: Io): Promise<boolean> {
  const r = await sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: PROSSEGUIR_TEMPLATE, language: 'pt_BR', bodyParams: [], previewText: PROSSEGUIR_TEXT, io: io || undefined });
  const fresh = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = { ...((fresh?.customFields || {}) as Record<string, any>) };
  const p = (cf._prosseguir || {}) as ProsseguirState;
  if (!r.success) {
    cf._prosseguir = { ...p, falhaAt: new Date().toISOString(), falha: String(r.error || '').slice(0, 160) };
    await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
    console.error(`[Prosseguir] ${leadId}: template não saiu — ${r.error}`);
    return false;
  }
  cf._prosseguir = { enviadoAt: new Date().toISOString(), vezes: (p.vezes || 0) + 1, simAt: null };
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📨 Mandei o template "${PROSSEGUIR_TEXT}" (botões Sim / Não) — ${motivo}.` } }).catch(() => {});
  return true;
}

/** É resposta ao template? (o último envio dele ainda não foi respondido com "Sim") */
function esperandoResposta(p: ProsseguirState | undefined): boolean {
  if (!p?.enviadoAt) return false;
  return !p.simAt || Date.parse(p.simAt) < Date.parse(p.enviadoAt);
}

/** "Não tenho interesse" ao template (chamado pelo no-interest.service depois do Perdido): etiqueta "Aprovado sem andamento". */
export async function tagAprovadoSemAndamento(leadId: string, estavaEm: string, cf: Record<string, any>): Promise<void> {
  if (!norm(estavaEm).includes('aguardando documentacao') && !esperandoResposta(cf._prosseguir)) return;
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { tags: true } });
  if (!l || l.tags.includes(TAG_APROVADO_SEM_ANDAMENTO)) return;
  await prisma.lead.update({ where: { id: leadId }, data: { tags: [...l.tags, TAG_APROVADO_SEM_ANDAMENTO] } });
}

/** "Sim, tenho interesse" ao template: liga a IA e confere a documentação. `responderComIa` = a resposta normal da IA (quando a conferência não tem o que dizer). */
export async function handleProsseguirYes(accountId: string, leadId: string, text: string, io: Io, responderComIa: () => Promise<unknown>): Promise<boolean> {
  if (!/^sim,?\s*tenho interesse[.!]?$/i.test(text.trim())) return false;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true, stage: { select: { name: true } } } });
  if (!lead) return false;
  const cf = { ...((lead.customFields || {}) as Record<string, any>) };
  if (!esperandoResposta(cf._prosseguir) || !norm(lead.stage.name).includes('aguardando documentacao')) return false;
  if (cf._autoPaused) return false; // STOP TOTAL: ninguém responde sozinho
  cf._prosseguir = { ...cf._prosseguir, simAt: new Date().toISOString() };
  await prisma.lead.update({ where: { id: leadId }, data: { aiAutoReplyActive: true, customFields: cf as any } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `✅ Cliente respondeu "Sim, tenho interesse" ao "${PROSSEGUIR_TEXT}". IA do card ligada; conferindo a documentação pra dizer o que falta.` } }).catch(() => {});
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId, leadName: lead.name, summary: 'cliente quer prosseguir: IA ligada e documentação conferida' });
  const arquivos = await prisma.messageAttachment.count({ where: { leadId, message: { direction: 'INBOUND' } } });
  (async () => {
    let falou = false;
    if (arquivos) {
      // A leitura dos arquivos leva alguns minutos: avisa antes, pra ele não ficar sem resposta.
      await sendOutboundWhatsApp({ accountId, leadId, content: 'Ótimo! Vou conferir aqui os documentos que você já mandou e já te digo o que falta.', io: io || undefined });
      const { checkDocsComplete } = require('./docs-checker.service') as typeof import('./docs-checker.service');
      falou = await checkDocsComplete(accountId, leadId, io as any, { force: true }).catch((e) => { console.error('[Prosseguir] conferência:', e?.message || e); return false; });
    }
    if (!falou) await responderComIa();
  })().catch((e) => console.error('[Prosseguir] resposta ao Sim:', e?.message || e));
  return true;
}

let aprovadoNaMeta = false;
let ultimaConsultaMeta = 0;
async function templateAprovado(accountId: string): Promise<boolean> {
  if (aprovadoNaMeta) return true;
  if (Date.now() - ultimaConsultaMeta < 15 * 60_000) return false;
  ultimaConsultaMeta = Date.now();
  try {
    const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
    const t = (await listMetaTemplates(accountId)).find((x: any) => x?.name === PROSSEGUIR_TEMPLATE);
    aprovadoNaMeta = String(t?.status || '').toUpperCase() === 'APPROVED';
  } catch (e: any) { console.error('[Prosseguir] status do template na Meta:', e?.message || e); }
  return aprovadoNaMeta;
}

/** Poller (1 min): a campanha de 28/10 e o reenvio depois de 3 lembretes de documentação sem resposta. */
export async function processProsseguir(accountId: string, io?: Io): Promise<void> {
  if (!emHorario() || !(await templateAprovado(accountId))) return;
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, isGroup: false, stage: { name: { contains: 'aguardando document', mode: 'insensitive' } }, pipeline: { department: { name: { contains: 'home equity', mode: 'insensitive' } } } },
    select: { id: true, name: true, stageEnteredAt: true, customFields: true },
  });
  let enviados = 0;
  for (const l of leads) {
    if (enviados >= POR_RODADA) break;
    const cf = (l.customFields || {}) as Record<string, any>;
    if (cf._autoPaused) continue;
    const p = cf._prosseguir as (ProsseguirState & { falhaAt?: string }) | undefined;
    if (p?.falhaAt && Date.now() - Date.parse(p.falhaAt) < DIA) continue; // falhou (sem telefone, Meta recusou): tenta de novo amanhã
    const lastIn = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'INBOUND' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    const conversando = !!lastIn && Date.now() - lastIn.createdAt.getTime() < 2 * DIA;
    let motivo = '';
    if (!p?.enviadoAt) {
      // Campanha: só quem já estava na etapa em 28/10, até 04/11; quem acabou de entrar ou está conversando espera.
      if (Date.now() > CAMPANHA_ATE || !l.stageEnteredAt || l.stageEnteredAt.getTime() > CAMPANHA_CORTE) continue;
      if (conversando || Date.now() - l.stageEnteredAt.getTime() < 3 * DIA) continue;
      motivo = 'campanha pros clientes em Aguardando Documentação (Fabio 28/10)';
    } else if (p.simAt && Date.parse(p.simAt) >= Date.parse(p.enviadoAt)) {
      // Disse "Sim": depois de 3 lembretes de documentação sem completar, pergunta de novo — na hora em que sairia o 4º.
      const lembretes = await prisma.message.findMany({ where: { leadId: l.id, direction: 'OUTBOUND', templateName: DOC_REMINDER_TEMPLATE, createdAt: { gt: new Date(p.simAt) } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      if (lembretes.length < LEMBRETES_ANTES_DE_REPETIR || Date.now() - lembretes[0].createdAt.getTime() < 3 * DIA || conversando) continue;
      motivo = `${lembretes.length} lembretes de documentação depois do "Sim" e a documentação não completou`;
    } else continue; // já perguntou e ele ainda não respondeu: o lembrete de documentos de sempre segue
    if (await sendProsseguir(accountId, l.id, motivo, io)) enviados++;
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (enviados) console.log(`[Prosseguir] ${enviados} template(s) "${PROSSEGUIR_TEXT}" enviado(s)`);
}
