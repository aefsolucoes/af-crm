import type { PrismaClient, Prisma } from '@prisma/client';

/**
 * Aba "Análise de Crédito" (Fabio 14/10). As extensões do Chrome dele (Inter,
 * Creditas, Credimorar/Santander) rodam a análise nos portais dos bancos;
 * aqui o CRM guarda o retorno, mostra numa aba, dispara novas análises (fila
 * que a extensão busca) e registra a proposta ESCOLHIDA pra cada cliente —
 * escolha manual por enquanto. Cada função recebe `db` (cliente do Prisma ou
 * transação) pra poder ser testada dentro de uma transação desfeita no final.
 *
 * Uma linha por execução (lead × banco):
 *   REQUESTED (pedida pelo CRM) → RUNNING (extensão pegou) → SENT (enviada, resultado ainda
 *   não lido) → APPROVED | REJECTED | FAILED | CHECK (conferir no portal) | INCOMPLETE | TEST.
 * A extensão só manda status + texto (+ número da proposta/valor quando consegue ler); os
 * números completos de aprovação (valor aprovado, taxa, prazo, parcelas) vêm do formulário
 * de resultado da aba ou da skill do Fabio.
 */

type Db = PrismaClient | Prisma.TransactionClient;
export const BANKS: Record<string, { label: string; instituicao: string }> = {
  INTER: { label: 'Banco Inter', instituicao: 'Inter' },
  CREDITAS: { label: 'Creditas', instituicao: 'Creditas' },
  CREDIMORAR: { label: 'Santander (Credimorar)', instituicao: 'Santander' },
};
export const BANK_KEYS = Object.keys(BANKS);

/** Status em português que as extensões já usam (recordHistory) → status do CRM. */
export const EXTENSION_STATUS: Record<string, string> = {
  enviando: 'RUNNING', enviado: 'SENT', aprovado: 'APPROVED', rejeitado: 'REJECTED',
  falhou: 'FAILED', verificar: 'CHECK', incompleto: 'INCOMPLETE', teste: 'TEST',
};
const ALL_STATUS = new Set(['REQUESTED', 'RUNNING', 'SENT', 'APPROVED', 'REJECTED', 'FAILED', 'CHECK', 'INCOMPLETE', 'TEST']);
const FINAL = new Set(['APPROVED', 'REJECTED', 'FAILED', 'CHECK', 'INCOMPLETE', 'TEST']);
const ACTIVE = ['REQUESTED', 'RUNNING'];
const STALE_ACTIVE_MS = 25 * 60 * 1000; // pedido/execução parado há mais que isso não bloqueia um novo
const STUCK_RUNNING_MS = 30 * 60 * 1000; // rodando há mais que isso sem sinal da extensão = parou
const REPORT_REUSE_MS = 12 * 60 * 60 * 1000; // relatório da extensão continua a execução aberta das últimas 12 h

export interface ResultFields {
  proposalNumber?: string | null;
  approvedValue?: number | null;
  termMonths?: number | null;
  rate?: string | null;
  indexer?: string | null;
  firstInstallment?: number | null;
  lastInstallment?: number | null;
  conditions?: string | null;
}
const RESULT_KEYS: (keyof ResultFields)[] = ['proposalNumber', 'approvedValue', 'termMonths', 'rate', 'indexer', 'firstInstallment', 'lastInstallment', 'conditions'];

const brl = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

function pickResult(input: Record<string, any>): ResultFields {
  const out: ResultFields = {};
  const num = (v: any) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };
  if ('proposalNumber' in input) out.proposalNumber = input.proposalNumber ? String(input.proposalNumber).slice(0, 40) : null;
  if ('approvedValue' in input) out.approvedValue = num(input.approvedValue);
  if ('termMonths' in input) { const t = num(input.termMonths); out.termMonths = t ? Math.round(t) : null; }
  if ('rate' in input) out.rate = input.rate ? String(input.rate).slice(0, 120) : null;
  if ('indexer' in input) out.indexer = input.indexer ? String(input.indexer).slice(0, 40) : null;
  if ('firstInstallment' in input) out.firstInstallment = num(input.firstInstallment);
  if ('lastInstallment' in input) out.lastInstallment = num(input.lastInstallment);
  if ('conditions' in input) out.conditions = input.conditions ? String(input.conditions).slice(0, 2000) : null;
  return out;
}

/** Nota automática no card quando a análise termina aprovada/reprovada. O formato de
 *  aprovada tem "aprovad…" e "R$ …" de propósito: approval-notice.service lê notas assim
 *  pra montar o texto "✅ Crédito aprovado! Resumo da proposta". */
export function analysisNote(a: { bank: string; status: string; detail?: string | null; dryRun?: boolean } & ResultFields): string {
  const label = BANKS[a.bank]?.label || a.bank;
  const test = a.dryRun ? ' [modo teste]' : '';
  if (a.status === 'APPROVED') {
    const parts = [
      `Banco: ${label}`,
      a.approvedValue ? `Valor aprovado: ${brl(a.approvedValue)}` : '',
      a.termMonths ? `Prazo: ${a.termMonths} meses` : '',
      a.rate ? `Taxa: ${a.rate}${a.indexer && !new RegExp(a.indexer, 'i').test(a.rate) ? ` + ${a.indexer}` : ''}` : (a.indexer ? `Indexador: ${a.indexer}` : ''),
      a.firstInstallment ? `1ª parcela: ${brl(a.firstInstallment)}` : '',
      a.lastInstallment ? `Última parcela: ${brl(a.lastInstallment)}` : '',
      a.proposalNumber ? `Proposta nº ${a.proposalNumber}` : '',
    ].filter(Boolean);
    return `✅ Análise de crédito${test} — APROVADO no ${label}. ${parts.join(' · ')}${a.conditions ? `\nCondições: ${a.conditions}` : ''}${a.detail && !a.approvedValue ? `\n${a.detail}` : ''}`;
  }
  return `❌ Análise de crédito${test} — REPROVADO no ${label}${a.proposalNumber ? ` (proposta nº ${a.proposalNumber})` : ''}.${a.detail ? ` ${a.detail}` : ''}`;
}

/** Pede a análise de N clientes em N bancos. A extensão busca os pedidos (claimQueue). */
export async function createRequests(db: Db, p: { accountId: string; userId?: string; leadIds: string[]; banks: string[]; dryRun: boolean }) {
  const banks = p.banks.filter((b) => BANK_KEYS.includes(b));
  const leads = await db.lead.findMany({ where: { id: { in: p.leadIds }, accountId: p.accountId }, select: { id: true } });
  let created = 0, skipped = 0;
  for (const l of leads) {
    for (const bank of banks) {
      const open = await db.creditAnalysis.findFirst({
        where: { leadId: l.id, bank, status: { in: ACTIVE }, updatedAt: { gt: new Date(Date.now() - STALE_ACTIVE_MS) } },
        select: { id: true },
      });
      if (open) { skipped++; continue; }
      await db.creditAnalysis.create({ data: { accountId: p.accountId, leadId: l.id, bank, status: 'REQUESTED', dryRun: p.dryRun, source: 'EXTENSION', requestedById: p.userId || null } });
      created++;
    }
  }
  return { created, skipped, banks, leads: leads.length };
}

/** A extensão do banco pergunta: "tem pedido pra mim?". Marca como RUNNING o que entregar. */
export async function claimQueue(db: Db, p: { accountId: string; bank: string; limit?: number }) {
  if (!BANK_KEYS.includes(p.bank)) return [];
  const rows = await db.creditAnalysis.findMany({
    where: { accountId: p.accountId, bank: p.bank, status: 'REQUESTED' },
    orderBy: { requestedAt: 'asc' }, take: p.limit || 3,
    select: { id: true, leadId: true, dryRun: true, requestedAt: true, lead: { select: { name: true } } },
  });
  const claimed: typeof rows = [];
  for (const r of rows) {
    const u = await db.creditAnalysis.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { status: 'RUNNING', startedAt: new Date() } });
    if (u.count === 1) claimed.push(r);
  }
  return claimed.map((r) => ({ id: r.id, leadId: r.leadId, leadName: r.lead?.name || '', dryRun: r.dryRun, requestedAt: r.requestedAt }));
}

async function applyUpdate(db: Db, row: { id: string; accountId: string; leadId: string; bank: string; status: string; dryRun: boolean }, data: { status?: string; detail?: string | null } & ResultFields) {
  const next = data.status && ALL_STATUS.has(data.status) ? data.status : row.status;
  const becameFinal = FINAL.has(next) && !FINAL.has(row.status);
  const updated = await db.creditAnalysis.update({
    where: { id: row.id },
    data: {
      ...(data.status && ALL_STATUS.has(data.status) ? { status: next } : {}),
      ...(data.detail !== undefined ? { detail: data.detail ? String(data.detail).slice(0, 4000) : null } : {}),
      ...Object.fromEntries(RESULT_KEYS.filter((k) => k in data).map((k) => [k, (data as any)[k]])),
      ...(next === 'RUNNING' ? { startedAt: undefined } : {}),
      ...(becameFinal ? { finishedAt: new Date() } : {}),
    },
  });
  // Nota automática só na primeira vez que vira aprovada/reprovada (modo teste não escreve no card).
  if (becameFinal && !updated.dryRun && (next === 'APPROVED' || next === 'REJECTED')) {
    await db.note.create({ data: { leadId: row.leadId, type: 'COMMENT', content: analysisNote({ ...updated, status: next }) } });
  }
  return { row: updated, becameFinal };
}

/** Relato da extensão: status (já em inglês do CRM) + texto + números que ela conseguir ler. */
export async function reportAnalysis(db: Db, p: { accountId: string; requestId?: string; leadId: string; bank: string; status: string; detail?: string; result?: Record<string, any> }) {
  if (!BANK_KEYS.includes(p.bank)) throw new Error('banco desconhecido');
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true } });
  if (!lead) throw new Error('card não encontrado');
  let row = p.requestId ? await db.creditAnalysis.findFirst({ where: { id: p.requestId, accountId: p.accountId, leadId: p.leadId } }) : null;
  if (!row) {
    // Sem pedido: continua a execução aberta mais recente desse cliente neste banco (as extensões
    // também rodam sozinhas nos cards novos da Pré-Análise); senão cria uma.
    row = await db.creditAnalysis.findFirst({
      where: { accountId: p.accountId, leadId: p.leadId, bank: p.bank, status: { in: ['REQUESTED', 'RUNNING', 'SENT'] }, updatedAt: { gt: new Date(Date.now() - REPORT_REUSE_MS) } },
      orderBy: { createdAt: 'desc' },
    });
  }
  if (!row) {
    row = await db.creditAnalysis.create({ data: { accountId: p.accountId, leadId: p.leadId, bank: p.bank, status: 'RUNNING', source: 'EXTENSION', startedAt: new Date(), dryRun: p.status === 'TEST' } });
  }
  // Relato atrasado (ex.: um "passo" que chegou depois do resultado) não pode desfazer um resultado final.
  if (FINAL.has(row.status) && !FINAL.has(p.status)) return row;
  const { row: updated } = await applyUpdate(db, row, { status: p.status, detail: p.detail ?? null, ...pickResult(p.result || {}) });
  return updated;
}

/** Edição à mão (formulário "Registrar resultado" da aba): muda status e/ou os números. */
export async function updateAnalysis(db: Db, p: { accountId: string; id: string; patch: Record<string, any> }) {
  const row = await db.creditAnalysis.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!row) throw new Error('análise não encontrada');
  const { row: updated } = await applyUpdate(db, row, {
    ...(p.patch.status ? { status: String(p.patch.status) } : {}),
    ...('detail' in p.patch ? { detail: p.patch.detail } : {}),
    ...pickResult(p.patch),
  });
  return updated;
}

/** Registra à mão uma análise (ex.: o Inter que o Fabio/skill leu no portal). */
export async function registerManual(db: Db, p: { accountId: string; userId?: string; leadId: string; bank: string; status: string; detail?: string; result?: Record<string, any> }) {
  if (!BANK_KEYS.includes(p.bank)) throw new Error('banco desconhecido');
  if (!ALL_STATUS.has(p.status)) throw new Error('status inválido');
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true } });
  if (!lead) throw new Error('card não encontrado');
  const row = await db.creditAnalysis.create({
    data: { accountId: p.accountId, leadId: p.leadId, bank: p.bank, status: 'RUNNING', source: 'MANUAL', requestedById: p.userId || null, startedAt: new Date() },
  });
  const { row: updated } = await applyUpdate(db, row, { status: p.status, detail: p.detail ?? null, ...pickResult(p.result || {}) });
  return updated;
}

/** Escolhe a proposta do cliente (manual): marca como escolhida e preenche a aba Financiamento do card. */
export async function chooseAnalysis(db: Db, p: { accountId: string; id: string; userName?: string }) {
  const row = await db.creditAnalysis.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!row) throw new Error('análise não encontrada');
  if (row.status !== 'APPROVED') throw new Error('só dá pra escolher uma proposta aprovada');
  const lead = await db.lead.findUnique({ where: { id: row.leadId }, select: { id: true, value: true, customFields: true } });
  if (!lead) throw new Error('card não encontrado');
  await db.creditAnalysis.updateMany({ where: { leadId: row.leadId, chosen: true }, data: { chosen: false } });
  await db.creditAnalysis.update({ where: { id: row.id }, data: { chosen: true } });

  const cf = { ...((lead.customFields || {}) as Record<string, any>) };
  const before = { valor: cf.valor_credito, instituicao: cf.instituicao };
  const b = BANKS[row.bank];
  const fill: Record<string, any> = { instituicao: b?.instituicao || row.bank };
  if (row.proposalNumber) fill.num_proposta = row.proposalNumber;
  if (row.termMonths) fill.prazo_financ = `${row.termMonths} meses`;
  if (row.rate) fill.taxa_efetiva = row.rate;
  if (row.indexer) fill.indexador = row.indexer;
  if (row.firstInstallment) fill.primeira_parcela = String(row.firstInstallment);
  if (row.lastInstallment) fill.ultima_parcela = String(row.lastInstallment);
  if (row.approvedValue) {
    fill.valor_credito = String(row.approvedValue);
    if (before.valor && Number(before.valor) !== row.approvedValue) fill._valorPedido = before.valor; // guarda o que o cliente pediu
  }
  await db.lead.update({
    where: { id: lead.id },
    data: { customFields: { ...cf, ...fill } as any, ...(row.approvedValue ? { value: row.approvedValue } : {}) },
  });
  const campos = Object.keys(fill).filter((k) => !k.startsWith('_')).join(', ');
  await db.note.create({
    data: {
      leadId: lead.id, type: 'COMMENT',
      content: `⭐ Proposta escolhida: ${b?.label || row.bank}${row.approvedValue ? ` — ${brl(row.approvedValue)}` : ''}${p.userName ? ` (por ${p.userName})` : ''}. A aba Financiamento do card foi preenchida com ela (${campos}).${before.valor && row.approvedValue && Number(before.valor) !== row.approvedValue ? ` Valor pedido antes: ${brl(Number(before.valor))}.` : ''}`,
    },
  });
  return { ok: true, filled: Object.keys(fill).filter((k) => !k.startsWith('_')) };
}

/** Quadro da aba: clientes do Home Equity em Pré-Análise (e quem teve análise nas últimas 3 semanas) × bancos. */
export async function board(db: Db, p: { accountId: string; scopeDepartmentIds: string[] }) {
  // Execução que ficou "rodando" sem a extensão dar sinal (Chrome fechado, janela fechada) vira "falhou".
  await db.creditAnalysis.updateMany({
    where: { accountId: p.accountId, status: 'RUNNING', updatedAt: { lt: new Date(Date.now() - STUCK_RUNNING_MS) } },
    data: { status: 'FAILED', finishedAt: new Date(), detail: 'A extensão parou no meio (Chrome ou janela do banco fechada). Peça de novo.' },
  });
  const since = new Date(Date.now() - 21 * 86_400_000);
  const recent = await db.creditAnalysis.findMany({ where: { accountId: p.accountId, createdAt: { gte: since } }, select: { leadId: true } });
  const recentIds = Array.from(new Set(recent.map((r) => r.leadId)));
  const deptScope = p.scopeDepartmentIds.length ? { OR: [{ departmentId: { in: p.scopeDepartmentIds } }, { departmentId: null }] } : {};
  const leads = await db.lead.findMany({
    where: {
      accountId: p.accountId, archived: false, isGroup: false,
      pipeline: { AND: [deptScope, { department: { name: { contains: 'Home Equity', mode: 'insensitive' } } }] },
      OR: [{ status: 'OPEN', stage: { name: { startsWith: 'Pré-An', mode: 'insensitive' } } }, ...(recentIds.length ? [{ id: { in: recentIds } }] : [])],
    },
    select: {
      id: true, name: true, value: true, status: true, customFields: true,
      stage: { select: { name: true } }, pipeline: { select: { name: true } },
      creditAnalyses: { orderBy: { createdAt: 'desc' }, take: 12 },
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  return leads.map((l) => {
    const cf = (l.customFields || {}) as Record<string, any>;
    const latest: Record<string, any> = {};
    for (const a of l.creditAnalyses) if (!latest[a.bank]) latest[a.bank] = a; // já vem do mais novo pro mais antigo
    return {
      id: l.id,
      name: String(cf.participante_1 || l.name),
      stage: l.stage?.name || '',
      status: l.status,
      requested: { creditValue: Number(cf.valor_credito) || Number(l.value) || 0, propertyValue: Number(cf.valor_imovel) || 0, term: cf.prazo_financ || null },
      latest,
      history: l.creditAnalyses,
      chosenId: l.creditAnalyses.find((a) => a.chosen)?.id || null,
    };
  });
}

// ─── Presença das extensões (quando cada uma buscou a fila pela última vez) ───
const lastSeen = new Map<string, number>();
export function touchExtension(accountId: string, bank: string) { lastSeen.set(`${accountId}:${bank}`, Date.now()); }
export function extensionStatus(accountId: string): Record<string, { lastSeenAt: string | null; online: boolean }> {
  const out: Record<string, { lastSeenAt: string | null; online: boolean }> = {};
  for (const bank of BANK_KEYS) {
    const t = lastSeen.get(`${accountId}:${bank}`);
    out[bank] = { lastSeenAt: t ? new Date(t).toISOString() : null, online: !!t && Date.now() - t < 3 * 60 * 1000 };
  }
  return out;
}
