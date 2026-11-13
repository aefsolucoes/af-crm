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

export type DocLoopState = {
  passo: number; ultimoAt?: string; ciclo?: number;
  /** Lembrete que a Meta NÃO entregou (Fabio 12/11): `conferidoDe` = o `ultimoAt` do envio cuja entrega já foi conferida (falhou ou chegou), `falhas` = seguidas, `semEntrega` = parou de tentar. */
  conferidoDe?: string; falhas?: number; falha?: string; semEntrega?: boolean;
  /** Cliente esperando resposta NOSSA (Fabio 12/11): o lembrete fica segurado e a equipe é avisada. */
  espera?: { msgId: string; seguraDesde: string; avisos: number; ultimoAvisoAt: string; liberadoAt?: string };
};
const ESPERA_AVISOS = 3; // push no dia, 2 e 4 dias depois
const ESPERA_ENTRE_AVISOS = 2; // dias
const ESPERA_MAX = 7; // dias segurando o lembrete; depois disso (3 avisos sem ninguém responder) o loop volta
const FALHAS_PRA_PARAR = 2;

export const diaBrt = (d: Date) => Math.floor((d.getTime() + BRT) / 86_400_000);
export const diasDesde = (d: Date) => diaBrt(new Date()) - diaBrt(d);
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
export async function ultimaConversa(leadId: string): Promise<Date | null> {
  const m = await prisma.message.findFirst({
    where: { leadId, channel: { not: 'EMAIL' }, OR: [{ direction: 'INBOUND' }, { direction: 'OUTBOUND', sentByUserId: { not: null } }] },
    orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  });
  return m?.createdAt || null;
}

const semAc = (t: unknown) => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const PEDE_RESPOSTA_RX = /\b(duvida|ajuda|nao entendi|nao sei (como|qual|quais|onde|o que)|nao (consigo|estou conseguindo|to conseguindo)|como (faco|consigo|funciona|envio|mando|eu)|qua(l|is) (sao |e |seria[m]? )?(o |a |os |as |esses |essas )?(documentos?|docs?)|(documentos?|docs?|o que) (que )?(ainda )?(falta|faltam)|o que (falta|precisa|preciso)|me liga|pode[m]? me ligar|quero falar|falar com (alguem|voce|voces|vcs|um atendente|atendente)|aguardo (o )?(retorno|resposta)|fico no aguardo|no aguardo|alguem ai|preciso de prazo)\b/;

/** A mensagem do cliente pede uma resposta nossa? Pergunta ("?"), dúvida, pedido de ajuda/ligação/prazo. "Vou enviar", "ok", "já enviei" não pedem. Pura. */
export function pedeResposta(conteudo: unknown): boolean {
  const t = semAc(conteudo).replace(/\s+/g, ' ').trim();
  if (!t) return false;
  return /\?/.test(t) || PEDE_RESPOSTA_RX.test(t);
}

/** Mensagem automática do próprio loop (lembrete com a janela aberta sai como texto comum; pergunta antes da janela fechar): não é resposta ao cliente. Pura. */
export function ehTextoDoLoop(conteudo: unknown): boolean {
  const t = semAc(conteudo).replace(/\s+/g, ' ').trim();
  // A pergunta de 13/11 só pelo texto inteiro do CRM: a IA também pergunta "até quando você consegue me mandar…" respondendo o cliente, e isso é resposta de verdade.
  return /sua pre-analise de credito foi aprovada e o processo esta aguardando a sua documentacao|seu processo de credito segue aguardando os documentos|para dar andamento ao seu credito aprovado precisamos receber a sua documentacao|quando voce consegue me encaminhar (o restante da documentacao|a documentacao que te pedi)|recebi parte da documentacao, obrigad[ao]!.{0,8}ate quando voce consegue me mandar o restante/.test(t);
}

/** A pergunta da janela (abaixo, processJanelaDocs): "Até quando você consegue me mandar o restante?" (13/11) ou "Quando você consegue me encaminhar…" (08/11). Pura. */
export function ehPerguntaDoPrazo(conteudo: unknown): boolean {
  const t = semAc(conteudo).replace(/\s+/g, ' ').trim();
  return /ate quando voce consegue me mandar o restante|quando voce consegue me encaminhar (o restante da documentacao|a documentacao que te pedi)/.test(t);
}

/** Última mensagem do cliente no WhatsApp que pede resposta e ainda não teve nenhuma no WhatsApp (da equipe ou da IA). Não contam como resposta: template, e-mail
 *  (o lembrete manda um e-mail automático junto — Silas/Diego, 12/11) e os textos automáticos do loop. null = ninguém esperando. */
export async function clienteEsperandoResposta(leadId: string): Promise<{ id: string; content: string; createdAt: Date } | null> {
  const ult = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', channel: 'WHATSAPP', deleted: false }, orderBy: { createdAt: 'desc' }, select: { id: true, content: true, createdAt: true } });
  if (!ult || !pedeResposta(ult.content)) return null;
  const depois = await prisma.message.findMany({ where: { leadId, direction: 'OUTBOUND', channel: 'WHATSAPP', templateName: null, status: { not: 'FAILED' }, deleted: false, createdAt: { gt: ult.createdAt } }, select: { content: true, sentByUserId: true }, take: 20 });
  const respondeu = depois.some((m) => m.sentByUserId || !ehTextoDoLoop(m.content));
  return respondeu ? null : { id: ult.id, content: String(ult.content || ''), createdAt: ult.createdAt };
}

/** Entrega do lembrete automático mandado em `ultimo` (o "aceito" da API pode virar FAILED depois, pelo webhook): 'FALHOU' com o motivo, 'CHEGOU' (entregue/lido) ou 'ESPERA' (ainda só enviado). */
const TEMPLATES_DO_LOOP = new Set<string>([...LEMBRETES.map((l) => l.template), 'ainda_deseja_prosseguir']);
async function entregaDoLembrete(leadId: string, ultimo: Date): Promise<{ r: 'FALHOU'; motivo: string } | { r: 'CHEGOU' | 'ESPERA' }> {
  // Só a mensagem do PRÓPRIO lembrete (template do loop ou o texto dele com a janela aberta), enviada antes de `ultimoAt` (que é gravado depois do WhatsApp e do e-mail):
  // a resposta da IA a um botão tocado logo depois não conta.
  const cands = await prisma.message.findMany({
    where: { leadId, direction: 'OUTBOUND', channel: 'WHATSAPP', sentByUserId: null, createdAt: { gte: new Date(ultimo.getTime() - 5 * 60_000), lte: new Date(ultimo.getTime() + 5_000) } },
    orderBy: { createdAt: 'desc' }, select: { status: true, statusError: true, templateName: true, content: true }, take: 10,
  });
  const m = cands.find((x) => (x.templateName && TEMPLATES_DO_LOOP.has(x.templateName)) || ehTextoDoLoop(x.content));
  if (m?.status === 'FAILED') return { r: 'FALHOU', motivo: String(m.statusError || 'o WhatsApp não entregou') };
  return { r: m && (m.status === 'DELIVERED' || m.status === 'READ') ? 'CHEGOU' : 'ESPERA' };
}

/** Só as chaves (jsonb_set): regravar o card inteiro apaga o que outro processo gravou no meio (corrida no customFields, 29/10). */
const salvaLoop = (leadId: string, st: DocLoopState) => prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docLoop}', ${JSON.stringify(st)}::jsonb, true) WHERE id = ${leadId}`;
const avisa = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* sem push */ } };
const ddmm = (d: Date) => new Date(d.getTime() + BRT).toISOString().slice(5, 10).split('-').reverse().join('/');

/** Estado depois de um lembrete que NÃO chegou: o passo volta (não conta como enviado) e, na 2ª falha seguida, o loop para de tentar. Pura. */
export function estadoAposFalha(st: DocLoopState, motivo: string): DocLoopState {
  const falhas = (st.falhas || 0) + 1;
  return { ...st, passo: Math.max(0, st.passo - 1), conferidoDe: st.ultimoAt, falhas, falha: motivo.slice(0, 160), ...(falhas >= FALHAS_PRA_PARAR ? { semEntrega: true } : {}) };
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
    try {
    const cf = (l.customFields || {}) as Record<string, any>;
    if (cf._autoPaused) continue;
    if (cf._saldoDevedor?.bloqueio) continue; // saldo devedor acima do limite: com este imóvel não dá pra seguir (Fabio 05/11)
    if (cf._imovelSemGarantia) continue; // imóvel de cessão de direitos: não serve de garantia, não cobra documento (Fabio 12/11)
    const st: DocLoopState = cf._docLoop && typeof cf._docLoop.passo === 'number' ? cf._docLoop : { passo: 0 };
    const conversa = await ultimaConversa(l.id);
    const ultimo = st.ultimoAt ? new Date(st.ultimoAt) : null;
    // LEMBRETE QUE A META BLOQUEOU (Fabio 12/11: "lembrete que a Meta bloqueou conta como enviado"): a API aceita, o FAILED chega depois pelo webhook e o loop seguia como se o
    // cliente tivesse recebido (3 falhas seguidas num cliente). Confere o envio nas 20 h seguintes: falhou → o passo volta, o card ganha a anotação e, na 2ª seguida, o loop para
    // de tentar e a equipe é avisada pra ligar. Conversa nova depois (cliente ou equipe) recomeça o loop.
    if (ultimo && st.conferidoDe !== st.ultimoAt && Date.now() - ultimo.getTime() < 20 * 3_600_000) { // 20 h: o lembrete das 20h55 que falha às 21h05 é visto às 07h
      const entrega = await entregaDoLembrete(l.id, ultimo);
      if (entrega.r === 'CHEGOU') {
        // Chegou: as falhas seguidas zeram e este envio não é mais conferido.
        const { falhas: _f, falha: _m, ...resto } = st;
        await salvaLoop(l.id, { ...resto, conferidoDe: st.ultimoAt });
      }
      if (entrega.r === 'FALHOU') {
        const motivo = entrega.motivo;
        const novo = estadoAposFalha(st, motivo);
        await salvaLoop(l.id, novo);
        const qual = PASSOS[novo.passo % PASSOS.length];
        await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: novo.semEntrega
          ? `📵 ${novo.falhas}º lembrete seguido que o WhatsApp NÃO entregou a este cliente (${motivo}). Parei os lembretes automáticos deste card: ligue pro cliente ou fale por e-mail. Os lembretes voltam sozinhos quando houver conversa nova.`
          : `⚠️ O lembrete de documentação de ${ddmm(ultimo)} NÃO foi entregue pelo WhatsApp (${motivo}). Não contou como enviado: o CRM tenta o mesmo lembrete de novo em ${qual.tipo === 'PROSSEGUIR' ? qual.dias : 3} dia(s).` } }).catch(() => {});
        if (novo.semEntrega) avisa(accountId, `📵 ${l.name}: lembretes não chegam`, 'O WhatsApp não entrega os lembretes de documentação — ligar pro cliente', l.id);
        console.log(`[Loop de documentos] ${l.name}: lembrete de ${st.ultimoAt} falhou na Meta (${motivo}) — falha ${novo.falhas}${novo.semEntrega ? ', loop parado' : ''}`);
        continue;
      }
    }
    if (st.semEntrega && !(conversa && ultimo && conversa > ultimo)) continue; // o WhatsApp não entrega a este cliente: espera conversa nova
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
    if (await isWaitingApprovalReply(l.id, { comFalha: true })) continue; // ainda não respondeu o aviso de aprovação (o que a Meta bloqueou também conta: o reenvio dia sim, dia não cuida — Fabio 13/11)
    // CLIENTE ESPERANDO RESPOSTA NOSSA (Fabio 12/11: "o loop cobra documento de quem espera resposta nossa" — perguntou "quais documentos ainda faltam?" e recebeu 6 lembretes):
    // a última mensagem dele pede resposta e ninguém respondeu → o lembrete NÃO sai; a equipe é avisada (no dia, 2 e 4 dias depois). Qualquer resposta na conversa libera.
    // 7 dias segurado sem ninguém responder → o loop volta (a equipe foi avisada 3 vezes).
    const pend = await clienteEsperandoResposta(l.id);
    if (pend) {
      const e = st.espera && st.espera.msgId === pend.id ? st.espera : null;
      const agora = new Date();
      if (!e) {
        await salvaLoop(l.id, { ...st, espera: { msgId: pend.id, seguraDesde: agora.toISOString(), avisos: 1, ultimoAvisoAt: agora.toISOString() } });
        const trecho = pend.content.replace(/\s+/g, ' ').trim().slice(0, 140);
        await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `🙋 O cliente está esperando resposta nossa desde ${ddmm(pend.createdAt)}: "${trecho}". Segurei o lembrete de documentação — responda pela conversa (qualquer resposta libera os lembretes).` } }).catch(() => {});
        avisa(accountId, `🙋 ${l.name}: esperando resposta`, trecho, l.id);
        continue;
      }
      if (!e.liberadoAt && diasDesde(new Date(e.seguraDesde)) < ESPERA_MAX) {
        if (e.avisos < ESPERA_AVISOS && diasDesde(new Date(e.ultimoAvisoAt)) >= ESPERA_ENTRE_AVISOS) {
          await salvaLoop(l.id, { ...st, espera: { ...e, avisos: e.avisos + 1, ultimoAvisoAt: agora.toISOString() } });
          avisa(accountId, `🙋 ${l.name}: ainda sem resposta`, `Esperando resposta nossa desde ${ddmm(pend.createdAt)} — o lembrete de documentação está segurado`, l.id);
        }
        continue;
      }
      if (!e.liberadoAt) {
        st.espera = { ...e, liberadoAt: agora.toISOString() };
        await salvaLoop(l.id, { ...st }); // grava já: se o envio abaixo falhar, a anotação não se repete no minuto seguinte
        await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `🙋 Ninguém respondeu o cliente em ${ESPERA_MAX} dias (avisei ${e.avisos} vez(es)): os lembretes de documentação voltaram a sair.` } }).catch(() => {});
      }
    }
    const ok = await enviarPasso(accountId, l.id, l.name, cf, PASSOS[passo], io);
    if (!ok) continue;
    enviados++;
    // Falhas SEGUIDAS: só carrega a contagem quando o envio anterior foi conferido como FALHA e não houve conversa nova depois (conversa recomeça do zero).
    const reenvio = !!(st.falhas && st.falha && st.conferidoDe === st.ultimoAt && !(conversa && ultimo && conversa > ultimo));
    const novoSt: DocLoopState = { passo: passo + 1, ultimoAt: new Date().toISOString(), ciclo: (st.ciclo || 0) + (passo === 0 && !reenvio ? 1 : 0), ...(reenvio ? { falhas: st.falhas } : {}), ...(st.espera?.liberadoAt ? { espera: st.espera } : {}) };
    await salvaLoop(l.id, novoSt);
    if (cf._docsPrazo && Date.now() >= Date.parse(cf._docsPrazo)) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = "customFields" - '_docsPrazo' WHERE id = ${l.id}`;
    } catch (e: any) { console.error(`[Loop de documentos] ${l.name} (${l.id}):`, e?.message || e); } // um card com erro não para os outros
  }
}

async function enviarPasso(accountId: string, leadId: string, leadName: string, cf: Record<string, any>, passo: Passo, io: Io): Promise<boolean> {
  if (passo.tipo === 'PROSSEGUIR') {
    const { sendProsseguir } = require('./prosseguir.service') as typeof import('./prosseguir.service');
    return sendProsseguir(accountId, leadId, 'loop de lembretes de documentação', io);
  }
  const lembrete = LEMBRETES[passo.tipo];
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, leadName) || 'tudo bem';
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

/* Antes da janela de 24 h fechar (Fabio 08/11, Evandro: "antes da janela fechar, encaminhar uma msg perguntando quando ele consegue encaminhar a documentação solicitada").
 * Card em Aguardando Documentação com a janela ainda aberta (contada da última mensagem do cliente): ~2 h antes de fechar, no horário de atendimento, o CRM pergunta.
 * Fabio 13/11: "se o cliente começar a encaminhar a documentação, a gente analisar, e até o final das 24 h ele não tiver encaminhado o restante, o CRM deve encaminhar uma
 * mensagem sutil perguntando até quando poderá encaminhar o restante." → documento já LIDO pela conferência e card ainda esperando o resto: "Fulano, recebi parte da
 * documentação, obrigada! 😊 Até quando você consegue me mandar o restante?" — sem lista (a conferência já listou). Conferência agendada/rodando: espera ela. Dúvida de
 * documento com a equipe (a conferência não cobra nada enquanto isso), documentação do comprador fechada ou contratação segurada pelo habite-se: não pergunta. IA desligada ou
 * cliente esperando resposta nossa: não pergunta — nota + push pra equipe. STOP TOTAL: nada. A resposta ("até sexta", "amanhã") vira `_docsPrazo`
 * (docs-checker.maybeScheduleDocsFollowUp) e o loop de lembretes espera a data. Uma vez por janela: `_janelaDocs` guarda a última mensagem do cliente que já teve a pergunta. */
const JANELA_MS = 24 * 3_600_000;
const ULTIMO_HORARIO = 20 * 60 + 30; // 20h30 de Brasília: meia hora de folga pro poller (07h–21h) pegar a pergunta

/** Quando perguntar, pela última mensagem do cliente: 2 h antes de a janela fechar; caindo depois das 20h30 de Brasília, às 20h30 do mesmo dia; antes das 07h, às 20h30 da véspera. Pura. */
export function quandoPerguntarDocs(ultimaDoCliente: Date): Date {
  const alvo = ultimaDoCliente.getTime() + JANELA_MS - 2 * 3_600_000;
  const l = new Date(alvo + BRT);
  const min = l.getUTCHours() * 60 + l.getUTCMinutes();
  if (min >= 7 * 60 && min <= ULTIMO_HORARIO) return new Date(alvo);
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() - (min < 7 * 60 ? 1 : 0), 20, 30) - BRT);
}

/** A pergunta pode sair agora? Entre 07h e 21h, a partir de `quandoPerguntarDocs` e até 15 min antes de a janela fechar. Pura. */
export function podePerguntarDocs(ultimaDoCliente: Date, agora: number): boolean {
  const h = new Date(agora + BRT).getUTCHours();
  if (h < 7 || h >= 21) return false;
  return agora >= quandoPerguntarDocs(ultimaDoCliente).getTime() && agora <= ultimaDoCliente.getTime() + JANELA_MS - 15 * 60_000;
}

/** Documentação do cliente pra pergunta da janela (Fabio 13/11). Pura.
 *  NADA = nenhum documento lido (pergunta de 08/11, só com a IA ligada); CONFERINDO = conferência agendada ou rodando (espera ela); PARCIAL = a conferência já leu
 *  documento e o card segue esperando o resto (pergunta de 13/11); EQUIPE = dúvida de documento aberta no balão; COMPLETO = documentação do comprador fechada ou
 *  contratação segurada pelo habite-se. `lidos` = arquivos do cliente que a leitura classificou como documento (`_docInfo` ≠ IGNORAR). */
export type SituacaoDocs = 'NADA' | 'CONFERINDO' | 'PARCIAL' | 'EQUIPE' | 'COMPLETO';
export function situacaoDocs(p: { cf: Record<string, any>; lidos: number; compradorCompleto: boolean; duvidaComEquipe: boolean }): SituacaoDocs {
  const { cf } = p;
  if (cf._docsCheckDue || cf._docsConferindo || cf._docsConferindoBotao) return 'CONFERINDO';
  if (p.compradorCompleto || cf._habiteSeSegurado) return 'COMPLETO';
  if (!p.lidos) return 'NADA';
  return p.duvidaComEquipe ? 'EQUIPE' : 'PARCIAL';
}

/** Texto da pergunta. Pura. PARCIAL (13/11): sutil, sem lista. NADA (08/11): o texto de antes. */
export function textoJanelaDocs(sit: 'PARCIAL' | 'NADA', nome: string | null, o: { mandouArquivo?: boolean; conversaAtiva?: boolean } = {}): string {
  if (sit === 'PARCIAL') return `${nome ? `${nome}, r` : 'R'}ecebi parte da documentação, obrigada! 😊 Até quando você consegue me mandar o restante?`;
  const oi = o.conversaAtiva ? '' : `Oi${nome ? `, ${nome}` : ''}! `;
  return `${oi}Quando você consegue me encaminhar ${o.mandouArquivo ? 'o restante da documentação' : 'a documentação que te pedi'}? Assim a gente já dá andamento no seu crédito. 😊`;
}

/** Poller (1 min, 07h–21h). */
export async function processJanelaDocs(accountId: string, io?: Io): Promise<void> {
  if (!emHorario()) return;
  const agora = Date.now();
  const leads = await prisma.lead.findMany({
    where: {
      accountId, status: 'OPEN', archived: false, isGroup: false,
      stage: { name: { contains: 'aguardando document', mode: 'insensitive' } },
      NOT: { tags: { has: 'Pediu pra parar lembretes' } },
      // a pergunta cai nas últimas ~13 h da janela: só quem escreveu entre 11 h e 24 h atrás
      messages: { some: { direction: 'INBOUND', channel: 'WHATSAPP', createdAt: { gt: new Date(agora - JANELA_MS), lt: new Date(agora - 11 * 3_600_000) } } },
    },
    select: { id: true, name: true, aiAutoReplyActive: true, stageEnteredAt: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { department: { select: { name: true } } } } },
  });
  const { isWaitingApprovalReply, conversationActive } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const { isStickerAttachment, isScreenshotAttachment } = require('./google.service') as typeof import('./google.service');
  const { soDocsDoComprador, naRotaCaixa } = require('./docs-checker.service') as typeof import('./docs-checker.service');
  for (const l of leads) {
    try {
    const cf = (l.customFields || {}) as Record<string, any>;
    if (cf._autoPaused || cf._saldoDevedor?.bloqueio || cf._docsLater || cf._imovelSemGarantia) continue; // STOP TOTAL: nada · _docsLater: já tem a cobrança combinada com ele
    if (cf._docsPrazo && agora < Date.parse(cf._docsPrazo)) continue; // ele já disse quando manda
    const ultimaIn = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'INBOUND', channel: 'WHATSAPP' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (!ultimaIn) continue;
    // A vez é NOSSA (Fabio 12/11: o CRM cobrou documento de quem esperava a nova proposta de R$ 60 mil): nova proposta pedida pelo cliente ainda rodando, ou o
    // banco não abriu outra e o cliente ainda não respondeu se segue nas condições atuais — não cobra documento.
    if (cf._changeRound) continue;
    if (cf._changeNaoAbriu?.em && ultimaIn.createdAt.getTime() < Date.parse(String(cf._changeNaoAbriu.em))) continue;
    if (!podePerguntarDocs(ultimaIn.createdAt, agora)) continue;
    const marca = ultimaIn.createdAt.toISOString();
    if (cf._janelaDocs === marca) continue;
    // Mensagem nossa na última hora: a conversa está andando — espera.
    if (await prisma.message.findFirst({ where: { leadId: l.id, direction: 'OUTBOUND', channel: 'WHATSAPP', createdAt: { gt: new Date(agora - 60 * 60_000) } }, select: { id: true } })) continue;
    if (await isWaitingApprovalReply(l.id, { comFalha: true })) continue;
    // O que já chegou (Fabio 13/11): só arquivo que pode ser documento (sem figurinha, áudio, vídeo e captura de tela) e que a leitura classificou.
    const anexos = (await prisma.messageAttachment.findMany({ where: { leadId: l.id, message: { direction: 'INBOUND' } }, select: { id: true, fileName: true, mimeType: true, createdAt: true } }))
      .filter((a) => !/^(audio|video)\//.test(a.mimeType) && !isStickerAttachment(a) && !isScreenshotAttachment(a));
    const info = (cf._docInfo || {}) as Record<string, unknown>;
    const lidos = anexos.filter((a) => info[a.id] && info[a.id] !== 'IGNORAR').length;
    const compradorCompleto = soDocsDoComprador(cf, l.pipeline?.department?.name, l.stage.name) && !!(naRotaCaixa(cf, l.stage.name) ? cf._caixaDocsAt : cf._fhDocsCompradorAt);
    const duvidaComEquipe = lidos > 0 && (await prisma.aiTeamQuestion.count({ where: { leadId: l.id, kind: 'DOC_QUESTION', status: 'OPEN' } })) > 0;
    const sit = situacaoDocs({ cf, lidos, compradorCompleto, duvidaComEquipe });
    if (sit === 'CONFERINDO' || sit === 'EQUIPE' || sit === 'COMPLETO') continue; // CONFERINDO: tenta de novo no minuto seguinte
    if (sit === 'NADA' && !l.aiAutoReplyActive) continue; // pergunta de 08/11: só com a IA ligada
    // Cliente esperando resposta nossa (pergunta, dúvida, pedido de ajuda): cobrar o restante por cima da pergunta dele não — a equipe é avisada (abaixo).
    const esperando = await clienteEsperandoResposta(l.id);
    if (sit === 'NADA' && esperando) continue;
    // Pega a vez (uma por janela, mesmo com dois servidores no ar durante um deploy).
    const pegou = await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_janelaDocs}', to_jsonb(${marca}::text), true) WHERE id = ${l.id} AND COALESCE("customFields"->>'_janelaDocs', '') <> ${marca}`;
    if (!pegou) continue;
    const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
    const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, l.name);
    const fecha = ultimaIn.createdAt.getTime() + JANELA_MS;
    const hora = new Date(fecha).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    if (sit === 'PARCIAL' && (!l.aiAutoReplyActive || esperando)) {
      // A equipe é quem fala com o cliente agora: o CRM não manda — anota e avisa, com o texto pronto.
      const trecho = esperando ? esperando.content.replace(/\s+/g, ' ').trim().slice(0, 140) : '';
      const porque = !l.aiAutoReplyActive ? 'a IA está desligada neste card' : `ele está esperando resposta nossa ("${trecho}")`;
      await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `⏳ A janela de 24 h do WhatsApp fecha ${hora}. O cliente mandou parte da documentação e ainda não mandou o restante, mas ${porque} — NÃO perguntei. Sugestão: "${textoJanelaDocs('PARCIAL', nome)}"` } }).catch(() => {});
      avisa(accountId, `⏳ ${l.name}: janela fecha ${hora}`, !l.aiAutoReplyActive ? 'Mandou parte da documentação — perguntar até quando manda o restante (IA desligada)' : `Esperando resposta nossa: "${trecho}"`, l.id);
      continue;
    }
    const mandouArquivo = anexos.some((a) => a.createdAt > (l.stageEnteredAt || new Date(0)));
    const texto = sit === 'PARCIAL' ? textoJanelaDocs('PARCIAL', nome) : textoJanelaDocs('NADA', nome, { mandouArquivo, conversaAtiva: await conversationActive(l.id, 2) });
    const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
    const r = await sendOutboundWhatsApp({ accountId, leadId: l.id, content: texto, io: io || undefined });
    const oQue = sit === 'PARCIAL' ? 'até quando ele consegue mandar o restante da documentação (já mandou parte)' : 'quando ele consegue mandar a documentação';
    await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: r.success ? `⏳ A janela de 24 h do WhatsApp fecha ${hora}: perguntei ao cliente ${oQue}.` : `⏳ A janela de 24 h do WhatsApp fecha ${hora} e a pergunta da documentação não saiu (${(r as any).error || 'erro'}).` } }).catch(() => {});
    if (r.success) logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_replied', leadId: l.id, leadName: l.name, summary: `perguntou ${oQue} (janela de 24 h fechando)` });
    else console.error(`[Janela da documentação] ${l.name}: não saiu — ${(r as any).error}`);
    } catch (e: any) { console.error(`[Janela da documentação] ${l.name} (${l.id}):`, e?.message || e); } // um card com erro não para os outros
  }
}
