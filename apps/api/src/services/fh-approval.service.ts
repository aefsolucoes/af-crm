import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

/**
 * Financiamento Habitacional — aviso de aprovação e próximos passos (Fabio 27/10).
 * 1) Os bancos do Credimorar (Bradesco, Itaú, Santander, Inter) aprovam → o cliente recebe as propostas aprovadas, uma mensagem por banco com o botão
 *    "Seguir com esta" (SEM a simulação: ela só vai depois da escolha).
 * 2) O cliente escolhe → o CRM manda a simulação (PDF "Evolução das parcelas" do Credimorar, baixado pela extensão) daquele banco e pergunta se ele quer
 *    aprovar também na CAIXA e no BRB.
 * 3) Sim → documentação COMPLETA (lista do perfil: setor privado, servidor, empresário, aposentado) + imóvel + vendedor; Não → segue com o banco escolhido:
 *    aprovado no automático e o banco não pediu renda = só RG/CNH e comprovante de residência + imóvel + vendedor. Nos dois casos vão as TAXAS do
 *    financiamento e o card vai pra Aguardando Documentação.
 * O estado fica no card: `_fhNotice` (aviso enviado), `_fhChosen` (banco escolhido), `_fhCaixaAsk` / `_fhCaixaAnswer` (pergunta da CAIXA/BRB).
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

interface FhOption { banco: string; valor: string; prazo: string; taxa: string; cet: string }

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
      aprovadas.push({ banco, valor: valor ? `R$ ${valor}` : '', prazo, taxa: c[3] || '', cet: c[4] || '' });
    } else if (/em an[aá]lise|aguard|pendente|processando/i.test(b.status)) emAnalise.push(banco);
  }
  return { aprovadas, emAnalise };
}

export function fhOptionText(o: FhOption): string {
  return [
    `${FH_NOTICE_MARK} *${o.banco}*`,
    o.valor && `💰 Valor financiado: ${o.valor}`,
    o.prazo && `📅 Prazo: ${o.prazo} meses`,
    o.taxa && `📈 Taxa efetiva: ${o.taxa}% a.a.`,
    o.cet && `📊 CET: ${o.cet}% a.a.`,
  ].filter(Boolean).join('\n');
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
    if (cf._autoPaused || cf._fhNotice?.sentAt || !cf._fhResumo) continue;
    const run = await prisma.creditAnalysis.findFirst({ where: { leadId: l.id, bank: FH_BANK, kind: 'RUN', dryRun: false, conditions: { not: null } }, orderBy: { createdAt: 'desc' }, select: { conditions: true } });
    const { aprovadas, emAnalise } = fhOptions(parseBancosFinanciamento(cf._fhResumo), `CONDIÇÕES — ${run?.conditions || ''}`);
    if (!aprovadas.length) continue;
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
  await saveCf(leadId, { _fhNotice: { sentAt: new Date().toISOString(), bancos: aprovadas.map((o) => o.banco) } }); // antes de enviar: se algo falhar no meio, não repete em laço
  const a = await sendOutboundWhatsApp({ ...base, content: intro });
  if (!a.success) { await note(leadId, `⚠️ O aviso do Financiamento aprovado NÃO saiu (${a.error}). Avise o cliente à mão.`); return false; }
  for (const o of aprovadas) {
    await pausa();
    const r = await sendOutboundWhatsApp({ ...base, content: fhOptionText(o), buttons: [CHOOSE] });
    if (!r.success) await sendOutboundWhatsApp({ ...base, content: `${fhOptionText(o)}\n\n👉 Para seguir com esta, é só me responder "${o.banco}".` });
  }
  if (emAnalise.length) { await pausa(); await sendOutboundWhatsApp({ ...base, content: `⏳ Ainda em análise: ${emAnalise.join(', ')}. Se aprovar, te aviso por aqui.` }); }
  return true;
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

async function chooseFhBank(accountId: string, lead: { id: string; name: string; aiAutoReplyActive: boolean }, cf: Cf, banco: string, io?: any): Promise<boolean> {
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const jaEra = cf._fhChosen?.bank === banco;
  await saveCf(lead.id, { _fhChosen: { bank: banco, at: new Date().toISOString() } });
  if (!jaEra) {
    await note(lead.id, `⭐ Financiamento: o cliente escolheu o ${banco} (botão "Seguir com esta").`);
    push(accountId, `🏠 ${lead.name}: escolheu o ${banco}`, 'Financiamento — o CRM manda a simulação e pergunta da CAIXA/BRB', lead.id);
    logActivity({ accountId, userId: null, userName: 'Cliente', action: 'lead_updated', leadId: lead.id, leadName: lead.name, summary: `escolheu o ${banco} no Financiamento ("Seguir com esta")` });
  }
  io?.to(`lead:${lead.id}`).emit('lead_updated', { leadId: lead.id });
  if (!lead.aiAutoReplyActive) { await note(lead.id, '💬 A IA deste card está desligada: mande a simulação do banco escolhido e pergunte se ele quer aprovar também na CAIXA e no BRB.'); return true; }
  if (jaEra && cf._fhCaixaAsk?.at) return true; // tocou de novo no mesmo botão: não repete
  // Simulação do banco escolhido: a extensão do Credimorar baixa o "Evolução das parcelas" e o CRM manda com a logo A&F.
  const inst = PDF_INST[banco];
  if (inst) {
    try {
      const { requestSimulationDocs } = require('./simulation-doc.service') as typeof import('./simulation-doc.service');
      await requestSimulationDocs(prisma as any, { accountId, leadId: lead.id, institutions: [inst], source: 'AI', caption: `Segue a simulação do financiamento no ${banco} em PDF 📄` });
    } catch (e: any) { await note(lead.id, `⚠️ Não consegui pedir a simulação do ${banco} em PDF (${e?.message}). Mande à mão.`); }
  }
  await sendOutboundWhatsApp({ accountId, leadId: lead.id, io, content: `Perfeito! ✅ Vamos seguir com o *${banco}*. Já te mando a simulação em PDF.` });
  await new Promise((r) => setTimeout(r, 1200));
  const pergunta = `Você quer ${CAIXA_ASK_MARK} também? Nesses dois bancos a análise é feita com a documentação completa.`;
  const r = await sendOutboundWhatsApp({ accountId, leadId: lead.id, io, content: pergunta, buttons: [CAIXA_SIM, CAIXA_NAO] });
  if (!r.success) await sendOutboundWhatsApp({ accountId, leadId: lead.id, io, content: `${pergunta}\n\nÉ só me responder *sim* ou *não*.` });
  await saveCf(lead.id, { _fhCaixaAsk: { at: new Date().toISOString(), banco } });
  return true;
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
  const { moveToAwaitingDocs } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const { parseBancosFinanciamento } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  await saveCf(lead.id, { _fhCaixaAnswer: { resposta, at: new Date().toISOString() } });
  const banco = cf._fhChosen?.bank || cf._fhCaixaAsk?.banco || '';
  const imovel = itens((await template(accountId, 'Documentos imóvel para vistoria')) || '• Certidão de ônus\n• CND de IPTU');
  const vendedor = itens((await template(accountId, 'Documentos vendedor do imóvel')) || '• Documento de identificação\n• Comprovante de residência\n• Estado civil\n• Conta para crédito');
  const blocoImovel = `*Imóvel:*\n${imovel.map((x) => `• ${x}`).join('\n')}\n\n*Vendedor:*\n${vendedor.map((x) => `• ${x}`).join('\n')}\n• E-mail e telefone`;
  let docs: string;
  let resumoNota: string;
  if (resposta === 'SIM') {
    // Documentação COMPLETA (a CAIXA e o BRB analisam com ela): lista do perfil do comprador + imóvel + vendedor.
    const nomeTpl = perfilTemplate(cf);
    const perfil = (await template(accountId, nomeTpl)) || 'Para dar andamento à aprovação do financiamento, precisamos dos documentos abaixo:\n\n📑 Pessoais: RG e CPF (ou CNH), certidão (nasc./cas.), comprovante de residência\n💼 Renda: 3 últimos contracheques, IR + recibo (se houver), 3 últimos extratos bancários e FGTS (se usar)';
    docs = `Combinado! Vamos aprovar também na CAIXA e no BRB. 😊\n\n${perfil}\n\n${blocoImovel}`;
    resumoNota = `quer aprovar também na CAIXA e no BRB → mandei a documentação COMPLETA ("${nomeTpl}" + imóvel + vendedor)`;
  } else {
    // Segue só com o banco escolhido. Aprovado no automático e sem pedido de renda do banco: só RG/CNH e comprovante de residência + imóvel + vendedor (Fabio 27/10).
    const status = parseBancosFinanciamento(cf._fhResumo)[banco];
    const pediuRenda = !status || !/^aprovad[oa]$/i.test(status.status.trim()) || /renda|holerite|contracheque|extrato|imposto de renda|documenta[cç][aã]o/i.test(status.texto.replace(/^[^—]*—/, ''));
    const perfil = pediuRenda ? (await template(accountId, perfilTemplate(cf))) : null;
    const renda = perfil ? (perfil.split('\n').find((l) => /renda/i.test(l)) || '').replace(/^\W*renda\s*:?\s*/i, '').trim() : '';
    docs = `Combinado! Vamos seguir com o ${banco || 'banco escolhido'}. Para continuar, preciso dos documentos abaixo:\n\n*Comprador:*\n• Documento de identificação (RG ou CNH)\n• Comprovante de residência${renda ? `\n• Renda: ${renda}` : ''}\n\n${blocoImovel}`;
    resumoNota = `segue só com o ${banco || 'banco escolhido'} → mandei RG/CNH + comprovante de residência${renda ? ' + RENDA (o banco não aprovou no automático ou pediu renda)' : ''} + imóvel + vendedor`;
  }
  await sendOutboundWhatsApp({ accountId, leadId: lead.id, io, content: docs });
  const taxas = await template(accountId, 'Taxas Financiamento Habitacional');
  if (taxas) { await new Promise((r) => setTimeout(r, 1200)); await sendOutboundWhatsApp({ accountId, leadId: lead.id, io, content: taxas }); }
  const movido = await moveToAwaitingDocs({ accountId, leadId: lead.id, io }).catch((e: any) => { console.error('[Financiamento] mover pra Aguardando Documentação:', e?.message); return null; });
  await note(lead.id, `🏠 Financiamento: o cliente ${resumoNota}${taxas ? ' e as taxas do financiamento' : ''}.${movido ? ` Card movido pra "${movido}".` : ''}`);
  push(accountId, `🏠 ${lead.name}: ${resposta === 'SIM' ? 'quer CAIXA/BRB também' : `segue com o ${banco || 'banco escolhido'}`}`, 'Lista de documentos e taxas enviadas', lead.id);
  return true;
}
