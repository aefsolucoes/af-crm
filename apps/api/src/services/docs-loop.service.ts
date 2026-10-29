import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

/* Loop de lembretes de "Aguardando Documentação" — Home Equity e Financiamento Habitacional (Fabio 28/10):
 *  "3 templates diferentes, 1 a cada 3 dias; depois o 'Ainda deseja seguir com o crédito?' seguidos por dia durante 3 dias; caso o cliente não responda,
 *   aguardar mais 3 dias e encaminhar novamente os 3 templates… assim a gente faz um loop."
 *  - Dia 3 na etapa: Template 1 · dia 6: Template 2 · dia 9: Template 3 · dias 12, 13 e 14: "Ainda deseja prosseguir?" · espera 3 dias · Template 1 de novo…
 *  - Conversa de verdade no meio (mensagem do cliente no WhatsApp ou da equipe escrita à mão): o loop recomeça do Template 1 depois de 2 dias parado.
 *  - Cliente disse até quando manda (`_docsPrazo`, ver docs-checker.maybeScheduleDocsFollowUp): espera essa data.
 *  - "Não tenho interesse" → Perdido (no-interest.service); "Sim, tenho interesse" é conversa (recomeça); pediu pra parar → sai do loop (prosseguir.processPediuParar).
 *  - Só entra no ar quando a Meta aprovar os 3 templates de Utilidade; a partir daí as automações antigas de lembrete (regras INACTIVITY de Aguardando
 *    Documentação) e a campanha do "Ainda deseja prosseguir?" param sozinhas (docLoopAtivo).
 *  Cada Template vai com um e-mail com visual próprio. Com a janela de 24 h aberta, o texto sai como mensagem comum com os mesmos botões (não paga template). */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
type Lembrete = { template: string; texto: (nome: string) => string; botoes: string[]; email: { assunto: string; titulo: string; paragrafos: string[]; destaque: string } };

export const LEMBRETES: Lembrete[] = [
  {
    template: 'docs_lembrete_1',
    texto: (n) => `Olá, ${n}! Sua pré-análise de crédito foi aprovada e o processo está aguardando a sua documentação. Assim que você enviar os documentos por aqui, seguimos com o banco.`,
    botoes: ['Vou enviar', 'Já enviei', 'Tenho uma dúvida'],
    email: {
      assunto: '✅ Seu crédito foi pré-aprovado — falta só a documentação',
      titulo: 'Sua pré-análise foi aprovada! 🎉',
      paragrafos: ['O próximo passo é com você: enviar a documentação pra gente seguir com o banco.', 'A lista com os documentos do seu caso está no nosso WhatsApp. Pode mandar por lá ou respondendo este e-mail com os arquivos.'],
      destaque: 'Fotos nítidas ou PDF, com todas as informações legíveis e atualizadas.',
    },
  },
  {
    template: 'docs_lembrete_2',
    texto: (n) => `Oi, ${n}! Seu processo de crédito segue aguardando os documentos para continuar. Se estiver com dificuldade para conseguir algum deles, me avise que eu te ajudo.`,
    botoes: ['Vou enviar', 'Preciso de ajuda'],
    email: {
      assunto: '⏳ Seu processo de crédito está esperando os seus documentos',
      titulo: 'Seu crédito está parado esperando os documentos',
      paragrafos: ['Ainda não recebemos a documentação pra seguir com a sua aprovação no banco.', 'Se algum documento estiver difícil de conseguir, fala com a gente — a gente te ajuda a resolver (algumas certidões a própria A&F consegue emitir).'],
      destaque: 'Quanto antes a documentação chegar, mais rápido o banco dá andamento.',
    },
  },
  {
    template: 'docs_lembrete_3',
    texto: (n) => `Oi, ${n}! Para dar andamento ao seu crédito aprovado precisamos receber a sua documentação. Consegue enviar por aqui?`,
    botoes: ['Vou enviar hoje', 'Preciso de prazo'],
    email: {
      assunto: '📄 Último passo para seguir com o seu crédito',
      titulo: 'Falta só um passo pra seguir com o seu crédito',
      paragrafos: ['Sua aprovação está esperando a documentação pra ir pro banco.', 'Se precisar de mais prazo, é só responder dizendo até quando consegue enviar.'],
      destaque: 'Envie pelo WhatsApp ou responda este e-mail com os arquivos.',
    },
  },
];

type Passo = { tipo: 0 | 1 | 2 | 'PROSSEGUIR'; dias: number };
/** `dias` = dias de calendário depois do envio anterior (o 1º conta da entrada na etapa). */
const PASSOS: Passo[] = [
  { tipo: 0, dias: 3 },
  { tipo: 1, dias: 3 },
  { tipo: 2, dias: 3 },
  { tipo: 'PROSSEGUIR', dias: 3 },
  { tipo: 'PROSSEGUIR', dias: 1 },
  { tipo: 'PROSSEGUIR', dias: 1 },
];
const ESPERA_RECOMECO = 3; // depois do 3º "Ainda deseja prosseguir?" sem resposta
const PARADO = 2; // conversa no meio do loop → recomeça do Template 1 depois de 2 dias parado
const POR_RODADA = 15;
const BRT = -3 * 3_600_000;

export type DocLoopState = { passo: number; ultimoAt?: string; ciclo?: number };

const diaBrt = (d: Date) => Math.floor((d.getTime() + BRT) / 86_400_000);
const diasDesde = (d: Date) => diaBrt(new Date()) - diaBrt(d);
const emHorario = () => { const h = new Date(Date.now() + BRT).getUTCHours(); return h >= 7 && h < 21; };

/** Os 3 templates aprovados na Meta → o loop assume (cache de 15 min; depois de aprovado não consulta mais). */
let ativo = false;
let ultimaConsulta = 0;
export async function docLoopAtivo(accountId: string): Promise<boolean> {
  if (ativo) return true;
  if (Date.now() - ultimaConsulta < 15 * 60_000) return false;
  ultimaConsulta = Date.now();
  try {
    const { listMetaTemplates } = require('./whatsapp.service') as typeof import('./whatsapp.service');
    const lista = await listMetaTemplates(accountId);
    ativo = LEMBRETES.every((l) => String(lista.find((t: any) => t?.name === l.template)?.status || '').toUpperCase() === 'APPROVED');
    if (ativo) console.log('[Loop de documentos] templates aprovados — o loop assumiu os lembretes de Aguardando Documentação');
  } catch (e: any) { console.error('[Loop de documentos] status dos templates:', e?.message || e); }
  return ativo;
}

/** Última conversa de verdade: cliente no WhatsApp ou equipe escrevendo à mão (template, IA respondendo sozinha e e-mail do banco não contam). */
async function ultimaConversa(leadId: string): Promise<Date | null> {
  const m = await prisma.message.findFirst({
    where: { leadId, channel: { not: 'EMAIL' }, OR: [{ direction: 'INBOUND' }, { direction: 'OUTBOUND', sentByUserId: { not: null } }] },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  });
  return m?.createdAt || null;
}

/** Poller (1 min, 07h–21h). */
export async function processDocLoop(accountId: string, io?: Io): Promise<void> {
  if (!emHorario() || !(await docLoopAtivo(accountId))) return;
  const leads = await prisma.lead.findMany({
    where: {
      accountId, status: 'OPEN', archived: false, isGroup: false,
      stage: { name: { contains: 'aguardando document', mode: 'insensitive' } },
      NOT: { tags: { has: 'Pediu pra parar lembretes' } },
    },
    select: { id: true, name: true, stageEnteredAt: true, customFields: true },
  });
  const { isWaitingApprovalReply } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  let enviados = 0;
  for (const l of leads) {
    if (enviados >= POR_RODADA) break;
    const cf = (l.customFields || {}) as Record<string, any>;
    if (cf._autoPaused) continue;
    const st: DocLoopState = cf._docLoop && typeof cf._docLoop.passo === 'number' ? cf._docLoop : { passo: 0 };
    const conversa = await ultimaConversa(l.id);
    const ultimo = st.ultimoAt ? new Date(st.ultimoAt) : null;
    // Qual passo agora e a partir de quando.
    let passo = st.passo % PASSOS.length;
    let liberaEm: Date | null;
    let diasMin: number;
    if (!ultimo || (conversa && conversa > ultimo)) {
      // Começo do loop (ou conversa depois do último lembrete): Template 1, 3 dias na etapa e 2 dias parado.
      passo = 0;
      const entrou = l.stageEnteredAt || new Date();
      if (diasDesde(entrou) < PASSOS[0].dias) continue;
      // Não empilha com template nosso dos últimos 2 dias (aviso de aprovação, lembrete antigo de antes do loop, "Ainda deseja prosseguir?").
      const tpl = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'OUTBOUND', templateName: { not: null }, status: { not: 'FAILED' } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
      if (tpl && diasDesde(tpl.createdAt) < PARADO) continue;
      liberaEm = conversa;
      diasMin = PARADO;
    } else {
      // Dentro do loop: espera do passo; depois do último "Ainda deseja prosseguir?", 3 dias e volta pro Template 1.
      liberaEm = ultimo;
      diasMin = st.passo >= PASSOS.length || passo === 0 ? ESPERA_RECOMECO : PASSOS[passo].dias;
    }
    if (liberaEm && diasDesde(liberaEm) < diasMin) continue;
    if (cf._docsPrazo && Date.now() < Date.parse(cf._docsPrazo)) continue; // cliente disse até quando manda: espera a data
    if (await isWaitingApprovalReply(l.id)) continue; // ainda não respondeu o aviso de aprovação
    const ok = await enviarPasso(accountId, l.id, l.name, cf, PASSOS[passo], io);
    if (!ok) continue;
    enviados++;
    const fresh = await prisma.lead.findUnique({ where: { id: l.id }, select: { customFields: true } });
    const c = { ...((fresh?.customFields || {}) as Record<string, any>) };
    const proximo = passo + 1;
    c._docLoop = { passo: proximo, ultimoAt: new Date().toISOString(), ciclo: (st.ciclo || 0) + (passo === 0 ? 1 : 0) } satisfies DocLoopState;
    if (c._docsPrazo && Date.now() >= Date.parse(c._docsPrazo)) delete c._docsPrazo;
    await prisma.lead.update({ where: { id: l.id }, data: { customFields: c as any } });
  }
}

async function enviarPasso(accountId: string, leadId: string, leadName: string, cf: Record<string, any>, passo: Passo, io: Io): Promise<boolean> {
  if (passo.tipo === 'PROSSEGUIR') {
    const { sendProsseguir } = require('./prosseguir.service') as typeof import('./prosseguir.service');
    return sendProsseguir(accountId, leadId, 'loop de lembretes de documentação', io);
  }
  const lembrete = LEMBRETES[passo.tipo];
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.participante_1, leadName) || 'tudo bem';
  const texto = lembrete.texto(nome);
  const preview = `${texto}\n\n${lembrete.botoes.map((b) => `[${b}]`).join('  ')}`;
  const { whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const { sendOutboundWhatsApp, sendOutboundWhatsAppTemplate, sendOutboundEmail } = require('./message.service') as typeof import('./message.service');
  // Janela de 24 h aberta: mensagem comum com os mesmos botões (não paga template).
  const r = (await whatsappWindowOpen(leadId))
    ? await sendOutboundWhatsApp({ accountId, leadId, content: texto, buttons: lembrete.botoes, io: io || undefined })
    : await sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: lembrete.template, language: 'pt_BR', bodyParams: [nome], previewText: preview, io: io || undefined });
  if (!r.success) {
    console.error(`[Loop de documentos] ${leadName}: lembrete ${passo.tipo + 1} não saiu — ${(r as any).error}`);
    return false;
  }
  const { emailLembreteDocs } = require('./email.service') as typeof import('./email.service');
  const html = emailLembreteDocs({ nome, ...lembrete.email });
  const mail = await sendOutboundEmail({ accountId, leadId, subject: lembrete.email.assunto, body: [lembrete.email.titulo, ...lembrete.email.paragrafos, lembrete.email.destaque].join('\n\n'), html, io: io || undefined }).catch(() => null);
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔁 Lembrete de documentação ${passo.tipo + 1} de 3 (loop: 3 lembretes, 1 a cada 3 dias → "Ainda deseja prosseguir?" 3 dias seguidos → 3 dias de espera → recomeça)${mail?.success ? ' + e-mail' : ''}.` } }).catch(() => {});
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_replied', leadId, leadName, summary: `lembrete de documentação ${passo.tipo + 1} de 3` });
  return true;
}
