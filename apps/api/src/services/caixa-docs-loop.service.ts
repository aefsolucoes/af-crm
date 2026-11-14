import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';
import { clienteEsperandoResposta, ultimaConversa } from './docs-loop.service';

/* LEMBRETES DA DOCUMENTAÇÃO DA CAIXA (Fabio 14/11, Phillipi — HE e FH): "fiz a solicitação da documentação e o cliente não encaminhou; neste caso, a gente encaminha 3 lembretes
 * de documentação por 3 dias seguidos, e ele vai para Análise CAIXA; caso não tenha retorno do cliente sobre o envio da documentação, ele vai para Follow Up" + "daí ele segue o
 * fluxo do Follow Up".
 *  - Quem: card na etapa "Análise CAIXA" na rota da CAIXA (`_caixaRota`: consulta do nome sem restrição + documentação da CAIXA pedida) e a documentação ainda sem fechar
 *    (`_caixaDocsAt`, gravado pela conferência).
 *  - Quando: 1 lembrete por dia, 3 dias seguidos, contados do pedido (entrada na rota) ou da última conversa de verdade (cliente no WhatsApp ou equipe escrevendo à mão).
 *    Conversa no meio = retorno do cliente → recomeça do 1º no dia seguinte. Cliente disse até quando manda (`_docsPrazo`/`_docsLater`) → espera a data.
 *  - Dia seguinte ao 3º sem retorno → etapa "Follow Up" do mesmo funil; lá segue o loop do Follow Up (follow-loop), com os lembretes de DOCUMENTAÇÃO no lugar dos de
 *    "concluir a proposta" (o cliente já preencheu) — `_caixaDocsLoop.followUpAt`.
 *  - Cliente respondeu no Follow Up / Lead Sem Retorno (mandou documento ou falou) → o card volta pra Análise CAIXA, onde a conferência dos documentos roda.
 *  Com a janela de 24 h aberta, o lembrete sai como texto comum com botões (não paga template); fechada, templates de Utilidade já aprovados. 08h–20h. */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
type Lembrete = { template: string; params: boolean; texto: (nome: string) => string; botoes: string[] };

export const CAIXA_LEMBRETES: Lembrete[] = [
  {
    template: 'lembrete_documentacao_processo', params: false,
    texto: (n) => `Oi, ${n}! Passando pra lembrar da documentação pra gente dar entrada na sua análise na CAIXA. Assim que puder, é só me mandar por aqui, em foto ou PDF.`,
    botoes: ['Já enviei os documentos', 'Vou enviar em breve', 'Tenho uma dúvida'],
  },
  {
    template: 'docs_lembrete_2', params: true,
    texto: (n) => `Oi, ${n}! Sua análise na CAIXA segue aguardando os documentos pra continuar. Se estiver com dificuldade pra conseguir algum deles, me avise que eu te ajudo.`,
    botoes: ['Vou enviar', 'Preciso de ajuda'],
  },
  {
    template: 'follow_up_doc', params: false,
    texto: (n) => `Oi, ${n}! Pra dar entrada na sua análise na CAIXA, preciso receber a sua documentação. Consegue me enviar por aqui?`,
    botoes: ['Já enviei os documentos', 'Vou enviar em breve', 'Tenho uma dúvida'],
  },
];

export type CaixaDocsLoopState = {
  passo: number; ultimoAt?: string;
  /** Foi pro Follow Up depois dos 3 lembretes sem retorno (o loop do Follow Up usa os lembretes de documentação). */
  followUpAt?: string;
  /** Voltou pra Análise CAIXA porque o cliente respondeu no Follow Up. */
  voltouAt?: string;
  /** Mensagem do cliente que espera resposta nossa (o lembrete fica segurado; a equipe é avisada uma vez por mensagem). */
  esperaMsgId?: string;
  semFollowUp?: boolean;
  /** Rota sem o pedido da documentação mandado ao cliente (IA desligada, a equipe ficou de mandar): avisado uma vez. */
  semPedidoAt?: string;
};

const BRT = -3 * 3_600_000;
const POR_RODADA = 15;
const MIN_HORAS = 12; // o 1º lembrete não sai na mesma noite do pedido feito às 20h
const ETAPA_CAIXA = [{ stage: { name: { startsWith: 'Análise CAIXA', mode: 'insensitive' as const } } }, { stage: { name: { startsWith: 'Analise CAIXA', mode: 'insensitive' as const } } }];
const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const emHorario = () => { const h = new Date(Date.now() + BRT).getUTCHours(); return h >= 8 && h < 20; };
const salva = (leadId: string, st: CaixaDocsLoopState) => prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaDocsLoop}', ${JSON.stringify(st)}::jsonb, true) WHERE id = ${leadId}`;
const avisa = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* sem push */ } };

/** A rota da CAIXA ainda espera a documentação do cliente? Pura. */
export function esperaDocsCaixa(cf: Record<string, any>): boolean {
  if (!cf?._caixaRota || cf._caixaDocsAt || cf._autoPaused || cf._caixaTeste) return false;
  const cads = cf._caixaCadastro?.cadastros;
  return !(cads && typeof cads === 'object' && Object.keys(cads).length); // cadastro feito = a documentação chegou (por outro caminho)
}

/** Próximo passo do loop: 'LEMBRETE' (índice), 'FOLLOW_UP' ou null (ainda não). `base` = desde quando conta (pedido, conversa ou último lembrete). Pura. */
export function proximoPasso(st: CaixaDocsLoopState, base: Date, agora = new Date()): { tipo: 'LEMBRETE'; i: number } | { tipo: 'FOLLOW_UP' } | null {
  const dia = (d: Date) => Math.floor((d.getTime() + BRT) / 86_400_000);
  if (dia(agora) - dia(base) < 1 || agora.getTime() - base.getTime() < MIN_HORAS * 3_600_000) return null;
  return st.passo >= CAIXA_LEMBRETES.length ? { tipo: 'FOLLOW_UP' } : { tipo: 'LEMBRETE', i: st.passo };
}

/** Poller (1 min, 08h–20h). */
export async function processCaixaDocsLoop(accountId: string, io?: Io): Promise<void> {
  if (!emHorario()) return;
  await voltarDoFollowUp(accountId, io).catch((e) => console.error('[CAIXA docs] volta do Follow Up:', e?.message));
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, isGroup: false, OR: ETAPA_CAIXA, NOT: { tags: { has: 'Pediu pra parar lembretes' } } },
    select: { id: true, name: true, pipelineId: true, customFields: true },
  });
  let enviados = 0;
  for (const l of leads) {
    if (enviados >= POR_RODADA) break;
    try {
      const cf = (l.customFields || {}) as Record<string, any>;
      if (!esperaDocsCaixa(cf)) continue;
      const rotaAt = new Date(cf._caixaRota.at || 0);
      const prev = (cf._caixaDocsLoop || {}) as CaixaDocsLoopState;
      const conversa = await ultimaConversa(l.id);
      const ultimo = prev.ultimoAt ? new Date(prev.ultimoAt) : null;
      // Lembrete de antes da rota atual (o card saiu e voltou) não conta; conversa depois do último lembrete = retorno do cliente → recomeça do 1º.
      const recomeca = !ultimo || ultimo < rotaAt || (conversa && conversa > ultimo);
      const st: CaixaDocsLoopState = recomeca ? { ...prev, passo: 0, ultimoAt: undefined, followUpAt: undefined } : prev;
      if (st.semFollowUp && !recomeca) continue;
      const base = recomeca ? new Date(Math.max(rotaAt.getTime(), conversa?.getTime() || 0)) : ultimo!;
      const passo = proximoPasso(st, base);
      if (!passo) continue;
      // Só lembra o que foi PEDIDO: alguma mensagem nossa (CRM, IA ou equipe) com a documentação da CAIXA — com a IA desligada a equipe é quem manda o pedido.
      if (!(await pedidoFeito(l.id, new Date(Math.min(rotaAt.getTime(), Date.parse(cf._caixaPedido?.at || '') || rotaAt.getTime()) - 7 * 86_400_000)))) {
        if (!st.semPedidoAt) {
          await salva(l.id, { ...st, semPedidoAt: new Date().toISOString() });
          await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: '⚠️ Card na rota da CAIXA, mas não achei na conversa o pedido da documentação da CAIXA ao cliente. Os lembretes automáticos só saem depois do pedido: mande a lista ao cliente.' } }).catch(() => {});
          avisa(accountId, `🏦 ${l.name}: pedir a documentação da CAIXA`, 'A rota da CAIXA está sem o pedido dos documentos na conversa', l.id);
        }
        continue;
      }
      const prazo = [cf._docsPrazo, cf._docsLater?.at || cf._docsLater].map((v) => (typeof v === 'string' ? Date.parse(v) : NaN)).filter(Number.isFinite);
      if (prazo.some((p) => Date.now() < p)) continue; // o cliente disse até quando manda
      // Não empilha com outro template nosso das últimas 12 h (aviso da CAIXA, certidão, template de atualização…).
      const tpl = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'OUTBOUND', templateName: { not: null }, status: { not: 'FAILED' }, createdAt: { gte: new Date(Date.now() - 12 * 3_600_000) } }, select: { id: true } });
      if (tpl && passo.tipo === 'LEMBRETE') continue;
      // Cliente esperando resposta NOSSA: não cobra documento; a equipe é avisada uma vez por mensagem.
      const pend = await clienteEsperandoResposta(l.id);
      if (pend) {
        if (st.esperaMsgId !== pend.id) {
          await salva(l.id, { ...st, esperaMsgId: pend.id });
          const trecho = pend.content.replace(/\s+/g, ' ').trim().slice(0, 140);
          await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: `🙋 O cliente está esperando resposta nossa: "${trecho}". Segurei o lembrete da documentação da CAIXA — responda pela conversa (qualquer resposta libera).` } }).catch(() => {});
          avisa(accountId, `🙋 ${l.name}: esperando resposta`, trecho, l.id);
        }
        continue;
      }
      if (passo.tipo === 'FOLLOW_UP') {
        const foi = await moverParaFollowUp(accountId, l, io);
        if (foi) await salva(l.id, { ...st, followUpAt: new Date().toISOString() });
        else if (!st.semFollowUp) {
          await salva(l.id, { ...st, semFollowUp: true });
          await prisma.note.create({ data: { leadId: l.id, type: 'COMMENT', content: '⚠️ 3 lembretes da documentação da CAIXA sem retorno do cliente, mas o funil deste card não tem a etapa "Follow Up": o card ficou em Análise CAIXA.' } }).catch(() => {});
        }
        continue;
      }
      const ok = await enviarLembrete(accountId, l.id, l.name, cf, passo.i, io);
      if (!ok) continue;
      enviados++;
      await salva(l.id, { passo: passo.i + 1, ultimoAt: new Date().toISOString() });
    } catch (e: any) { console.error(`[CAIXA docs] ${l.name} (${l.id}):`, e?.message || e); }
  }
}

/** Mensagem nossa no WhatsApp, desde `desde`, que pede a documentação da CAIXA. */
async function pedidoFeito(leadId: string, desde: Date): Promise<boolean> {
  const m = await prisma.message.findFirst({
    where: { leadId, direction: 'OUTBOUND', channel: 'WHATSAPP', deleted: false, status: { not: 'FAILED' }, createdAt: { gte: desde },
      AND: [{ content: { contains: 'caixa', mode: 'insensitive' } }, { content: { contains: 'document', mode: 'insensitive' } }] },
    select: { id: true },
  });
  return !!m;
}

async function enviarLembrete(accountId: string, leadId: string, leadName: string, cf: Record<string, any>, i: number, io: Io, origem = 'Análise CAIXA'): Promise<boolean> {
  const lembrete = CAIXA_LEMBRETES[i % CAIXA_LEMBRETES.length];
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, leadName) || 'tudo bem';
  const texto = lembrete.texto(nome);
  const { whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const { sendOutboundWhatsApp, sendOutboundWhatsAppTemplate } = require('./message.service') as typeof import('./message.service');
  const aberta = await whatsappWindowOpen(leadId);
  const r = aberta
    ? await sendOutboundWhatsApp({ accountId, leadId, content: texto, buttons: lembrete.botoes, io: io || undefined })
    : await sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: lembrete.template, language: 'pt_BR', bodyParams: lembrete.params ? [nome] : [], previewText: `${texto}\n\n${lembrete.botoes.map((b) => `[${b}]`).join('  ')}`, io: io || undefined });
  if (!r.success) {
    console.error(`[CAIXA docs] ${leadName}: lembrete ${i + 1} não saiu — ${(r as any).error}`);
    return false;
  }
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: origem === 'Análise CAIXA'
    ? `🔁 Lembrete da documentação da CAIXA ${i + 1} de 3${aberta ? '' : ` (template ${lembrete.template})`} — 1 por dia; sem retorno depois do 3º, o card vai pro Follow Up (Fabio 14/11).`
    : `🔁 Follow Up com lembrete da documentação da CAIXA${aberta ? '' : ` (template ${lembrete.template})`}: o cliente já preencheu a proposta, falta a documentação.` } }).catch(() => {});
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'ai_replied', leadId, leadName, summary: origem === 'Análise CAIXA' ? `lembrete da documentação da CAIXA ${i + 1} de 3` : 'Follow Up: lembrete da documentação da CAIXA' });
  return true;
}

/** Follow Up de quem veio da rota da CAIXA (follow-loop): no lugar de "conclua a sua proposta", o lembrete da documentação da CAIXA. */
export async function enviarFollowDocsCaixa(accountId: string, leadId: string, leadName: string, cf: Record<string, any>, i: number, io: Io): Promise<boolean> {
  return enviarLembrete(accountId, leadId, leadName, cf, i, io, 'Follow Up');
}

/** O card veio da rota da CAIXA pro Follow Up e a documentação ainda não fechou? (o follow-loop troca os textos). Pura. */
export function followDaCaixa(cf: Record<string, any>): boolean {
  return !!cf?._caixaDocsLoop?.followUpAt && !!cf._caixaRota && !cf._caixaDocsAt;
}

async function moverParaFollowUp(accountId: string, l: { id: string; name: string; pipelineId: string }, io: Io): Promise<string | null> {
  const etapa = (await prisma.stage.findMany({ where: { pipelineId: l.pipelineId }, orderBy: { order: 'asc' }, select: { id: true, name: true } })).find((s) => /^follow up/.test(norm(s.name)));
  if (!etapa) return null;
  const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
  await updateLeadStage(l.id, accountId, etapa.id);
  // O loop do Follow Up começa do 1º (estado antigo, de antes da proposta, não vale).
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) - '_followLoop' - '_followPrazo' WHERE id = ${l.id}`;
  await prisma.note.create({ data: { leadId: l.id, type: 'STAGE_CHANGE', content: `🔁 Card movido pra "${etapa.name}" — 3 lembretes da documentação da CAIXA, 1 por dia, sem retorno do cliente (Fabio 14/11). Segue o fluxo do Follow Up com lembretes da documentação; se o cliente responder, o card volta pra Análise CAIXA.` } }).catch(() => {});
  io?.to(`lead:${l.id}`).emit('lead_moved', { leadId: l.id, stageId: etapa.id });
  avisa(accountId, `🔁 ${l.name}: Follow Up`, 'Documentação da CAIXA sem retorno depois de 3 lembretes', l.id);
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_stage_changed', leadId: l.id, leadName: l.name, summary: `documentação da CAIXA sem retorno: card pra "${etapa.name}"` });
  return etapa.name;
}

/** Cliente da rota da CAIXA que respondeu no Follow Up / Lead Sem Retorno → volta pra Análise CAIXA (a conferência dos documentos só roda lá). "Não tenho interesse" não volta. */
async function voltarDoFollowUp(accountId: string, io: Io): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaDocsLoop'->>'followUpAt' IS NOT NULL AND "customFields"->'_caixaRota' IS NOT NULL LIMIT 50`;
  for (const { id } of ids) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, customFields: true, pipelineId: true, stage: { select: { name: true } } } });
    if (!l) continue;
    const cf = (l.customFields || {}) as Record<string, any>;
    const st = cf._caixaDocsLoop as CaixaDocsLoopState;
    const etapaAtual = norm(l.stage?.name || '');
    if (/^analise\s+caixa/.test(etapaAtual)) continue;
    if (!/^(follow up|lead sem retorno)/.test(etapaAtual)) { await salva(id, { ...st, followUpAt: undefined }); continue; } // a equipe levou pra outra etapa: sai do fluxo
    const resp = await prisma.message.findFirst({ where: { leadId: id, direction: 'INBOUND', channel: 'WHATSAPP', deleted: false, createdAt: { gt: new Date(st.voltouAt && st.voltouAt > st.followUpAt! ? st.voltouAt : st.followUpAt!) } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
    if (!resp || /n[aã]o tenho (mais )?interesse|desist/i.test(String(resp.content || ''))) continue;
    const etapa = (await prisma.stage.findMany({ where: { pipelineId: l.pipelineId }, orderBy: { order: 'asc' }, select: { id: true, name: true } })).find((s) => /^analise\s+caixa/.test(norm(s.name)));
    if (!etapa) continue;
    const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
    await updateLeadStage(id, accountId, etapa.id);
    const due = new Date(Date.now() + 2 * 60_000).toISOString();
    await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaDocsLoop}', ${JSON.stringify({ passo: 0, voltouAt: new Date().toISOString() })}::jsonb, true), '{_docsCheckDue}', ${JSON.stringify(due)}::jsonb, true) WHERE id = ${id}`;
    await prisma.note.create({ data: { leadId: id, type: 'STAGE_CHANGE', content: `🏦 O cliente respondeu no ${l.stage?.name || 'Follow Up'}: card de volta pra "${etapa.name}" (documentação da CAIXA). A conferência confere o que ele mandou; sem documento, os lembretes recomeçam no dia seguinte.` } }).catch(() => {});
    io?.to(`lead:${id}`).emit('lead_moved', { leadId: id, stageId: etapa.id });
    logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_stage_changed', leadId: id, leadName: l.name, summary: `cliente respondeu: card de volta pra "${etapa.name}"` });
  }
}

