import { PrismaClient } from '@prisma/client';
import { sendOutboundMedia } from './message.service';
import { brandSimulationPdf, parseInterTheoryPdf, InterTheory, looksLikePortalPdf, parsePortalSheetPdf } from './simulation-pdf.service';
import { renderSimulationSheet, brl, SimulationSheet, SheetRow, taxasDe } from './simulation-sheet.service';

type Db = PrismaClient;
type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

/**
 * Simulação em PDF pro cliente — SEMPRE no modelo do Credimorar com a logo A&F no alto:
 *   SANTANDER (Credimorar, "mode pdf"): a extensão baixa o PDF ORIGINAL do portal e o CRM só troca cor/logo (idêntico ao modelo).
 *   INTER / CREDITAS ("mode data"): a extensão só LÊ os dados no portal do banco e o CRM desenha o PDF no mesmo modelo.
 * Fluxo: CRM cria o pedido → extensão do banco pega na fila (`caps=doc`) e devolve → CRM monta e manda como documento no WhatsApp
 * (sendOutboundMedia, grátis dentro da janela de 24h). Nunca vai PDF cru de portal: se não der pra montar, o pedido falha com o motivo.
 */

export const SIM_INSTITUTIONS: Record<string, { label: string; extBank: 'CREDIMORAR' | 'INTER' | 'CREDITAS'; mode: 'pdf' | 'data'; credimorarId?: number }> = {
  SANTANDER: { label: 'Santander', extBank: 'CREDIMORAR', mode: 'pdf', credimorarId: 2 }, // coluna Santander do Credimorar
  INTER: { label: 'Inter', extBank: 'INTER', mode: 'data' },
  CREDITAS: { label: 'Creditas', extBank: 'CREDITAS', mode: 'data' },
};

const REQUESTED_TTL_MIN = 15; // ninguém pegou o pedido (extensão fechada/desatualizada)
const RUNNING_TTL_MIN = 10; // pegou e não devolveu (aba fechou, SW reiniciou)

async function noteFailure(db: Db, r: { leadId: string; institution: string; source: string; detail: string | null }) {
  if (r.source !== 'AI') return; // pedido de pessoa: ela vê o motivo na própria tela
  const label = SIM_INSTITUTIONS[r.institution]?.label || r.institution;
  await db.note.create({ data: { leadId: r.leadId, type: 'COMMENT', content: `⚠️ O PDF da simulação do ${label} pedido pela IA NÃO saiu: ${r.detail || 'sem detalhe'}. Mande à mão pela Inbox (a logo A&F só entra sozinha em PDF do Credimorar; nos outros, peça ao suporte).` } }).catch(() => {});
}

async function expireStuck(db: Db, accountId: string) {
  const now = Date.now();
  const expire = async (where: Record<string, unknown>, detail: string) => {
    const rows = await db.simulationDocRequest.findMany({ where: { accountId, ...where } as any });
    for (const r of rows) {
      const done = await db.simulationDocRequest.updateMany({ where: { id: r.id, status: r.status }, data: { status: 'FAILED', finishedAt: new Date(), detail } });
      if (done.count) await noteFailure(db, { ...r, detail });
    }
  };
  await expire({ status: 'REQUESTED', createdAt: { lt: new Date(now - REQUESTED_TTL_MIN * 60_000) } }, 'Nenhuma extensão do banco pegou o pedido (extensão fechada, desligada ou desatualizada).');
  // PDF do assistente (só pra equipe): os bytes saem do banco depois de 3 dias (o disco do Postgres já encheu 2 vezes).
  await db.simulationDocRequest.updateMany({ where: { accountId, status: 'PRIVATE', finishedAt: { lt: new Date(now - 3 * 86_400_000) }, NOT: { pdf: null } }, data: { pdf: null } }).catch(() => {});
  // PDF pronto esperando o aviso que não saiu em 8 min: manda sozinho (nunca fica preso).
  const esquecidos = await db.simulationDocRequest.findMany({ where: { accountId, status: 'READY', updatedAt: { lt: new Date(now - 8 * 60_000) } }, select: { id: true } });
  for (const x of esquecidos) await releaseHeld(db, x.id).catch(() => {});
  await expire({ status: 'RUNNING', startedAt: { lt: new Date(now - RUNNING_TTL_MIN * 60_000) } }, 'A extensão pegou o pedido mas não devolveu os dados (janela fechada ou extensão reiniciada).');
}

export function parseInstitutions(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const v of list) {
    const k = String(v || '').toUpperCase();
    const key = k === 'CREDIMORAR' ? 'SANTANDER' : k; // a extensão do Credimorar é a do Santander
    if (SIM_INSTITUTIONS[key] && !out.includes(key)) out.push(key);
  }
  return out;
}

export async function requestSimulationDocs(db: Db, p: { accountId: string; leadId: string; institutions: string[]; userId?: string; source?: 'USER' | 'AI' | 'ASSISTANT'; caption?: string; /** guarda o PDF pronto (READY) até o aviso de aprovação sair */ hold?: boolean; /** não pede de novo se o mesmo PDF já foi enviado nas últimas N horas (envio automático) */ skipIfSentWithinHours?: number }) {
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true } });
  if (!lead) throw new Error('Card não encontrado');
  await expireStuck(db, p.accountId);
  const created: Array<{ id: string; institution: string }> = [];
  const skipped: string[] = [];
  for (const inst of parseInstitutions(p.institutions)) {
    // PDF do CREDITAS DESATIVADO (Fabio 15/10, João Henrique): ele era montado pela API do SIMULADOR do portal (faixa "a partir de": taxa 1,09% a.m., CET 1,271%) e NÃO tem nada a ver com a
    // proposta aprovada do cliente (juros 1,50% a.m., CET 1,64%, 1ª parcela R$ 4.798,15). Até sair do que a proposta aprovada traz, não gera.
    if (inst === 'CREDITAS') { skipped.push(inst); continue; }
    const open = await db.simulationDocRequest.findFirst({ where: { leadId: p.leadId, institution: inst, status: { in: ['REQUESTED', 'RUNNING'] } }, select: { id: true } });
    if (open) { skipped.push(inst); continue; }
    if (p.skipIfSentWithinHours) {
      const done = await db.simulationDocRequest.findFirst({ where: { leadId: p.leadId, institution: inst, status: 'DONE', finishedAt: { gt: new Date(Date.now() - p.skipIfSentWithinHours * 3_600_000) } }, select: { id: true } });
      if (done) { skipped.push(inst); continue; }
    }
    const row = await db.simulationDocRequest.create({ data: { accountId: p.accountId, leadId: p.leadId, institution: inst, source: p.source || 'USER', requestedById: p.userId || null, caption: p.caption?.trim() || null, hold: !!p.hold } });
    created.push({ id: row.id, institution: inst });
  }
  return { created, skipped };
}

/** A extensão do banco pergunta "tem simulação pra baixar?". Cada pedido é entregue UMA vez (REQUESTED → RUNNING). */
export async function claimSimulationDocs(db: Db, p: { accountId: string; extBank: string; limit?: number }) {
  await expireStuck(db, p.accountId);
  const insts = Object.entries(SIM_INSTITUTIONS).filter(([, v]) => v.extBank === p.extBank).map(([k]) => k);
  if (!insts.length) return [];
  const rows = await db.simulationDocRequest.findMany({ where: { accountId: p.accountId, status: 'REQUESTED', institution: { in: insts } }, orderBy: { createdAt: 'asc' }, take: Math.min(p.limit || 2, 5) });
  const out: Array<{ id: string; leadId: string; leadName: string; institution: string; mode: 'pdf' | 'data'; institutionId: number; proposalNumber: string | null; cpf: string | null }> = [];
  for (const r of rows) {
    const claimed = await db.simulationDocRequest.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { status: 'RUNNING', startedAt: new Date() } });
    if (!claimed.count) continue;
    const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
    const meta = SIM_INSTITUTIONS[r.institution];
    const bankKey = meta.extBank;
    // A proposta APROVADA do banco e o CPF de quem foi aprovado (Fabio 14/10): a extensão acha o cliente por eles, sem adivinhar nem depender da lista.
    const aprovada = await db.creditAnalysis.findFirst({ where: { leadId: r.leadId, bank: bankKey, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] } }, orderBy: [{ chosen: 'desc' }, { createdAt: 'desc' }], select: { proposalNumber: true, holderCpf: true, holderName: true, detail: true, leadId: true, bank: true } });
    const ultima = aprovada || await db.creditAnalysis.findFirst({ where: { leadId: r.leadId, bank: bankKey, proposalNumber: { not: null }, dryRun: false }, orderBy: { createdAt: 'desc' }, select: { proposalNumber: true, holderCpf: true, holderName: true, detail: true, leadId: true, bank: true } });
    const { resolveHolderCpf } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
    const cpf = ultima ? await resolveHolderCpf(db, ultima) : null;
    // Sem análise nenhuma no CRM (proposta só anotada no card): usa o "Nº da proposta" e o CPF do titular do card (Pedro Francisco, 26/10).
    let numero = ultima?.proposalNumber || null;
    let cpfFinal = cpf;
    if (!numero) {
      const lc = await db.lead.findUnique({ where: { id: r.leadId }, select: { customFields: true } });
      const cfl = (lc?.customFields || {}) as Record<string, any>;
      const { propostaDoCard } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
      const pc = propostaDoCard(cfl);
      if (pc && pc.bank === bankKey) { numero = pc.numero; cpfFinal = cpfFinal || String(cfl.cpf_1 || '').replace(/\D/g, '') || null; }
    }
    out.push({ id: r.id, leadId: r.leadId, leadName: lead?.name || 'Sem nome', institution: r.institution, mode: meta.mode, institutionId: meta.credimorarId ?? 0, proposalNumber: numero, cpf: cpfFinal });
  }
  return out;
}

export async function failSimulationDoc(db: Db, p: { accountId: string; id: string; reason: string }) {
  const r = await db.simulationDocRequest.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!r || r.status === 'DONE' || r.status === 'FAILED') return r;
  const updated = await db.simulationDocRequest.update({ where: { id: r.id }, data: { status: 'FAILED', finishedAt: new Date(), detail: p.reason.slice(0, 600) } });
  await noteFailure(db, updated);
  return updated;
}

function slug(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Envia o PDF pronto ao cliente e fecha o pedido (DONE) — ou falha com o motivo. */
async function deliver(db: Db, r: { id: string; accountId: string; leadId: string; institution: string; caption: string | null; requestedById: string | null; hold?: boolean; source?: string }, pdf: Buffer, io?: Io) {
  if ((r as any).source === 'ASSISTANT') { // pedido pelo ASSISTENTE do CRM (Fabio 26/10: "preciso da simulação do cliente X, ele me retorna com o PDF"): fica SÓ pra equipe, nunca vai ao cliente
    await db.simulationDocRequest.update({ where: { id: r.id }, data: { status: 'PRIVATE', pdf, finishedAt: new Date(), detail: 'PDF pronto — só pra equipe (pedido pelo assistente do CRM)' } });
    return { ok: true as const, held: true as const, messageId: undefined as string | undefined };
  }
  if (r.hold) { // aviso de aprovação automático ainda não saiu: guarda o PDF pronto; o aviso manda texto + PDF juntos (releaseHeld)
    await db.simulationDocRequest.update({ where: { id: r.id }, data: { status: 'READY', pdf, detail: 'PDF pronto — vai junto com o aviso de aprovação' } });
    return { ok: true as const, held: true as const, messageId: undefined as string | undefined };
  }
  const label = SIM_INSTITUTIONS[r.institution]?.label || r.institution;
  const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
  const fileName = `AeF_${r.institution}_${slug(lead?.name || 'Cliente') || 'Cliente'}.pdf`;
  const caption = r.caption || `Segue a simulação do ${label} em PDF 📄`;
  const sent = await sendOutboundMedia({ accountId: r.accountId, leadId: r.leadId, buffer: pdf, fileName, mimeType: 'application/pdf', caption, userId: r.requestedById || undefined, io });
  if (!sent.success) {
    await failSimulationDoc(db, { accountId: r.accountId, id: r.id, reason: `Montei o PDF, mas o WhatsApp não aceitou o envio: ${sent.error}` });
    return { ok: false as const, error: sent.error };
  }
  await db.simulationDocRequest.update({ where: { id: r.id }, data: { status: 'DONE', finishedAt: new Date(), messageId: sent.message?.id || null, detail: `Enviado: ${fileName}` } });
  return { ok: true as const, messageId: sent.message?.id as string | undefined };
}

async function loadOpen(db: Db, accountId: string, id: string) {
  const r = await db.simulationDocRequest.findFirst({ where: { id, accountId } });
  if (!r) throw new Error('Pedido não encontrado');
  return r;
}

/** Manda ao cliente o PDF que ficou PRONTO esperando o aviso (READY) e fecha o pedido. */
export async function releaseHeld(db: Db, id: string, io?: Io) {
  const r = await db.simulationDocRequest.findUnique({ where: { id } });
  if (!r || r.status !== 'READY' || !r.pdf) return { ok: false as const, error: 'sem PDF pronto' };
  const claimed = await db.simulationDocRequest.updateMany({ where: { id, status: 'READY' }, data: { status: 'RUNNING', startedAt: new Date() } }); // trava: só um envia
  if (!claimed.count) return { ok: false as const, error: 'já enviado' };
  const out = await deliver(db, { ...r, hold: false }, Buffer.from(r.pdf), io);
  if (out.ok) await db.simulationDocRequest.update({ where: { id }, data: { pdf: null } }).catch(() => {});
  return out;
}

/** O aviso de aprovação automático quer mandar o PDF JUNTO com o texto (Fabio 15/10): 'ready' = PDF pronto (mande o texto e depois releaseHeld); 'waiting' = ainda gerando
 *  (adie o aviso); 'none' = não tem PDF pra esperar (já enviado, falhou ou passou do tempo) — mande o aviso e siga o fluxo normal. */
export async function holdForNotice(db: Db, p: { accountId: string; leadId: string; institution: string; maxWaitMs?: number }): Promise<{ state: 'ready' | 'waiting' | 'none'; requestId?: string }> {
  await expireStuck(db, p.accountId);
  const maxWait = p.maxWaitMs ?? 6 * 60_000;
  const done = await db.simulationDocRequest.findFirst({ where: { leadId: p.leadId, institution: p.institution, status: 'DONE', finishedAt: { gt: new Date(Date.now() - 12 * 3_600_000) } }, select: { id: true } });
  if (done) return { state: 'none' };
  const ready = await db.simulationDocRequest.findFirst({ where: { leadId: p.leadId, institution: p.institution, status: 'READY' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (ready) return { state: 'ready', requestId: ready.id };
  const open = await db.simulationDocRequest.findFirst({ where: { leadId: p.leadId, institution: p.institution, status: { in: ['REQUESTED', 'RUNNING'] } }, orderBy: { createdAt: 'desc' } });
  if (open) {
    if (Date.now() - open.createdAt.getTime() > maxWait) { // demorou demais: solta (o PDF sai sozinho quando chegar) e o aviso vai sem ele
      if (open.hold) await db.simulationDocRequest.update({ where: { id: open.id }, data: { hold: false } }).catch(() => {});
      return { state: 'none' };
    }
    if (!open.hold) await db.simulationDocRequest.update({ where: { id: open.id }, data: { hold: true } }).catch(() => {});
    return { state: 'waiting', requestId: open.id };
  }
  const failed = await db.simulationDocRequest.findFirst({ where: { leadId: p.leadId, institution: p.institution, status: 'FAILED', createdAt: { gt: new Date(Date.now() - maxWait) } }, select: { id: true } });
  if (failed) return { state: 'none' };
  const r = await requestSimulationDocs(db, { accountId: p.accountId, leadId: p.leadId, institutions: [p.institution], source: 'AI', hold: true });
  return r.created.length ? { state: 'waiting', requestId: r.created[0].id } : { state: 'none' };
}

/** SANTANDER: a extensão devolveu o PDF ORIGINAL do portal do Credimorar — troca cor/logo e manda. */
/** Taxa NOMINAL anual do Santander (o PDF do portal só traz a efetiva): vem das condições da análise aprovada com o mesmo valor (± 1%). null = calcula pela efetiva. */
async function nominalDoSantander(db: Db, leadId: string, valor: number): Promise<number | null> {
  const rows = await db.creditAnalysis.findMany({ where: { leadId, bank: 'CREDIMORAR', dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] } }, orderBy: { createdAt: 'desc' }, take: 10, select: { approvedValue: true, detail: true, conditions: true } });
  const certa = rows.find((a) => a.approvedValue && valor && Math.abs(a.approvedValue - valor) / valor <= 0.01) || null;
  const m = certa ? /taxa nominal\s*([\d.]+,\d{1,2})\s*%\s*a\.a/i.exec(`${certa.conditions || ''} ${certa.detail || ''}`.replace(/\s+/g, ' ')) : null;
  return m ? Number(m[1].replace(/\./g, '').replace(',', '.')) : null;
}

export async function finishSimulationDoc(db: Db, p: { accountId: string; id: string; pdf: Buffer; io?: Io }) {
  const r = await loadOpen(db, p.accountId, p.id);
  if (r.status === 'DONE') return { ok: true as const, already: true, messageId: r.messageId };
  const fail = async (reason: string) => { await failSimulationDoc(db, { accountId: p.accountId, id: r.id, reason }); return { ok: false as const, error: reason }; };
  // PADRÃO DA SIMULAÇÃO (Fabio 26/10): o "Evolução das parcelas" do portal Credimorar (Santander) é LIDO e redesenhado no mesmo modelo do Inter e da Creditas —
  // 8 campos (tipo, prazo, sistema, valor do imóvel, valor do empréstimo, taxa mensal/nominal/efetiva), sem CET, CESH, renda e entrada.
  if (looksLikePortalPdf(p.pdf)) {
    let pdf: Buffer;
    try {
      const d = await parsePortalSheetPdf(p.pdf);
      const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
      pdf = await renderSimulationSheet({
        clientName: lead?.name || 'Cliente',
        when: d.when || undefined,
        bank: 'SANTANDER',
        summary: { tipoImovel: d.tipoImovel, prazoMeses: d.prazoMeses, sistema: d.sistema, valorImovel: d.valorImovel, valorEmprestimo: d.valorEmprestimo, ...taxasDe({ nominalAA: await nominalDoSantander(db, r.leadId, d.valorEmprestimo), efetivaAA: d.efetivaAA }) },
        rows: d.rows,
      });
    } catch (e: any) { return fail(`Não consegui ler a simulação do Santander pra montar o PDF no padrão A&F (${e?.message || 'erro'}). Não enviei.`); }
    return deliver(db, r, pdf, p.io);
  }
  let branded;
  try { branded = await brandSimulationPdf(p.pdf); } catch (e: any) { return fail(`Não consegui pôr a logo A&F no PDF (${e?.message || 'erro'}). Não enviei.`); }
  if (!branded.recognized) return fail('O PDF baixado não está no modelo conhecido do portal (ou já veio sem a logo do portal). Não enviei, pra não sair com a marca errada — avise o suporte.');
  return deliver(db, r, branded.pdf, p.io);
}

// ── Inter: dados do portal → modelo do Credimorar ────────────────────────────────────────────────
export interface InterProposalData {
  financiamentoAprovado?: Record<string, any>;
  dadosImovel?: Record<string, any>;
  rendas?: number[];
}

const num = (v: unknown): number => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };

/** O "Saldo devedor" do PDF do Inter às vezes vem zerado/fora de ordem; nesse caso refaz: saldo = soma das amortizações que faltam. */
export function repairBalances(rows: InterTheory['rows']): { saldos: number[]; refeito: boolean } {
  const printed = rows.map((r) => r.saldo);
  const ok = printed.every((v, i) => (i === 0 || v <= printed[i - 1] + 0.01) && (i === printed.length - 1 || v > 0));
  if (ok) return { saldos: printed, refeito: false };
  const saldos: number[] = [];
  let resta = rows.reduce((s, r) => s + r.amort, 0);
  for (const r of rows) { resta = Math.max(0, +(resta - r.amort).toFixed(2)); saldos.push(resta); }
  return { saldos, refeito: true };
}

export function sheetFromInter(p: { clientName: string; proposal: InterProposalData; theory: InterTheory; when?: Date }): SimulationSheet {
  const f = p.proposal.financiamentoAprovado || {};
  const { saldos } = repairBalances(p.theory.rows);
  const produto = String(f.produtoAprovado || p.theory.header['Tipo da operação'] || '');
  const sistema = String(f.sistemaAmortizacao || '').toUpperCase() === 'SAC' || /SAC/i.test(p.theory.header['Sistema de amortização'] || '') ? 'SAC' : 'PRICE';
  const imovel = num(f.valorImovel) || num(String(p.theory.header['Valor estimado do imóvel'] || '').replace(/[^\d,]/g, '').replace(',', '.'));
  // O valor da simulação é o APROVADO (Roseli 14/10: Inter aprovou R$ 90 mil de R$ 150 mil pedidos e o PDF saiu com 150 mil). O cabeçalho "Valor solicitado"
  // do Evolução Teórica já traz o aprovado; `valorFinanciamento` da proposta é o PEDIDO, então só vale se nada mais existir.
  const emprestimo = num(String(p.theory.header['Valor solicitado'] || '').replace(/[^\d,]/g, '').replace(',', '.')) || num(f.valorAprovado) || num(f.valorFinanciamento);
  const rows: SheetRow[] = p.theory.rows.map((r, i) => ({ n: r.n, amort: r.amort, juros: r.juros, mip: r.seguros, dfi: 0, tsa: r.tarifas, parcela: r.prestacao, saldo: saldos[i] }));
  return {
    clientName: p.clientName,
    when: p.when,
    bank: 'INTER',
    segurosJuntos: true, // o Inter só informa o total dos seguros (MIP + DFI)
    summary: {
      tipoImovel: /COMERCIAL/i.test(produto) ? 'Comercial' : 'Residencial',
      prazoMeses: num(f.prazoEmprestimo) || rows.length,
      sistema,
      valorImovel: imovel,
      valorEmprestimo: emprestimo,
      // Padrão 26/10: mensal (o "taxaJuros" do Inter, ex.: "1.40% a.m. + IPCA"), nominal (× 12) e efetiva (a do portal) — todas com + IPCA.
      ...taxasDe({
        mensal: /a\.?\s*m/i.test(String(f.taxaJuros || '')) ? num(String(f.taxaJuros).replace(/[^\d.,]/g, '').replace(',', '.')) || null : null,
        efetivaAA: num(String(f.jurosAnualEfetivo || p.theory.header['Taxa efetiva anual de juros'] || '').replace(/[^\d.,]/g, '').replace(',', '.')) || null,
        indexador: String(f.indexador || 'IPCA').toUpperCase(),
      }),
    },
    rows,
  };
}

/** INTER: a extensão leu a proposta + baixou o "Evolução Teórica" do portal; o CRM lê a tabela e desenha no modelo do Credimorar. */
export async function finishInterDoc(db: Db, p: { accountId: string; id: string; proposal: InterProposalData; pdf: Buffer; io?: Io }) {
  const r = await loadOpen(db, p.accountId, p.id);
  if (r.status === 'DONE') return { ok: true as const, already: true, messageId: r.messageId };
  const fail = async (reason: string) => { await failSimulationDoc(db, { accountId: p.accountId, id: r.id, reason }); return { ok: false as const, error: reason }; };
  let theory: InterTheory;
  try { theory = await parseInterTheoryPdf(p.pdf); } catch (e: any) { return fail(`Não consegui ler a tabela do Evolução Teórica do Inter (${e?.message || 'erro'}). Não enviei.`); }
  // A evolução do Inter só sai com os valores certos DEPOIS que a proposta é aceita (Fabio 14/10): antes, ela ainda traz o valor PEDIDO. Se o aprovado é
  // outro, não manda — um PDF com valor diferente do aprovado é pior que PDF nenhum.
  const aprovado = num((p.proposal.financiamentoAprovado || {}).valorAprovado);
  const naTabela = num(String(theory.header['Valor solicitado'] || '').replace(/[^\d,]/g, '').replace(',', '.'));
  if (aprovado && naTabela && Math.abs(aprovado - naTabela) / aprovado > 0.01) {
    return fail(`A evolução do Inter ainda mostra R$ ${naTabela.toLocaleString('pt-BR')} (o valor pedido), mas o aprovado é R$ ${aprovado.toLocaleString('pt-BR')}: aceite a proposta no Inter (Seguir com proposta → Aprovar) pra a evolução sair com os valores certos e peça o PDF de novo. Não enviei.`);
  }
  const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
  let pdf: Buffer;
  try { pdf = await renderSimulationSheet(sheetFromInter({ clientName: lead?.name || 'Cliente', proposal: p.proposal, theory })); } catch (e: any) { return fail(`Não consegui montar o PDF (${e?.message || 'erro'}). Não enviei.`); }
  return deliver(db, r, pdf, p.io);
}


// ── Creditas: dados da API do portal → modelo do Credimorar ──────────────────────────────────────
// A API da Creditas devolve duas faixas (min = "a partir de", max = pior caso). O PDF próprio da Creditas usa a faixa MÍNIMA
// (1ª parcela, última parcela e total batem com o "Valor da parcela" que o portal mostra), então usamos a mínima também.
export interface CreditasData {
  input: { valorImovel: number; valorEmprestimo: number; renda: number; uf?: string; tipoImovel?: string };
  summary: Record<string, any>; // item do GET /b2b/simulations pro prazo escolhido
  installments: Array<Record<string, any>>; // GET /b2b/simulations/installments
}


export function sheetFromCreditas(p: { clientName: string; data: CreditasData; when?: Date }): SimulationSheet {
  const { input, summary, installments } = p.data;
  const min = (o: any) => num(o?.min);
  const rows: SheetRow[] = installments.map((i) => ({
    n: Number(i.period), amort: min(i.amortization), juros: min(i.interest), mip: min(i.mipInsurance), dfi: min(i.dfiInsurance),
    tsa: min(i.creditManagementFee), parcela: min(i.payment), saldo: min(i.outstanding),
  }));
  const taxa = summary?.interestRate?.min?.monthly;
  return {
    clientName: p.clientName,
    when: p.when,
    bank: 'CREDITAS',
    summary: {
      tipoImovel: input.tipoImovel || '—',
      prazoMeses: num(summary?.term) || rows.length,
      sistema: 'PRICE',
      valorImovel: num(input.valorImovel),
      valorEmprestimo: num(input.valorEmprestimo),
      // Padrão 26/10: a Creditas informa a taxa MENSAL (antes saía com o rótulo "Taxa Efetiva"); nominal = × 12, efetiva = acumulada — todas com + IPCA.
      ...taxasDe({ mensal: taxa != null ? num(taxa) * 100 : null, indexador: 'IPCA' }),
    },
    rows,
  };
}

/** CREDITAS: a extensão leu a simulação pela API do portal; o CRM confere os números e desenha o PDF no modelo do Credimorar. */
export async function finishCreditasDoc(db: Db, p: { accountId: string; id: string; data: CreditasData; io?: Io }) {
  const r = await loadOpen(db, p.accountId, p.id);
  if (r.status !== 'DONE') { await failSimulationDoc(db, { accountId: p.accountId, id: r.id, reason: 'PDF do Creditas desativado: o simulador do portal não traz as condições da proposta aprovada. Não enviei.' }); return { ok: false as const, error: 'PDF do Creditas desativado (não bate com a proposta aprovada).' }; }
  if (r.status === 'DONE') return { ok: true as const, already: true, messageId: r.messageId };
  const fail = async (reason: string) => { await failSimulationDoc(db, { accountId: p.accountId, id: r.id, reason }); return { ok: false as const, error: reason }; };
  const inst = Array.isArray(p.data?.installments) ? p.data.installments : [];
  if (!inst.length || !p.data?.summary || !p.data?.input) return fail('Os dados da Creditas vieram incompletos. Não enviei.');
  // Conferência de sanidade: o saldo final tem que ser ~0 e a soma das amortizações ~ o primeiro saldo + a 1ª amortização.
  const last = inst[inst.length - 1];
  if (Math.abs(num(last?.outstanding?.min)) > 1) return fail(`Os dados da Creditas não fecham (saldo final ${num(last?.outstanding?.min).toFixed(2)}). Não enviei.`);
  const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
  let pdf: Buffer;
  try { pdf = await renderSimulationSheet(sheetFromCreditas({ clientName: lead?.name || 'Cliente', data: p.data })); } catch (e: any) { return fail(`Não consegui montar o PDF (${e?.message || 'erro'}). Não enviei.`); }
  return deliver(db, r, pdf, p.io);
}

export async function listSimulationDocs(db: Db, p: { accountId: string; leadId: string }) {
  await expireStuck(db, p.accountId);
  return db.simulationDocRequest.findMany({ where: { accountId: p.accountId, leadId: p.leadId }, orderBy: { createdAt: 'desc' }, take: 10 });
}

export { brl };
