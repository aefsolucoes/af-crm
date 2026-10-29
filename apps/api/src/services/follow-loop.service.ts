import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';
import { diasDesde, ultimaConversa } from './docs-loop.service';

/* Follow Up no esquema do Aguardando Documentação (Fabio 29/10) — Home Equity e Financiamento Habitacional (só leads do site):
 *  - Prospecção, 1 dia sem conversa: Follow Up 1 e o card vai pra Follow Up · +3 dias: Follow Up 2 · +3: Follow Up 3 ·
 *    +3, +1, +1: "Ainda deseja prosseguir com o crédito?" (o template já aprovado) · +1 dia sem resposta: vai pra Lead Sem Retorno (sem loop —
 *    "não precisa fazer loop, vai direto para Lead Sem Retorno"; lá segue o Remarketing).
 *  - Conversa de verdade no meio (cliente ou equipe à mão): recomeça do Follow Up 1 depois de 2 dias parado.
 *  - "Vou preencher depois": a IA pergunta quando; com data (`_followPrazo`) espera até ela; sem resposta, 2 dias parado e volta pro Follow Up 1.
 *  - "Não tenho interesse" → Perdido (no-interest.service); "Sim, tenho interesse" → as 3 opções (dúvidas / simulação / aprovação) de sempre.
 *  - Preencheu a proposta → o card vai pra Pré-Análise e sai daqui.
 *  - Envia das 07h às 10h (Fabio 29/10: "coloca os dois para as 07"). Entra no ar quando a Meta aprovar os 3 templates; aí as regras antigas de Prospecção/Follow Up param. */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
type Lembrete = { template: string; texto: (nome: string) => string; botoes: string[]; email: { assunto: string; titulo: string; paragrafos: string[]; destaque: string } };

export const FOLLOW_LEMBRETES: Lembrete[] = [
  {
    template: 'follow_lembrete_1',
    texto: (n) => `Olá, ${n}! Vi que você fez uma simulação de crédito. Quer que eu te ajude a concluir a proposta? Leva só alguns minutos.`,
    botoes: ['Quero concluir', 'Tenho uma dúvida'],
    email: {
      assunto: '📝 Falta pouco: conclua sua proposta de crédito',
      titulo: 'Sua simulação está pronta — falta só a proposta',
      paragrafos: ['Você fez uma simulação de crédito com a A&F. Com a proposta preenchida, a gente faz a pré-análise nos bancos parceiros e te mostra as condições.', 'Leva só alguns minutos.'],
      destaque: 'A pré-análise não tem custo e não compromete nada.',
    },
  },
  {
    template: 'follow_lembrete_2',
    texto: (n) => `Oi, ${n}! Sua simulação de crédito ainda está aberta. Com a proposta preenchida, a gente já faz a pré-análise nos bancos parceiros, sem custo.`,
    botoes: ['Quero concluir', 'Agora não'],
    email: {
      assunto: '⏳ Sua simulação de crédito ainda está aberta',
      titulo: 'Sua simulação ainda está esperando por você',
      paragrafos: ['Preenchendo a proposta, a gente leva o seu pedido pros bancos parceiros e compara as condições pra você.', 'Se preferir, é só chamar a gente no WhatsApp que ajudamos a preencher.'],
      destaque: 'Pré-análise sem custo, em vários bancos ao mesmo tempo.',
    },
  },
  {
    template: 'follow_lembrete_3',
    texto: (n) => `Oi, ${n}! Ficou alguma dúvida sobre o crédito? Posso te explicar as condições e te ajudar a preencher a proposta por aqui.`,
    botoes: ['Quero ajuda', 'Agora não'],
    email: {
      assunto: '💬 Ficou alguma dúvida sobre o seu crédito?',
      titulo: 'A gente te ajuda a concluir',
      paragrafos: ['Se ficou alguma dúvida sobre taxa, prazo ou documentos, fala com a gente: explicamos tudo e ajudamos a preencher a proposta.'],
      destaque: 'Atendimento pelo WhatsApp, no seu tempo.',
    },
  },
];

type Passo = { tipo: 0 | 1 | 2 | 'PROSSEGUIR' | 'SEM_RETORNO'; dias: number };
const PASSOS: Passo[] = [
  { tipo: 0, dias: 1 }, // 1 dia sem conversa (como o "Follow-up manhã seguinte" antigo)
  { tipo: 1, dias: 3 },
  { tipo: 2, dias: 3 },
  { tipo: 'PROSSEGUIR', dias: 3 },
  { tipo: 'PROSSEGUIR', dias: 1 },
  { tipo: 'PROSSEGUIR', dias: 1 },
  { tipo: 'SEM_RETORNO', dias: 1 },
];
const PARADO = 2; // conversa no meio → recomeça do Follow Up 1 depois de 2 dias parado
const POR_RODADA = 15;
const BRT = -3 * 3_600_000;
const LINK_PROPOSTA = { he: 'https://aefsolucoesfinanceiras.com.br/proposta-manual-home-equity', fh: 'https://aefsolucoesfinanceiras.com.br/proposta-manual' };

export type FollowLoopState = { passo: number; ultimoAt?: string };

const emHorario = () => { const h = new Date(Date.now() + BRT).getUTCHours(); return h >= 7 && h < 10; }; // 07h, junto com o loop de documentos (Fabio 29/10)
const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export const ehEtapaFollow = (stageName: string) => /^(prospec|follow up)/.test(norm(stageName));

let ativo = false;
let ultimaConsulta = 0;
export async function followLoopAtivo(accountId: string): Promise<boolean> {
  if (ativo) return true;
  if (Date.now() - ultimaConsulta < 15 * 60_000) return false;
  ultimaConsulta = Date.now();
  try {
    const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
    const lista = await listMetaTemplates(accountId);
    ativo = FOLLOW_LEMBRETES.every((l) => String(lista.find((t: any) => t?.name === l.template)?.status || '').toUpperCase() === 'APPROVED');
    if (ativo) console.log('[Loop do Follow Up] templates aprovados — o loop assumiu Prospecção/Follow Up');
  } catch (e: any) { console.error('[Loop do Follow Up] status dos templates:', e?.message || e); }
  return ativo;
}

/** Poller (1 min, 07h–10h). */
export async function processFollowLoop(accountId: string, io?: Io): Promise<void> {
  if (!emHorario() || !(await followLoopAtivo(accountId))) return;
  const leads = await prisma.lead.findMany({
    where: {
      accountId, status: 'OPEN', archived: false, isGroup: false, messages: { some: {} },
      NOT: { tags: { has: 'Pediu pra parar lembretes' } },
      pipeline: { name: { contains: 'vendas', mode: 'insensitive' } },
      OR: [
        { pipeline: { department: { name: { contains: 'home equity', mode: 'insensitive' } } } },
        { pipeline: { department: { name: { contains: 'habitacional', mode: 'insensitive' } } }, tags: { has: 'Site' } }, // Financiamento: só leads do site
      ],
    },
    select: { id: true, name: true, createdAt: true, customFields: true, pipelineId: true, stage: { select: { name: true } }, pipeline: { select: { department: { select: { name: true } } } } },
  });
  let enviados = 0;
  for (const l of leads) {
    if (enviados >= POR_RODADA) break;
    if (!ehEtapaFollow(l.stage?.name || '')) continue;
    const cf = (l.customFields || {}) as Record<string, any>;
    if (cf._autoPaused) continue;
    const st: FollowLoopState = cf._followLoop && typeof cf._followLoop.passo === 'number' ? cf._followLoop : { passo: 0 };
    const conversa = await ultimaConversa(l.id);
    const ultimo = st.ultimoAt ? new Date(st.ultimoAt) : null;
    let passo = Math.min(st.passo, PASSOS.length - 1);
    let base: Date;
    let dias: number;
    if (!ultimo || (conversa && conversa > ultimo)) {
      // Começo (Follow Up 1): 1 dia sem conversa; se já tinha rodado e o cliente conversou no meio, 2 dias parado.
      passo = 0;
      base = conversa || l.createdAt;
      dias = ultimo ? PARADO : PASSOS[0].dias;
      // Não empilha com template nosso de ontem/hoje (boas-vindas, lembrete antigo de antes do loop…).
      const tpl = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'OUTBOUND', templateName: { not: null }, status: { not: 'FAILED' } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      if (tpl && diasDesde(tpl.createdAt) < 1) continue;
    } else {
      base = ultimo;
      dias = PASSOS[passo].dias;
    }
    if (diasDesde(base) < dias) continue;
    if (cf._followPrazo && Date.now() < Date.parse(cf._followPrazo)) continue; // cliente disse quando preenche: espera a data
    const ok = await executarPasso(accountId, l, cf, PASSOS[passo], io);
    if (!ok) continue;
    enviados++;
    const fresh = await prisma.lead.findUnique({ where: { id: l.id }, select: { customFields: true } });
    const c = { ...((fresh?.customFields || {}) as Record<string, any>) };
    if (PASSOS[passo].tipo === 'SEM_RETORNO') delete c._followLoop;
    else c._followLoop = { passo: passo + 1, ultimoAt: new Date().toISOString() } satisfies FollowLoopState;
    if (c._followPrazo && Date.now() >= Date.parse(c._followPrazo)) delete c._followPrazo;
    await prisma.lead.update({ where: { id: l.id }, data: { customFields: c as any } });
  }
}

async function moverPara(accountId: string, leadId: string, pipelineId: string, rx: RegExp, motivo: string, io: Io): Promise<string | null> {
  const etapa = (await prisma.stage.findMany({ where: { pipelineId }, orderBy: { order: 'asc' }, select: { id: true, name: true } })).find((s) => rx.test(norm(s.name)));
  if (!etapa) return null;
  const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
  await updateLeadStage(leadId, accountId, etapa.id);
  await prisma.note.create({ data: { leadId, type: 'STAGE_CHANGE', content: `🔁 Card movido pra "${etapa.name}" — ${motivo}` } }).catch(() => {});
  io?.to(`lead:${leadId}`).emit('lead_moved', { leadId, stageId: etapa.id });
  return etapa.name;
}

async function executarPasso(
  accountId: string,
  l: { id: string; name: string; pipelineId: string; stage: { name: string } | null; pipeline: { department: { name: string } | null } | null },
  cf: Record<string, any>,
  passo: Passo,
  io: Io,
): Promise<boolean> {
  if (passo.tipo === 'SEM_RETORNO') {
    const foi = await moverPara(accountId, l.id, l.pipelineId, /^lead sem retorno/, 'sem resposta depois dos 3 Follow Ups e dos 3 "Ainda deseja prosseguir?"', io);
    if (foi) logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_stage_changed', leadId: l.id, leadName: l.name, summary: `sem resposta ao Follow Up: card pra "${foi}"` });
    return !!foi;
  }
  if (passo.tipo === 'PROSSEGUIR') {
    const { sendProsseguir } = require('./prosseguir.service') as typeof import('./prosseguir.service');
    return sendProsseguir(accountId, l.id, 'loop do Follow Up', io);
  }
  const lembrete = FOLLOW_LEMBRETES[passo.tipo];
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, l.name) || 'tudo bem';
  const texto = lembrete.texto(nome);
  const preview = `${texto}\n\n${lembrete.botoes.map((b) => `[${b}]`).join('  ')}`;
  const { whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const { sendOutboundWhatsApp, sendOutboundWhatsAppTemplate, sendOutboundEmail } = require('./message.service') as typeof import('./message.service');
  const r = (await whatsappWindowOpen(l.id))
    ? await sendOutboundWhatsApp({ accountId, leadId: l.id, content: texto, buttons: lembrete.botoes, io: io || undefined })
    : await sendOutboundWhatsAppTemplate({ accountId, leadId: l.id, templateName: lembrete.template, language: 'pt_BR', bodyParams: [nome], previewText: preview, io: io || undefined });
  if (!r.success) {
    console.error(`[Loop do Follow Up] ${l.name}: Follow Up ${passo.tipo + 1} não saiu — ${(r as any).error}`);
    return false;
  }
  const he = /home equity/i.test(l.pipeline?.department?.name || '');
  const { emailLembreteDocs } = require('./email.service') as typeof import('./email.service');
  const html = emailLembreteDocs({ nome, ...lembrete.email, cta: { texto: '📝 Concluir minha proposta', url: he ? LINK_PROPOSTA.he : LINK_PROPOSTA.fh, rodape: 'ou chame a gente no WhatsApp que ajudamos a preencher' } });
  const mail = await sendOutboundEmail({ accountId, leadId: l.id, subject: lembrete.email.assunto, body: [lembrete.email.titulo, ...lembrete.email.paragrafos, lembrete.email.destaque].join('\n\n'), html, io: io || undefined }).catch(() => null);
  const movido = passo.tipo === 0 && /^prospec/.test(norm(l.stage?.name || '')) ? await moverPara(accountId, l.id, l.pipelineId, /^follow up/, '1 dia sem resposta (Follow Up 1 enviado)', io) : null;
  await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `🔁 Follow Up ${passo.tipo + 1} de 3${mail?.success ? ' + e-mail' : ''}${movido ? ` — card pra "${movido}"` : ''} (3 Follow Ups de 3 em 3 dias → "Ainda deseja prosseguir?" 3 dias seguidos → Lead Sem Retorno).` } }).catch(() => {});
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_replied', leadId: l.id, leadName: l.name, summary: `Follow Up ${passo.tipo + 1} de 3` });
  return true;
}

/** Hook do WhatsApp: em Prospecção/Follow Up o cliente disse QUANDO preenche ("amanhã", "sexta", "dia 5"…) → o loop espera até essa data. */
export async function maybeSetFollowPrazo(accountId: string, leadId: string, text: string): Promise<void> {
  const t = (text || '').trim();
  const { TIME_RX, promisedAt } = require('./docs-checker.service') as typeof import('./docs-checker.service');
  if (!t || t.length > 220 || !TIME_RX.test(t) || /n[ãa]o (tenho|quero) (mais )?interesse|desist/i.test(t)) return;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId, status: 'OPEN' }, select: { customFields: true, stage: { select: { name: true } } } });
  if (!lead || !ehEtapaFollow(lead.stage?.name || '')) return;
  const prazo = promisedAt(t, new Date());
  const cf = (lead.customFields || {}) as Record<string, any>;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...cf, _followPrazo: prazo.toISOString() } as any } });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⏰ Cliente disse quando vai preencher a proposta ("${t.slice(0, 120)}") — o Follow Up espera até ${prazo.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })}.` } }).catch(() => {});
}
