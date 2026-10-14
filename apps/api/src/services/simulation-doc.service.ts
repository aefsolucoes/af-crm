import { PrismaClient } from '@prisma/client';
import { sendOutboundMedia } from './message.service';
import { brandSimulationPdf, parseInterTheoryPdf, InterTheory } from './simulation-pdf.service';
import { renderSimulationSheet, brl, SimulationSheet, SheetRow } from './simulation-sheet.service';

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

export async function requestSimulationDocs(db: Db, p: { accountId: string; leadId: string; institutions: string[]; userId?: string; source?: 'USER' | 'AI'; caption?: string }) {
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true } });
  if (!lead) throw new Error('Card não encontrado');
  await expireStuck(db, p.accountId);
  const created: Array<{ id: string; institution: string }> = [];
  const skipped: string[] = [];
  for (const inst of parseInstitutions(p.institutions)) {
    const open = await db.simulationDocRequest.findFirst({ where: { leadId: p.leadId, institution: inst, status: { in: ['REQUESTED', 'RUNNING'] } }, select: { id: true } });
    if (open) { skipped.push(inst); continue; }
    const row = await db.simulationDocRequest.create({ data: { accountId: p.accountId, leadId: p.leadId, institution: inst, source: p.source || 'USER', requestedById: p.userId || null, caption: p.caption?.trim() || null } });
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
  const out: Array<{ id: string; leadId: string; leadName: string; institution: string; mode: 'pdf' | 'data'; institutionId: number; proposalNumber: string | null }> = [];
  for (const r of rows) {
    const claimed = await db.simulationDocRequest.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { status: 'RUNNING', startedAt: new Date() } });
    if (!claimed.count) continue;
    const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
    const meta = SIM_INSTITUTIONS[r.institution];
    const bankKey = meta.extBank;
    // Número da proposta do banco (a extensão acha o cliente por ele, sem depender da lista): última análise com número.
    const last = bankKey === 'CREDIMORAR' ? null : await db.creditAnalysis.findFirst({ where: { leadId: r.leadId, bank: bankKey, proposalNumber: { not: null }, dryRun: false }, orderBy: { createdAt: 'desc' }, select: { proposalNumber: true } });
    out.push({ id: r.id, leadId: r.leadId, leadName: lead?.name || 'Sem nome', institution: r.institution, mode: meta.mode, institutionId: meta.credimorarId ?? 0, proposalNumber: last?.proposalNumber || null });
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
async function deliver(db: Db, r: { id: string; accountId: string; leadId: string; institution: string; caption: string | null; requestedById: string | null }, pdf: Buffer, io?: Io) {
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

/** SANTANDER: a extensão devolveu o PDF ORIGINAL do portal do Credimorar — troca cor/logo e manda. */
export async function finishSimulationDoc(db: Db, p: { accountId: string; id: string; pdf: Buffer; io?: Io }) {
  const r = await loadOpen(db, p.accountId, p.id);
  if (r.status === 'DONE') return { ok: true as const, already: true, messageId: r.messageId };
  const fail = async (reason: string) => { await failSimulationDoc(db, { accountId: p.accountId, id: r.id, reason }); return { ok: false as const, error: reason }; };
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
const pct = (v: unknown, suffix = ''): string => `${num(v).toFixed(2).replace('.', ',')}%${suffix}`;

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
  const emprestimo = num(f.valorFinanciamento) || num(String(p.theory.header['Valor solicitado'] || '').replace(/[^\d,]/g, '').replace(',', '.'));
  const rows: SheetRow[] = p.theory.rows.map((r, i) => ({ n: r.n, amort: r.amort, juros: r.juros, mip: r.seguros, dfi: 0, tsa: r.tarifas, parcela: r.prestacao, saldo: saldos[i] }));
  return {
    clientName: p.clientName,
    when: p.when,
    bank: 'INTER',
    segurosJuntos: true, // o Inter só informa o total dos seguros (MIP + DFI)
    summary: {
      tipoImovel: /COMERCIAL/i.test(produto) ? 'Comercial' : 'Residencial',
      prazoMeses: num(f.prazoEmprestimo) || rows.length,
      cet: pct(f.cet),
      cesh: pct(f.cesh, ' a.a'),
      sistema,
      valorImovel: imovel,
      taxaEfetiva: `${pct(f.jurosAnualEfetivo || String(p.theory.header['Taxa efetiva anual de juros'] || '').replace(/[^\d.]/g, ''))} a.a`.replace('%%', '%'),
      valorEmprestimo: emprestimo,
      valorEntrada: f.valorEntrada != null ? num(f.valorEntrada) : Math.max(imovel - emprestimo, 0),
      renda: (p.proposal.rendas || []).reduce((s, v) => s + num(v), 0),
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

const pct3 = (frac: unknown): string => `${(num(frac) * 100).toFixed(3).replace('.', ',')}%`;

export function sheetFromCreditas(p: { clientName: string; data: CreditasData; when?: Date }): SimulationSheet {
  const { input, summary, installments } = p.data;
  const min = (o: any) => num(o?.min);
  const rows: SheetRow[] = installments.map((i) => ({
    n: Number(i.period), amort: min(i.amortization), juros: min(i.interest), mip: min(i.mipInsurance), dfi: min(i.dfiInsurance),
    tsa: min(i.creditManagementFee), parcela: min(i.payment), saldo: min(i.outstanding),
  }));
  const taxa = summary?.interestRate?.min?.monthly;
  const cet = summary?.cet?.min?.monthly;
  return {
    clientName: p.clientName,
    when: p.when,
    bank: 'CREDITAS',
    summary: {
      tipoImovel: input.tipoImovel || '—',
      prazoMeses: num(summary?.term) || rows.length,
      cet: cet != null ? `${pct3(cet)} a.m. + IPCA` : '—',
      cesh: '—', // a Creditas não informa o CESH
      sistema: 'PRICE',
      valorImovel: num(input.valorImovel),
      taxaEfetiva: taxa != null ? `${(num(taxa) * 100).toFixed(2).replace('.', ',')}% a.m. + IPCA` : '—',
      valorEmprestimo: num(input.valorEmprestimo),
      valorEntrada: Math.max(num(input.valorImovel) - num(input.valorEmprestimo), 0),
      renda: num(input.renda),
    },
    rows,
  };
}

/** CREDITAS: a extensão leu a simulação pela API do portal; o CRM confere os números e desenha o PDF no modelo do Credimorar. */
export async function finishCreditasDoc(db: Db, p: { accountId: string; id: string; data: CreditasData; io?: Io }) {
  const r = await loadOpen(db, p.accountId, p.id);
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
