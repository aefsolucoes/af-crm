import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

/**
 * Financiamento Habitacional — aviso de aprovação e próximos passos (Fabio 27/10).
 * 1) Os bancos do Credimorar (Bradesco, Itaú, Santander, Inter) aprovam → o cliente recebe as propostas aprovadas, uma mensagem por banco com o botão
 *    "Seguir com esta" (SEM a simulação: ela só vai depois da escolha).
 * 2) O cliente escolhe → na hora vão a simulação (PDF "Evolução das parcelas" do Credimorar, baixado pela extensão) daquele banco, a LISTA DE DOCUMENTOS
 *    (aprovado no automático e sem pedido de renda = só RG/CNH e comprovante de residência + imóvel + vendedor; senão também a renda), os PRÓXIMOS PASSOS e
 *    as TAXAS do financiamento, e o card vai pra Aguardando Documentação (Fabio 27/10: "assim que aprovar e o cliente escolher a proposta").
 * 3) Por último pergunta se ele quer aprovar também na CAIXA e no BRB: Sim → documentação completa do perfil do comprador (setor privado, servidor,
 *    empresário, aposentado), que é com o que esses dois bancos analisam; Não → segue só com o escolhido.
 * O estado fica no card: `_fhNotice` (aviso enviado), `_fhChosen` (banco escolhido), `_fhDocsAt` (documentos enviados), `_fhCaixaAsk` / `_fhCaixaAnswer` (pergunta da CAIXA/BRB).
 */

type Cf = Record<string, any>;
const FH_BANK = 'CREDIMORAR_FH';
export const FH_NOTICE_MARK = '🏠 Financiamento aprovado —';
const CHOOSE = 'Seguir com esta';
export const CAIXA_SIM = 'Sim, quero';
export const CAIXA_NAO = 'Não, só esse banco';
const CAIXA_ASK_MARK = 'aprovar também na *CAIXA* e no *BRB*';
/** Banco do Credimorar → pedido de PDF da simulação (simulation-doc.service, SIM_INSTITUTIONS). */
const PDF_INST: Record<string, string> = { Bradesco: 'FH_BRADESCO', 'Itaú': 'FH_ITAU', Santander: 'FH_SANTANDER', Inter: 'FH_INTER' };
/** Primeiro banco aprovou e os outros ainda analisam: espera no máximo isso pra mandar só o que já saiu (Bradesco às vezes leva um dia). */
const MAX_WAIT_OTHERS_MS = 12 * 3_600_000;

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const firstName = (s: unknown) => { const w = String(s || '').trim().split(/\s+/)[0] || ''; return w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''; };

async function saveCf(leadId: string, patch: Cf) {
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, ...patch } as any } });
}
const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => {
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* push é só aviso */ }
};

interface FhOption { banco: string; valor: string; prazo: string; taxa: string; cet: string; parcela?: string; condicao?: string; pedido?: string }

/** Propostas aprovadas e bancos ainda em análise, pela situação gravada (_fhResumo) + condições da rodada ("CONDIÇÕES — Bradesco: financia …; prazo …; taxa efetiva …; CET …"). Pura. */
export function fhOptions(resumo: Record<string, { status: string; texto: string }>, condicoes: string): { aprovadas: FhOption[]; emAnalise: string[] } {
  const aprovadas: FhOption[] = [];
  const emAnalise: string[] = [];
  for (const [banco, b] of Object.entries(resumo)) {
    if (/^(CAIXA|BRB)$/.test(banco)) continue;
    if (/aprovad/i.test(b.status)) {
      const c = new RegExp(`${banco}:\\s*financia\\s*([\\d.,]+);\\s*prazo\\s*(\\d+)\\s*meses;\\s*taxa efetiva\\s*([\\d.,]+)%\\s*a\\.a\\.;\\s*CET\\s*([\\d.,]+)%`, 'i').exec(condicoes) || [];
      const valor = (/R\$\s*(\d{1,3}(?:\.\d{3})*,\d{2})/.exec(b.texto) || [])[1] || c[1] || '';
      const prazo = (/(\d+)\s*meses/.exec(b.texto) || [])[1] || c[2] || '';
      // Taxa/CET/parcela também do texto do banco (o Inter do nosso portal traz "juros 9,99% a.a. + IPCA; CET 11,15% a.a.") — Fabio 29/10: "no mesmo padrão do Home Equity".
      const juros = (/juros\s*([\d.,]+%\s*a\.\s*[am]\.(?:\s*\+\s*[A-Z]+)?)/i.exec(b.texto) || [])[1] || '';
      const taxa = c[3] ? `${c[3]}% a.a.` : juros || ((/taxa efetiva\s*([\d.,]+)%/i.exec(b.texto) || [])[1] ? `${(/taxa efetiva\s*([\d.,]+)%/i.exec(b.texto) || [])[1]}% a.a.` : '');
      const cet = c[4] || (/CET\s*([\d.,]+)%/i.exec(b.texto) || [])[1] || '';
      const parcela = (/1[ªa]\s*parcela\s*R\$\s*([\d.,]+)/i.exec(b.texto) || [])[1] || '';
      // Nunca o texto cru do portal (Fabio 29/10, Pedro Paulo: saiu "o envio de documentos (proposta 005732633 — lista: Tratativa comercial — Análise" pro cliente).
      const condicao = /condicion/i.test(`${b.status} ${b.texto}`) ? condicaoLegivel(b.texto) : '';
      aprovadas.push({ banco, valor: valor ? `R$ ${valor}` : '', prazo, taxa, cet, parcela: parcela ? `R$ ${parcela}` : '', condicao });
    } else if (/em an[aá]lise|aguard|pendente|processando/i.test(b.status)) emAnalise.push(banco);
  }
  return { aprovadas, emAnalise };
}

/** "… Documentos pendentes: Imóvel: Matrícula Imóvel, IPTU, Comprovante de Quitação Condominial …" → "envio dos documentos: Matrícula do imóvel, IPTU, …". Pura. */
export function condicaoLegivel(texto: string): string {
  const docs = (/Documentos pendentes:\s*([^\n]+?)(?:\.\s|\s—\s|$)/i.exec(String(texto || '')) || [])[1] || '';
  const itens = docs.split(/[;,]/).map((x) => x.replace(/^[^:]{1,40}:\s*/, '').replace(/Matr[ií]cula Im[oó]vel/i, 'Matrícula do imóvel').trim()).filter((x) => x && x.length < 60);
  return itens.length ? `envio dos documentos: ${Array.from(new Set(itens)).join(', ')}` : 'envio dos documentos pedidos pelo banco';
}

/** Mesmo padrão do aviso do Home Equity (approvalBlock): resumo da proposta, linha por informação. A 1ª linha (FH_NOTICE_MARK + banco) é a que o "Seguir com esta" reconhece. */
export function fhOptionText(o: FhOption): string {
  return [
    `${FH_NOTICE_MARK} *${o.banco}*`,
    '📋 Resumo da proposta:',
    `🏦 Instituição: ${o.banco}`,
    o.valor && `💰 Valor financiado: ${o.valor}`,
    o.pedido && `ℹ️ Valor menor que o solicitado (você pediu ${o.pedido})`,
    o.prazo && `📅 Prazo: ${o.prazo} meses`,
    o.taxa && `📈 Taxa de juros: ${o.taxa}`,
    o.cet && `📊 CET: ${o.cet}% a.a.`,
    o.parcela && `💵 1ª parcela: ${o.parcela}`,
    !o.parcela && `🧾 As parcelas exatas são confirmadas na formalização, conforme o valor e o prazo aprovados.`,
    o.condicao && `📌 Aprovação condicionada: ${o.condicao}`,
  ].filter(Boolean).join('\n');
}

/** Completa a opção com o que a análise do banco tem por inteiro (o resumo do card corta o texto): taxa/CET do Inter do nosso portal e o valor pedido. */
async function enriquecer(leadId: string, cf: Cf, ops: FhOption[]): Promise<FhOption[]> {
  const brl = (v: number) => `R$ ${v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const num = (t: string) => Number(String(t || '').replace(/[^\d,]/g, '').replace(',', '.')) || 0;
  const pedido = Number(String(cf.valor_credito || '').replace(/[^\d.]/g, '')) || 0;
  const inter = await prisma.creditAnalysis.findFirst({ where: { leadId, bank: 'INTER_FH', dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] } }, orderBy: { createdAt: 'desc' }, select: { detail: true } });
  return ops.map((o) => {
    const x = { ...o };
    if (o.banco === 'Inter' && inter?.detail) {
      const d = inter.detail;
      if (!x.taxa) x.taxa = (/juros\s*([\d.,]+%\s*a\.\s*[am]\.(?:\s*\+\s*[A-Z]+)?)/i.exec(d) || [])[1] || '';
      if (!x.cet) x.cet = (/CET\s*([\d.,]+)%/i.exec(d) || [])[1] || '';
      if (!x.valor) { const v = (/valor aprovado\s*R\$\s*([\d.,]+)/i.exec(d) || [])[1]; if (v) x.valor = `R$ ${v}`; }
      if (!x.prazo) x.prazo = (/prazo\s*(\d+)\s*meses/i.exec(d) || [])[1] || '';
      if (!x.parcela) { const p1 = (/1[ªa]\s*parcela\s*R\$\s*([\d.,]+)/i.exec(d) || [])[1]; if (p1) x.parcela = `R$ ${p1}`; }
      if (x.condicao) x.condicao = condicaoLegivel(d);
    }
    if (pedido && num(x.valor) && num(x.valor) + 1 < pedido) x.pedido = brl(pedido);
    return x;
  });
}

/** Roda no ciclo da análise automática: manda o aviso de aprovação do Financiamento quando dá. */
export async function processFhNotices(accountId: string, io?: any): Promise<void> {
  const { parseBancosFinanciamento } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const leads = await prisma.lead.findMany({
    where: {
      accountId, status: 'OPEN', archived: false, isGroup: false,
      pipeline: { department: { name: { contains: 'Habitacional', mode: 'insensitive' } } },
      creditAnalyses: { some: { bank: FH_BANK, status: { in: ['APPROVED', 'CONDITIONAL', 'SENT', 'CHECK', 'REQUESTED'] }, updatedAt: { gte: new Date(Date.now() - 20 * 86_400_000) } } },
    },
    select: { id: true, name: true, customFields: true, aiAutoReplyActive: true },
    take: 50,
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Cf;
    if (cf._autoPaused || !cf._fhResumo) continue;
    const run = await prisma.creditAnalysis.findFirst({ where: { leadId: l.id, bank: FH_BANK, kind: 'RUN', dryRun: false, conditions: { not: null } }, orderBy: { createdAt: 'desc' }, select: { conditions: true } });
    const op = fhOptions(parseBancosFinanciamento(cf._fhResumo), `CONDIÇÕES — ${run?.conditions || ''}`);
    const emAnalise = op.emAnalise;
    const aprovadas = await enriquecer(l.id, cf, op.aprovadas);
    if (!aprovadas.length) continue;
    // Cliente OPTOU pela CAIXA/BRB (Fabio 29/10, Taynara): as aprovações dos outros bancos ficam GUARDADAS — não vão sozinhas; a IA só fala delas se ele perguntar.
    if (cf._optouCaixa?.banco) {
      const guardadas = new Set<string>(Array.isArray(cf._aprovacoesGuardadas) ? cf._aprovacoesGuardadas : []);
      const novas = aprovadas.filter((o) => !guardadas.has(o.banco) && !(Array.isArray(cf._fhNotice?.bancos) && cf._fhNotice.bancos.includes(o.banco)));
      if (novas.length) {
        await saveCf(l.id, { _aprovacoesGuardadas: [...guardadas, ...novas.map((o) => o.banco)] });
        await note(l.id, `🗄️ Financiamento APROVADO no ${novas.map((o) => o.banco).join(', ')} — GUARDADO: o cliente optou pela ${cf._optouCaixa.banco}, não mandei. A IA só fala dessa aprovação se ele perguntar; pra mandar agora, use o aviso na aba Análise de Crédito.`);
        push(accountId, `🗄️ ${l.name}: aprovação guardada`, `${novas.map((o) => o.banco).join(', ')} aprovou — o cliente optou pela ${cf._optouCaixa.banco}`, l.id);
      }
      continue;
    }
    // Já avisado: banco que aprovou DEPOIS (Fabio 29/10, Taynara: só foi o Inter e o Santander aprovou em seguida) — manda essa proposta também, enquanto ele não escolheu.
    if (cf._fhNotice?.sentAt) {
      const ja = new Set<string>(Array.isArray(cf._fhNotice.bancos) ? cf._fhNotice.bancos : []);
      const novas = aprovadas.filter((o) => !ja.has(o.banco));
      // Aviso saiu SEM os números (aprovação condicional do Inter) e agora eles chegaram — igual ao Home Equity, vai a proposta completa (Fabio 29/10, Pedro Paulo:
      // "por que a aprovação não trouxe parcela, prazo, taxas igual ao do HE?").
      const semNum = new Set<string>(Array.isArray(cf._fhNotice.semNumeros) ? cf._fhNotice.semNumeros : []);
      const completas = aprovadas.filter((o) => semNum.has(o.banco) && o.valor && o.prazo);
      if (completas.length && !cf._fhChosen && inNoticeWindow() && l.aiAutoReplyActive && (await whatsappWindowOpen(l.id))) {
        const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
        await saveCf(l.id, { _fhNotice: { ...cf._fhNotice, semNumeros: [...semNum].filter((b) => !completas.some((o) => o.banco === b)) } });
        const nome = firstName(cf.falando_com || cf.participante_1 || l.name);
        await sendOutboundWhatsApp({ accountId, leadId: l.id, io, content: `📋 ${nome ? `${nome}, ` : ''}saíram as condições da sua proposta${completas.length > 1 ? 's' : ` no *${completas[0].banco}*`}:` });
        for (const o of completas) {
          await new Promise((r) => setTimeout(r, 1200));
          const r = await sendOutboundWhatsApp({ accountId, leadId: l.id, io, content: fhOptionText(o), buttons: [CHOOSE] });
          if (!r.success) await sendOutboundWhatsApp({ accountId, leadId: l.id, io, content: `${fhOptionText(o)}\n\n👉 Para seguir com esta, é só me responder "${o.banco}".` });
        }
        await note(l.id, `📣 Cliente recebeu as condições completas (valor, prazo, taxa, parcela) de: ${completas.map((o) => o.banco).join(', ')} — o 1º aviso tinha saído sem os números.`);
        continue;
      }
      if (!novas.length) continue;
      if (cf._fhChosen) {
        await saveCf(l.id, { _fhNotice: { ...cf._fhNotice, bancos: [...ja, ...novas.map((o) => o.banco)] } });
        await note(l.id, `🏠 Financiamento também APROVADO no ${novas.map((o) => o.banco).join(', ')} — o cliente já escolheu o ${cf._fhChosen.bank || 'outro banco'}, não mandei. Veja se vale oferecer.`);
        push(accountId, `🏠 ${l.name}: outro banco aprovou`, `${novas.map((o) => o.banco).join(', ')} — o cliente já escolheu outro`, l.id);
        continue;
      }
      if (!inNoticeWindow() || !l.aiAutoReplyActive || !(await whatsappWindowOpen(l.id))) continue;
      const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
      await saveCf(l.id, { _fhNotice: { ...cf._fhNotice, bancos: [...ja, ...novas.map((o) => o.banco)] } });
      const nome = firstName(cf.falando_com || cf.participante_1 || l.name);
      await sendOutboundWhatsApp({ accountId, leadId: l.id, io, content: `✅ ${nome ? `${nome}, ` : ''}seu financiamento também foi aprovado ${novas.length > 1 ? `em mais ${novas.length} bancos` : `no *${novas[0].banco}*`}! Veja abaixo e toque em *${CHOOSE}* na proposta que preferir.` });
      for (const o of novas) {
        await new Promise((r) => setTimeout(r, 1200));
        const r = await sendOutboundWhatsApp({ accountId, leadId: l.id, io, content: fhOptionText(o), buttons: [CHOOSE] });
        if (!r.success) await sendOutboundWhatsApp({ accountId, leadId: l.id, io, content: `${fhOptionText(o)}\n\n👉 Para seguir com esta, é só me responder "${o.banco}".` });
      }
      await note(l.id, `📣 Cliente avisado de mais um banco aprovado no Financiamento: ${novas.map((o) => o.banco).join(', ')}.`);
      continue;
    }
    const primeira = cf._fhFirstApprovalAt ? new Date(cf._fhFirstApprovalAt).getTime() : 0;
    if (!primeira) { await saveCf(l.id, { _fhFirstApprovalAt: new Date().toISOString() }); if (emAnalise.length) continue; }
    if (emAnalise.length && Date.now() - (primeira || Date.now()) < MAX_WAIT_OTHERS_MS) continue; // os outros ainda analisam: espera um pouco (no máximo 12 h)
    if (!inNoticeWindow()) continue;
    const bancos = aprovadas.map((o) => o.banco).join(', ');
    // Sem IA no card ou com a conversa fechada (24 h do WhatsApp): quem avisa é a equipe — o CRM avisa UMA vez.
    if (!l.aiAutoReplyActive || !(await whatsappWindowOpen(l.id))) {
      if (cf._fhNoticeTeamAt) continue;
      await saveCf(l.id, { _fhNoticeTeamAt: new Date().toISOString() });
      await note(l.id, `🏠 Financiamento APROVADO no ${bancos}. Não avisei o cliente sozinho (${!l.aiAutoReplyActive ? 'IA do card desligada' : 'conversa fechada há mais de 24 h no WhatsApp'}): avise ele e mande as propostas.`);
      push(accountId, `🏠 ${l.name}: financiamento aprovado`, `${bancos} — avise o cliente (${!l.aiAutoReplyActive ? 'IA desligada' : 'conversa fechada'})`, l.id);
      continue;
    }
    const out = await sendFhNotice(accountId, l.id, l.name, aprovadas, emAnalise, io);
    if (out) {
      await note(l.id, `📣 Cliente avisado do Financiamento aprovado (${bancos}), uma mensagem por banco com o botão "Seguir com esta". A simulação vai quando ele escolher.${emAnalise.length ? ` Ainda em análise: ${emAnalise.join(', ')}.` : ''}`);
      push(accountId, `🏠 ${l.name}: financiamento aprovado`, `Cliente avisado: ${bancos}`, l.id);
    }
  }
}

async function sendFhNotice(accountId: string, leadId: string, leadName: string, aprovadas: FhOption[], emAnalise: string[], io?: any): Promise<boolean> {
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const nome = firstName(cf.falando_com || cf.participante_1 || leadName);
  const base = { accountId, leadId, io };
  const pausa = () => new Promise((r) => setTimeout(r, 1200));
  const intro = aprovadas.length > 1
    ? `✅ ${nome ? `${nome}, ` : ''}boa notícia: seu financiamento foi aprovado em ${aprovadas.length} bancos! Veja as opções abaixo e toque em *${CHOOSE}* na que preferir.`
    : `✅ ${nome ? `${nome}, ` : ''}boa notícia: seu financiamento foi aprovado! Veja a proposta abaixo e toque em *${CHOOSE}* para seguirmos.`;
  await saveCf(leadId, { _fhNotice: { sentAt: new Date().toISOString(), bancos: aprovadas.map((o) => o.banco), semNumeros: aprovadas.filter((o) => !o.valor || !o.prazo).map((o) => o.banco) } }); // antes de enviar: se algo falhar no meio, não repete em laço
  const a = await sendOutboundWhatsApp({ ...base, content: intro });
  if (!a.success) { await note(leadId, `⚠️ O aviso do Financiamento aprovado NÃO saiu (${a.error}). Avise o cliente à mão.`); return false; }
  for (const o of aprovadas) {
    await pausa();
    const r = await sendOutboundWhatsApp({ ...base, content: fhOptionText(o), buttons: [CHOOSE] });
    if (!r.success) await sendOutboundWhatsApp({ ...base, content: `${fhOptionText(o)}\n\n👉 Para seguir com esta, é só me responder "${o.banco}".` });
  }
  if (emAnalise.length) { await pausa(); await sendOutboundWhatsApp({ ...base, content: `⏳ Ainda em análise: ${emAnalise.join(', ')}. Se aprovar, te aviso por aqui.` }); }
  await (require('./approval-notice.service') as typeof import('./approval-notice.service')).sendOutroCanalAviso(base); // já tentou por outro meio? + não tentar em outro canal (Fabio 29/10)
  return true;
}

/** O cliente disse ESCREVENDO com qual banco do Financiamento vai seguir (a IA marcou "chooseBank") — mesmo efeito do botão "Seguir com esta". */
export async function chooseFhBankByAi(accountId: string, leadId: string, bankKey: string, io?: any): Promise<boolean> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true, aiAutoReplyActive: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead || !/habitacional/i.test(lead.pipeline?.department?.name || '')) return false;
  const cf = (lead.customFields || {}) as Cf;
  const nome = ({ BRADESCO: 'Bradesco', ITAU: 'Itaú', SANTANDER: 'Santander', INTER: 'Inter' } as Record<string, string>)[bankKey];
  const avisados: string[] = Array.isArray(cf._fhNotice?.bancos) ? cf._fhNotice.bancos : [];
  if (!nome || !avisados.includes(nome) || cf._fhChosen?.bank === nome) return false;
  return chooseFhBank(accountId, lead, cf, nome, io);
}

/** Botões e respostas do fluxo do Financiamento. true = tratou (a IA da conversa não responde por cima). */
export async function maybeHandleFhReply(accountId: string, leadId: string, text: string, repliedWamid: string | undefined, io?: any): Promise<boolean> {
  const t = norm(text);
  if (!t) return false;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true, aiAutoReplyActive: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead || !/habitacional/i.test(lead.pipeline?.department?.name || '')) return false;
  const cf = (lead.customFields || {}) as Cf;
  const replied = repliedWamid ? await prisma.message.findFirst({ where: { externalId: repliedWamid, leadId, direction: 'OUTBOUND' }, select: { content: true } }) : null;

  // 1) "Seguir com esta" numa proposta do Financiamento (ou o nome do banco, quando o botão não saiu)
  const bancoDoBotao = t === norm(CHOOSE) && replied?.content?.includes(FH_NOTICE_MARK) ? (/Financiamento aprovado —\s*\*?([^*\n]+)\*?/.exec(replied.content) || [])[1]?.trim() : null;
  const avisados: string[] = Array.isArray(cf._fhNotice?.bancos) ? cf._fhNotice.bancos : [];
  const bancoPorNome = !bancoDoBotao && cf._fhNotice?.sentAt && !cf._fhChosen && t.length <= 25 ? avisados.find((b) => t === norm(b) || t === `seguir com o ${norm(b)}`) : null;
  const banco = bancoDoBotao || bancoPorNome;
  if (banco) return chooseFhBank(accountId, lead, cf, banco, io);

  // 2) Resposta à pergunta da CAIXA/BRB
  if (cf._fhCaixaAsk?.at && !cf._fhCaixaAnswer) {
    const recente = Date.now() - new Date(cf._fhCaixaAsk.at).getTime() < 72 * 3_600_000;
    const doBotao = replied?.content?.includes(CAIXA_ASK_MARK);
    const sim = t === norm(CAIXA_SIM) || (recente && t.length <= 30 && /^(sim|quero|pode|claro|ok|aceito|vamos|bora|isso)\b/.test(t) && !/\bnao\b/.test(t));
    const nao = t === norm(CAIXA_NAO) || (recente && t.length <= 40 && /^(nao|n\b|só esse|so esse|nao quero|prefiro (so|seguir))/.test(t));
    if ((sim || nao) && (doBotao || recente)) return answerCaixaBrb(accountId, lead, cf, sim ? 'SIM' : 'NAO', io);
  }
  return false;
}

/** Escolha do Financiamento preenche o card igual ao "Seguir com esta" do Home Equity (chooseAnalysis): ⭐ na análise, instituição, valor, prazo, taxa, 1ª parcela,
 *  nº da proposta e Valor da venda (Fabio 29/10: "todo o processo do HE deve migrar pro FH"). */
export async function preencherEscolhaFh(accountId: string, leadId: string, banco: string): Promise<void> {
  const { parseBancosFinanciamento, chooseAnalysis } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const run = await prisma.creditAnalysis.findFirst({ where: { leadId, bank: FH_BANK, kind: 'RUN', dryRun: false, conditions: { not: null } }, orderBy: { createdAt: 'desc' }, select: { conditions: true } });
  const [o] = await enriquecer(leadId, cf, fhOptions(parseBancosFinanciamento(cf._fhResumo), `CONDIÇÕES — ${run?.conditions || ''}`).aprovadas.filter((x) => x.banco === banco));
  // Inter: a linha do nosso portal tem os números estruturados — ⭐ nela pelo mesmo caminho do HE.
  if (banco === 'Inter') {
    const row = await prisma.creditAnalysis.findFirst({ where: { leadId, bank: 'INTER_FH', dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] }, approvedValue: { not: null } }, orderBy: { approvedValue: 'desc' }, select: { id: true } });
    if (row) { await chooseAnalysis(prisma as any, { accountId, id: row.id, userName: 'Cliente — "Seguir com esta" no Financiamento' }); return; }
  }
  if (!o) return;
  const num = (t: string) => Number(String(t || '').replace(/[^\d,]/g, '').replace(',', '.')) || 0;
  const valor = num(o.valor);
  const proposta = (new RegExp(`${banco}:[^|]*?proposta\\s*(\\d{5,})`, 'i').exec(String(cf._fhResumo || '')) || [])[1];
  const fill: Cf = { instituicao: banco };
  if (valor) { fill.valor_credito = String(valor); if (cf.valor_credito && Number(String(cf.valor_credito).replace(/[^\d.]/g, '')) !== valor) fill._valorPedido = cf.valor_credito; }
  if (o.prazo) fill.prazo_financ = `${o.prazo} meses`;
  if (o.taxa) fill.taxa_efetiva = o.taxa;
  if (o.parcela) fill.primeira_parcela = String(num(o.parcela));
  if (proposta) fill.num_proposta = proposta;
  await saveCf(leadId, fill);
  if (valor) await prisma.lead.update({ where: { id: leadId }, data: { value: valor } });
  await note(leadId, `⭐ Proposta escolhida: ${banco}${o.valor ? ` — ${o.valor}` : ''}. Card preenchido: ${Object.keys(fill).filter((k) => !k.startsWith('_')).join(', ')}.`);
}

async function chooseFhBank(accountId: string, lead: { id: string; name: string; aiAutoReplyActive: boolean }, cf: Cf, banco: string, io?: any): Promise<boolean> {
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const { moveToAwaitingDocs } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const jaEra = cf._fhChosen?.bank === banco;
  await saveCf(lead.id, { _fhChosen: { bank: banco, at: new Date().toISOString() } });
  if (!jaEra) await preencherEscolhaFh(accountId, lead.id, banco).catch((e: any) => console.error('[Financiamento] preencher a escolha:', e?.message));
  if (!jaEra) {
    await note(lead.id, `⭐ Financiamento: o cliente escolheu o ${banco} (botão "Seguir com esta").`);
    push(accountId, `🏠 ${lead.name}: escolheu o ${banco}`, 'Financiamento — o CRM manda simulação, documentos, próximos passos e taxas', lead.id);
    logActivity({ accountId, userId: null, userName: 'Cliente', action: 'lead_updated', leadId: lead.id, leadName: lead.name, summary: `escolheu o ${banco} no Financiamento ("Seguir com esta")` });
  }
  io?.to(`lead:${lead.id}`).emit('lead_updated', { leadId: lead.id });
  if (!lead.aiAutoReplyActive) { await note(lead.id, '💬 A IA deste card está desligada: mande a simulação do banco escolhido, a lista de documentos, os próximos passos e as taxas, e pergunte se ele quer aprovar também na CAIXA e no BRB.'); return true; }
  if (jaEra && cf._fhDocsAt) return true; // tocou de novo no mesmo botão: não repete
  const pausa = () => new Promise((r) => setTimeout(r, 1200));
  // Simulação do banco escolhido: a extensão do Credimorar baixa o "Evolução das parcelas" e o CRM manda com a logo A&F.
  const inst = PDF_INST[banco];
  if (inst) {
    try {
      const { requestSimulationDocs } = require('./simulation-doc.service') as typeof import('./simulation-doc.service');
      await requestSimulationDocs(prisma as any, { accountId, leadId: lead.id, institutions: [inst], source: 'AI', caption: `Segue a simulação do financiamento no ${banco} em PDF 📄` });
    } catch (e: any) { await note(lead.id, `⚠️ Não consegui pedir a simulação do ${banco} em PDF (${e?.message}). Mande à mão.`); }
  }
  // Na escolha já vão a LISTA DE DOCUMENTOS, os PRÓXIMOS PASSOS e as TAXAS, e o card vai pra Aguardando Documentação (Fabio 27/10).
  const { texto, comRenda } = await docsBancoEscolhido(accountId, cf, banco);
  await sendOutboundWhatsApp({ accountId, leadId: lead.id, io, content: `Perfeito! ✅ Vamos seguir com o *${banco}*. Já te mando a simulação em PDF.\n\n${texto}` });
  const passos = await template(accountId, 'Proximos passos financiamento');
  if (passos) { await pausa(); await sendOutboundWhatsApp({ accountId, leadId: lead.id, io, content: passos }); }
  const taxas = await template(accountId, 'Taxas Financiamento Habitacional');
  if (taxas) { await pausa(); await sendOutboundWhatsApp({ accountId, leadId: lead.id, io, content: taxas }); }
  await saveCf(lead.id, { _fhDocsAt: new Date().toISOString() });
  const movido = await moveToAwaitingDocs({ accountId, leadId: lead.id, io }).catch((e: any) => { console.error('[Financiamento] mover pra Aguardando Documentação:', e?.message); return null; });
  // Por último: quer aprovar também na CAIXA e no BRB? (eles analisam com a documentação completa)
  await pausa();
  const pergunta = `Você quer ${CAIXA_ASK_MARK} também? Nesses dois bancos a análise é feita com a documentação completa (inclusive a de renda).`;
  const r = await sendOutboundWhatsApp({ accountId, leadId: lead.id, io, content: pergunta, buttons: [CAIXA_SIM, CAIXA_NAO] });
  if (!r.success) await sendOutboundWhatsApp({ accountId, leadId: lead.id, io, content: `${pergunta}\n\nÉ só me responder *sim* ou *não*.` });
  await saveCf(lead.id, { _fhCaixaAsk: { at: new Date().toISOString(), banco } });
  await note(lead.id, `🏠 Financiamento (${banco}): mandei a simulação em PDF, a lista de documentos (RG/CNH + comprovante de residência${comRenda ? ' + RENDA' : ''} + imóvel + vendedor)${passos ? ', os próximos passos' : ''}${taxas ? ' e as taxas' : ''}, e perguntei se ele quer aprovar também na CAIXA e no BRB.${movido ? ` Card movido pra "${movido}".` : ''}`);
  return true;
}

/** Documentos pra seguir com o banco escolhido: aprovado no automático e sem pedido de renda = só RG/CNH e comprovante de residência + imóvel + vendedor (Fabio 27/10). */
async function docsBancoEscolhido(accountId: string, cf: Cf, banco: string): Promise<{ texto: string; comRenda: boolean }> {
  const { parseBancosFinanciamento } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const status = parseBancosFinanciamento(cf._fhResumo)[banco];
  const pediuRenda = !status || !/^aprovad[oa]$/i.test(status.status.trim()) || /renda|holerite|contracheque|extrato|imposto de renda|documenta[cç][aã]o/i.test(status.texto.replace(/^[^—]*—/, ''));
  const perfil = pediuRenda ? (await template(accountId, perfilTemplate(cf))) : null;
  const renda = perfil ? (perfil.split('\n').find((l) => /renda/i.test(l)) || '').replace(/^\W*renda\s*:?\s*/i, '').trim() : '';
  return { texto: `Para continuar, preciso dos documentos abaixo:\n\n*Comprador:*\n• Documento de identificação (RG ou CNH)\n• Comprovante de residência${renda ? `\n• Renda: ${renda}` : ''}\n\n${await blocoImovelVendedor(accountId)}`, comRenda: !!renda };
}

async function blocoImovelVendedor(accountId: string): Promise<string> {
  const imovel = itens((await template(accountId, 'Documentos imóvel para vistoria')) || '• Certidão de ônus\n• CND de IPTU');
  const vendedor = itens((await template(accountId, 'Documentos vendedor do imóvel')) || '• Documento de identificação\n• Comprovante de residência\n• Estado civil\n• Conta para crédito');
  return `*Imóvel:*\n${imovel.map((x) => `• ${x}`).join('\n')}\n\n*Vendedor:*\n${vendedor.map((x) => `• ${x}`).join('\n')}\n• E-mail e telefone`;
}

/** Lista de documentos do comprador pelo PERFIL (Respostas rápidas "Documentos comprador …" — a equipe edita lá). */
function perfilTemplate(cf: Cf): string {
  const v = norm(`${cf.vinculo_1 || ''} ${cf.perfil_renda || ''}`);
  if (/servidor|public/.test(v)) return 'Documentos comprador servidor público';
  if (/aposent|pension/.test(v)) return 'Documentos Aposentado';
  if (/empres|autonom|\bpj\b|\bmei\b|liberal|socio|proprietari/.test(v)) return 'Documentos comprador empresário';
  return 'Documentos comprador setor privado';
}

const itens = (body: string) => body.split('\n').map((l) => l.trim()).filter((l) => /^[•\-–]/.test(l)).map((l) => l.replace(/^[•\-–]\s*/, '').trim()).filter((l) => l && !/^(e-?mail|telefone):?$/i.test(l));

async function template(accountId: string, nome: string): Promise<string | null> {
  const t = await prisma.messageTemplate.findFirst({ where: { accountId, name: { equals: nome, mode: 'insensitive' } }, select: { body: true } });
  return t?.body?.trim() || null;
}

async function answerCaixaBrb(accountId: string, lead: { id: string; name: string; aiAutoReplyActive: boolean }, cf: Cf, resposta: 'SIM' | 'NAO', io?: any): Promise<boolean> {
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  await saveCf(lead.id, { _fhCaixaAnswer: { resposta, at: new Date().toISOString() } });
  const banco = cf._fhChosen?.bank || cf._fhCaixaAsk?.banco || 'banco escolhido';
  if (resposta === 'SIM') {
    // A CAIXA e o BRB analisam com a documentação COMPLETA: a lista do perfil do comprador (pessoais + renda). Imóvel e vendedor já foram na escolha.
    const nomeTpl = perfilTemplate(cf);
    const perfil = (await template(accountId, nomeTpl)) || 'Para dar andamento à aprovação do financiamento, precisamos dos documentos abaixo:\n\n📑 Pessoais: RG e CPF (ou CNH), certidão (nasc./cas.), comprovante de residência\n💼 Renda: 3 últimos contracheques, IR + recibo (se houver), 3 últimos extratos bancários e FGTS (se usar)';
    await sendOutboundWhatsApp({ accountId, leadId: lead.id, io, content: `Combinado! Vamos aprovar também na CAIXA e no BRB. 😊 Para esses dois bancos, além dos documentos que te passei, preciso da documentação completa do comprador:\n\n${perfil}` });
    await note(lead.id, `🏠 Financiamento: o cliente QUER aprovar também na CAIXA e no BRB → mandei a documentação completa ("${nomeTpl}"). CAIXA e BRB rodam com a documentação completa.`);
    push(accountId, `🏠 ${lead.name}: quer CAIXA/BRB também`, 'Documentação completa pedida', lead.id);
  } else {
    await sendOutboundWhatsApp({ accountId, leadId: lead.id, io, content: `Combinado, seguimos com o ${banco}. Fico no aguardo dos documentos. 😊` });
    await note(lead.id, `🏠 Financiamento: o cliente NÃO quer CAIXA/BRB — segue só com o ${banco}.`);
  }
  return true;
}
