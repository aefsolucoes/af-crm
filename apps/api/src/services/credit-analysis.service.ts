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
  falhou: 'FAILED', verificar: 'CHECK', incompleto: 'INCOMPLETE', teste: 'TEST', condicional: 'CONDITIONAL',
};
const ALL_STATUS = new Set(['REQUESTED', 'RUNNING', 'SENT', 'APPROVED', 'CONDITIONAL', 'REJECTED', 'FAILED', 'CHECK', 'INCOMPLETE', 'TEST']);
const FINAL = new Set(['APPROVED', 'CONDITIONAL', 'REJECTED', 'FAILED', 'CHECK', 'INCOMPLETE', 'TEST']);
const ACTIVE = ['REQUESTED', 'RUNNING'];
/** Bancos cuja extensão sabe só CONFERIR uma proposta já enviada (sem criar outra). */
export const CHECK_BANKS = ['INTER', 'CREDIMORAR', 'CREDITAS'];
const CHECK_FAST_TRIES = 30; // de 1 em 1 min
const CHECK_MAX_TRIES = 60; // depois, de 5 em 5 min até aqui (~3 h); passou disso, fica pra conferir à mão
const CREDITAS_EXTRA_TRIES = 96; // Creditas demora (horas): depois das ~3 h segue de 15 em 15 min por mais 24 h (96 conferências)
const REAL_SENT = ['SENT', 'APPROVED', 'CONDITIONAL', 'REJECTED', 'CHECK']; // já foi rodada de verdade nesse banco
const STALE_ACTIVE_MS = 25 * 60 * 1000; // pedido/execução parado há mais que isso não bloqueia um novo
const STUCK_RUNNING_MS = 5 * 60 * 1000; // rodando há mais que isso sem NENHUM passo novo da extensão = parou (Fabio 14/10: antes eram 30 min e travava a fila; cada passo da extensão leva < 3 min)
const REPORT_REUSE_MS = 12 * 60 * 60 * 1000; // relatório da extensão continua a execução aberta das últimas 12 h

export interface ResultFields {
  proposalNumber?: string | null;
  holderCpf?: string | null;
  approvedValue?: number | null;
  netValue?: number | null;
  termMonths?: number | null;
  rate?: string | null;
  indexer?: string | null;
  firstInstallment?: number | null;
  lastInstallment?: number | null;
  conditions?: string | null;
}
const RESULT_KEYS: (keyof ResultFields)[] = ['proposalNumber', 'holderCpf', 'approvedValue', 'netValue', 'termMonths', 'rate', 'indexer', 'firstInstallment', 'lastInstallment', 'conditions'];

const brl = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

function pickResult(input: Record<string, any>): ResultFields {
  const out: ResultFields = {};
  const num = (v: any) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : null; };
  if ('proposalNumber' in input) out.proposalNumber = input.proposalNumber ? String(input.proposalNumber).slice(0, 40) : null;
  if ('holderCpf' in input) { const d = String(input.holderCpf || '').replace(/\D/g, ''); out.holderCpf = d.length === 11 ? d : null; }
  if ('approvedValue' in input) out.approvedValue = num(input.approvedValue);
  if ('netValue' in input) out.netValue = num(input.netValue);
  if ('termMonths' in input) { const t = num(input.termMonths); out.termMonths = t ? Math.round(t) : null; }
  if ('rate' in input) out.rate = input.rate ? String(input.rate).slice(0, 120) : null;
  if ('indexer' in input) out.indexer = input.indexer ? String(input.indexer).slice(0, 40) : null;
  if ('firstInstallment' in input) out.firstInstallment = num(input.firstInstallment);
  if ('lastInstallment' in input) out.lastInstallment = num(input.lastInstallment);
  if ('conditions' in input) out.conditions = input.conditions ? String(input.conditions).slice(0, 2000) : null;
  return out;
}

/** Última análise de cada banco separada por PARTICIPANTE: o resultado do 2º participante (rodado no nome dele) aparece junto do
 *  do 1º, em vez de um esconder o outro. `rows` vem do mais novo pro mais antigo. */
function latestByParticipant(rows: any[], name2: string): { p1: Record<string, any>; p2: Record<string, any> } {
  const n2 = normName(name2);
  const isP2 = (holder?: string | null) => {
    const h = normName(holder || '');
    return !!(n2 && h && (h === n2 || n2.includes(h) || h.includes(n2)));
  };
  const p1: Record<string, any> = {}, p2: Record<string, any> = {};
  const p1Rows = rows.filter((a) => !isP2(a.holderName)), p2Rows = rows.filter((a) => isP2(a.holderName));
  Object.assign(p1, latestPerBank(p1Rows));
  Object.assign(p2, latestPerBank(p2Rows));
  return { p1, p2 };
}

const RESULTADO_DECISIVO = new Set(['APPROVED', 'CONDITIONAL', 'REJECTED']);
/** Última análise de cada banco (`rows` do mais novo pro mais antigo). Uma releitura (CONFERÊNCIA) que ainda está na fila, rodando, falhou ou não conseguiu ler NÃO esconde um
 *  resultado que já existia (Fabio 14/10: "mostra que falhou no Inter, sendo que foi aprovado no nome da Larissa"). Rodada nova de verdade (RUN) continua valendo. */
export function latestPerBank(rows: any[]): Record<string, any> {
  const temDecisivo = new Set(rows.filter((r) => RESULTADO_DECISIVO.has(r.status)).map((r) => r.bank));
  const out: Record<string, any> = {};
  for (const a of rows) {
    if (out[a.bank]) continue;
    if (a.kind === 'CHECK' && !RESULTADO_DECISIVO.has(a.status) && temDecisivo.has(a.bank)) continue;
    out[a.bank] = a;
  }
  for (const a of rows) if (!out[a.bank]) out[a.bank] = a;
  return out;
}

const normName = (s: string) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const HOLDER_RE = /titular(?:\s+na\s+an[aá]lise)?\s*:\s*([^.(+;|\n]+?)\s*(?=[(+.;|\n]|$)/i;

/** "Titular na análise: Sandra Regina (2º participante: Silas…)." / "iniciando… — titular: Sandra + 2º participante: …" → "Sandra Regina". */
/** Documentos que o Santander pede pra seguir com o valor aprovado a menor — a extensão escreve `[DOCUMENTOS (perfil de renda X): a ; b]` no detalhe. */
export function parseDocumentosExigidos(detail?: string | null): { perfil: string; itens: string[] } | null {
  const m = /\[DOCUMENTOS(?:\s*\(perfil de renda ([^)]*)\))?:\s*([^\]]+)\]/i.exec(String(detail || ''));
  if (!m) return null;
  const itens = m[2].split(/\s*;\s*/).map((t) => t.trim()).filter(Boolean).map(friendlyDocName);
  return itens.length ? { perfil: (m[1] || '').trim().toLowerCase(), itens } : null;
}

/** "Declaração De Imposto De Renda Pessoa Física (IRPF) - Ultimo Exercício E Extrato…" → frase normal (IRPF continua maiúsculo). */
function friendlyDocName(t: string): string {
  const low = t.toLowerCase().replace(/\bultimo\b/g, 'último').replace(/\birpf\b/g, 'IRPF');
  return low.charAt(0).toUpperCase() + low.slice(1);
}

export function parseHolder(detail?: string | null): string | null {
  const m = HOLDER_RE.exec(String(detail || ''));
  const name = m ? m[1].trim() : '';
  return name.length >= 3 ? name : null;
}

/** Em nome de quem a análise foi feita: o que o texto da extensão diz; senão, o 2º participante quando a inversão está ligada
 *  pra esse banco; senão null (titular normal). */
async function resolveHolder(db: Db, leadId: string, bank: string, detail?: string | null): Promise<string | null> {
  const parsed = parseHolder(detail);
  if (parsed) return parsed;
  const [lead, ov] = await Promise.all([
    db.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }),
    db.creditOverride.findFirst({ where: { leadId, bank }, select: { data: true } }),
  ]);
  const p2 = String(((lead?.customFields || {}) as Record<string, any>).participante_2 || '').trim();
  return ov && (ov.data as any)?.inverter === true && p2 ? p2 : null;
}

const brNumber = (t: string) => Number(t.replace(/\./g, '').replace(',', '.'));

/** O Credimorar devolve as condições do Santander como texto ("CONDIÇÕES — Santander: libera + R$ 150.000,00; prazo 120 Meses;
 *  1ª parcela R$ 3.735,50; última R$ 1.281,81; CET 22,96% a.a.; taxa efetiva 21,70% a.a.; …"). Aqui vira número (valor, prazo,
 *  parcelas, taxa) pra preencher a análise e, depois, o card. */
export function parseSantanderConditions(text: string): ResultFields {
  const t = String(text || '').replace(/\s+/g, ' ');
  const out: ResultFields = {};
  const liberado = /(?:valor\s+)?liberado\s*:?\s*R\$\s*([\d.]+,\d{2})/i.exec(t);
  const libera = liberado || /libera\s*\+?\s*R\$\s*([\d.]+,\d{2})/i.exec(t); if (libera) out.approvedValue = brNumber(libera[1]);
  const prazo = /prazo\s*(\d+)\s*meses/i.exec(t); if (prazo) out.termMonths = Number(prazo[1]);
  const p1 = /1[ªa]\s*parcela\s*R\$\s*([\d.]+,\d{2})/i.exec(t); if (p1) out.firstInstallment = brNumber(p1[1]);
  const pu = /[úu]ltima\s*R\$\s*([\d.]+,\d{2})/i.exec(t); if (pu) out.lastInstallment = brNumber(pu[1]);
  // Taxa que o cliente vê é a MENSAL: nominal anual ÷ 12 (ex.: 19,80% a.a. → 1,65% a.m.; é a que dá os 21,70% a.a. efetivos).
  // Sem a nominal, deriva da efetiva anual.
  const fmt = (n: number) => `${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% a.m.`;
  const nominal = /taxa nominal\s*([\d.]+,\d{1,2})\s*%\s*a\.a\./i.exec(t);
  const efetiva = /taxa efetiva\s*([\d.]+,\d{1,2})\s*%\s*a\.a\./i.exec(t);
  if (nominal) out.rate = fmt(brNumber(nominal[1]) / 12);
  else if (efetiva) out.rate = fmt((Math.pow(1 + brNumber(efetiva[1]) / 100, 1 / 12) - 1) * 100);
  return out;
}

/** Nota automática no card quando a análise termina aprovada/reprovada. O formato de
 *  aprovada tem "aprovad…" e "R$ …" de propósito: approval-notice.service lê notas assim
 *  pra montar o texto "✅ Crédito aprovado! Resumo da proposta". */
export function analysisNote(a: { bank: string; status: string; detail?: string | null; dryRun?: boolean; holder?: string | null } & ResultFields): string {
  const label = BANKS[a.bank]?.label || a.bank;
  const test = a.dryRun ? ' [modo teste]' : '';
  const nome = a.holder ? ` 👤 Aprovado no nome de ${a.holder} (2º participante da proposta).` : '';
  if (a.status === 'APPROVED') {
    const parts = [
      `Banco: ${label}`,
      a.approvedValue ? `Valor aprovado: ${brl(a.approvedValue)}` : '',
      a.netValue ? `Valor líquido do contrato: ${brl(a.netValue)} (já descontados IOF, tarifa de cadastro e custas)` : '',
      a.termMonths ? `Prazo: ${a.termMonths} meses` : '',
      a.rate ? `Taxa: ${a.rate}${a.indexer && !new RegExp(a.indexer, 'i').test(a.rate) ? ` + ${a.indexer}` : ''}` : (a.indexer ? `Indexador: ${a.indexer}` : ''),
      a.firstInstallment ? `1ª parcela: ${brl(a.firstInstallment)}` : '',
      a.lastInstallment ? `Última parcela: ${brl(a.lastInstallment)}` : '',
      a.proposalNumber ? `Proposta nº ${a.proposalNumber}` : '',
    ].filter(Boolean);
    return `✅ Análise de crédito${test} — ${/aprovad[oa] a menor/i.test(a.detail || '') ? 'APROVADO A MENOR' : 'APROVADO'} no ${label}.${nome} ${parts.join(' · ')}${a.conditions ? `\nCondições: ${a.conditions}` : ''}${a.detail && !a.approvedValue ? `\n${a.detail}` : ''}`;
  }
  if (a.status === 'CONDITIONAL') {
    return `📄 Análise de crédito${test} — APROVADO CONDICIONAL no ${label}${a.proposalNumber ? ` (proposta nº ${a.proposalNumber})` : ''}: o banco pede documentação para seguir.${nome}${a.detail ? ` ${a.detail}` : ''}`;
  }
  return `❌ Análise de crédito${test} — REPROVADO no ${label}${a.proposalNumber ? ` (proposta nº ${a.proposalNumber})` : ''}.${a.detail ? ` ${a.detail}` : ''}`;
}

/** Pede a análise de N clientes em N bancos (`kind` RUN), ou só a CONFERÊNCIA do resultado de uma proposta já enviada
 *  (`kind` CHECK — a extensão acha o cliente pelo CPF na lista do portal; não cria proposta nova). Pedido de RUN para quem JÁ foi
 *  rodado nesse banco vira só uma CONSULTA da proposta (CHECK), a não ser que venha `force` (ex.: depois de ajustar valores). A extensão busca os pedidos (claimQueue). */
export async function createRequests(db: Db, p: { accountId: string; userId?: string; leadIds: string[]; banks: string[]; dryRun: boolean; kind?: 'RUN' | 'CHECK'; force?: boolean; source?: string }) {
  const wantedKind = p.kind === 'CHECK' ? 'CHECK' : 'RUN';
  const banks = p.banks.filter((b) => BANK_KEYS.includes(b) && (wantedKind === 'RUN' || CHECK_BANKS.includes(b)));
  const leads = await db.lead.findMany({ where: { id: { in: p.leadIds }, accountId: p.accountId }, select: { id: true } });
  let created = 0, skipped = 0;
  const consulted: string[] = [];
  for (const l of leads) {
    for (const bank of banks) {
      const open = await db.creditAnalysis.findFirst({
        where: { leadId: l.id, bank, status: { in: ACTIVE }, updatedAt: { gt: new Date(Date.now() - STALE_ACTIVE_MS) } },
        select: { id: true },
      });
      if (open) { skipped++; continue; }
      // Já foi rodada nesse banco? Então só consulta a proposta (não cria de novo), a menos que seja pra rodar de novo de propósito.
      let kind: 'RUN' | 'CHECK' = wantedKind;
      if (kind === 'RUN' && !p.force && CHECK_BANKS.includes(bank)) {
        const done = await db.creditAnalysis.findFirst({ where: { leadId: l.id, bank, dryRun: false, status: { in: REAL_SENT }, createdAt: { gt: new Date(Date.now() - 60 * 86_400_000) } }, select: { id: true } });
        if (done) { kind = 'CHECK'; if (!consulted.includes(bank)) consulted.push(bank); }
      }
      const prev = kind === 'CHECK' ? await db.creditAnalysis.findFirst({ where: { leadId: l.id, bank, proposalNumber: { not: null } }, orderBy: { createdAt: 'desc' }, select: { proposalNumber: true, holderCpf: true, holderName: true } }) : null;
      const prevNumber = prev?.proposalNumber || null;
      await db.creditAnalysis.create({ data: { accountId: p.accountId, leadId: l.id, bank, status: 'REQUESTED', kind, proposalNumber: prevNumber, holderCpf: prev?.holderCpf || null, holderName: prev?.holderName || null, dryRun: kind === 'CHECK' ? false : p.dryRun, source: p.source || 'EXTENSION', requestedById: p.userId || null } });
      created++;
    }
  }
  return { created, skipped, consulted, banks, leads: leads.length, kind: wantedKind };
}

/** A extensão do banco pergunta: "tem pedido pra mim?". Marca como RUNNING o que entregar. Pedidos de só conferir
 *  (CHECK) só vão pra extensão que avisa saber fazer isso (`caps` inclui "check") — uma versão antiga trataria
 *  como pedido normal e criaria proposta duplicada no banco. */
/** Qual cliente a fila libera agora (Fabio 14/10: "um por um", do mais antigo pro mais novo): o que já tem análise RODANDO (termina primeiro);
 *  sem nenhum rodando, o card mais antigo entre os que têm pedido esperando. Pura (testável). Só entram pedidos de RODAR (RUN) de pessoa/automático:
 *  conferências (CHECK) e leituras da IA da conversa não travam nem são travadas. Pedido esperando há mais de 30 min (extensão fora do ar) não segura a fila. */
export function pickActiveLead(open: Array<{ leadId: string; status: string; requestedAt: Date; leadCreatedAt: Date }>, now = Date.now()): string | null {
  const vivos = open.filter((o) => o.status === 'RUNNING' || now - o.requestedAt.getTime() < 30 * 60_000);
  if (!vivos.length) return null;
  const byAge = (a: { leadCreatedAt: Date }, b: { leadCreatedAt: Date }) => a.leadCreatedAt.getTime() - b.leadCreatedAt.getTime();
  const rodando = vivos.filter((o) => o.status === 'RUNNING').sort(byAge);
  return (rodando[0] || [...vivos].sort(byAge)[0]).leadId;
}

export async function claimQueue(db: Db, p: { accountId: string; bank: string; limit?: number; caps?: string[] }) {
  if (!BANK_KEYS.includes(p.bank)) return [];
  const canCheck = !!p.caps?.includes('check');
  // Em PAUSA GERAL só sai da fila o que uma pessoa pediu (requestedById): reconferências e pedidos automáticos ficam parados.
  await expireStuck(db, { accountId: p.accountId }); // execução parada não segura a fila: aqui (e não só ao abrir a tela) é o que a destrava
  const paused = !!(await db.creditAutoSetting.findUnique({ where: { accountId: p.accountId }, select: { paused: true } }))?.paused;
  // "Um cliente por vez": os pedidos de RODAR de outros clientes esperam o cliente atual terminar em todos os bancos.
  const abertos = await db.creditAnalysis.findMany({
    where: { accountId: p.accountId, kind: 'RUN', status: { in: ['REQUESTED', 'RUNNING'] }, source: { notIn: ['AI', 'AI_SIM'] }, OR: [{ notBefore: null }, { notBefore: { lte: new Date() } }] },
    select: { leadId: true, status: true, requestedAt: true, lead: { select: { createdAt: true } } },
  });
  const ativo = pickActiveLead(abertos.map((a) => ({ leadId: a.leadId, status: a.status, requestedAt: a.requestedAt, leadCreatedAt: a.lead?.createdAt || new Date(0) })));
  const rows = await db.creditAnalysis.findMany({
    where: {
      accountId: p.accountId, bank: p.bank, status: 'REQUESTED', ...(canCheck ? {} : { kind: 'RUN' }),
      AND: [
        ...(ativo ? [{ OR: [{ kind: 'CHECK' }, { source: { in: ['AI', 'AI_SIM'] } }, { leadId: ativo }] }] : []),
        { OR: [{ notBefore: null }, { notBefore: { lte: new Date() } }] },
        // Em pausa geral: só o pedido de pessoa; a leitura (CHECK, só leitura) pedida pela IA da conversa também passa.
        ...(paused ? [{ OR: [{ requestedById: { not: null } }, { source: 'AI', kind: 'CHECK' }] }] : []),
      ],
    },
    orderBy: { requestedAt: 'asc' }, take: p.limit || 3,
    select: { id: true, leadId: true, dryRun: true, kind: true, proposalNumber: true, requestedAt: true, lead: { select: { name: true } } },
  });
  const claimed: typeof rows = [];
  for (const r of rows) {
    const u = await db.creditAnalysis.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { status: 'RUNNING', startedAt: new Date() } });
    if (u.count === 1) claimed.push(r);
  }
  return claimed.map((r) => ({ id: r.id, leadId: r.leadId, leadName: r.lead?.name || '', dryRun: r.dryRun, kind: r.kind, proposalNumber: r.proposalNumber, requestedAt: r.requestedAt }));
}

/** O nome do titular da análise só importa pro cliente quando NÃO é o do 1º participante do card (ex.: inversão). */
async function holderIfSecond(db: Db, leadId: string, holderName?: string | null): Promise<string | null> {
  if (!holderName) return null;
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const main = String(((lead?.customFields || {}) as Record<string, any>).participante_1 || lead?.name || '');
  return normName(holderName) !== normName(main) ? holderName : null;
}

async function applyUpdate(db: Db, row: { id: string; accountId: string; leadId: string; bank: string; status: string; dryRun: boolean }, data: { status?: string; detail?: string | null; holderName?: string | null } & ResultFields) {
  const next = data.status && ALL_STATUS.has(data.status) ? data.status : row.status;
  const becameFinal = FINAL.has(next) && !FINAL.has(row.status);
  const updated = await db.creditAnalysis.update({
    where: { id: row.id },
    data: {
      ...(data.status && ALL_STATUS.has(data.status) ? { status: next } : {}),
      ...(data.detail !== undefined ? { detail: data.detail ? String(data.detail).slice(0, 4000) : null } : {}),
      ...Object.fromEntries(RESULT_KEYS.filter((k) => k in data).map((k) => [k, (data as any)[k]])),
      ...(next === 'RUNNING' ? { startedAt: undefined } : {}),
      ...(data.holderName ? { holderName: data.holderName } : {}),
      ...(becameFinal ? { finishedAt: new Date() } : {}),
    },
  });
  // Aprovada: grava o CPF de QUEM foi aprovado (a extensão manda; senão deduz pelo nome do titular da análise no card) — é por ele que o PDF da simulação
  // é buscado no portal (Juan Reppucci, 14/10: o Santander aprovou no CPF da esposa e o PDF foi procurado no do marido).
  if (!updated.dryRun && (next === 'APPROVED' || next === 'CONDITIONAL') && !updated.holderCpf) {
    const cpf = await resolveHolderCpf(db, updated);
    if (cpf) { await db.creditAnalysis.update({ where: { id: updated.id }, data: { holderCpf: cpf } }).catch(() => {}); (updated as any).holderCpf = cpf; }
  }
  // Nota automática só na primeira vez que vira aprovada/reprovada (modo teste não escreve no card).
  if (becameFinal && !updated.dryRun && (next === 'APPROVED' || next === 'CONDITIONAL' || next === 'REJECTED')) {
    const holder = await holderIfSecond(db, row.leadId, updated.holderName);
    await db.note.create({ data: { leadId: row.leadId, type: 'COMMENT', content: analysisNote({ ...updated, status: next, holder }) } });
  }
  // Creditas: CPF com proposta ativa que NÃO é nossa → observação no card (precisa acionar o gestor).
  if (becameFinal && !updated.dryRun && /acionar manualmente o gestor/i.test(updated.detail || '')) {
    await db.note.create({ data: { leadId: row.leadId, type: 'COMMENT', content: '⚠️ Creditas: este CPF já possui uma proposta ativa que NÃO está na nossa conta — precisa acionar manualmente o gestor da Creditas (contato executivo Home).' } });
  }
  if (becameFinal && updated.dryRun && updated.source === 'AI_SIM') await deliverAiSimulation(db, updated).catch((e: any) => console.error('[IA] simulação de outro prazo:', e?.message));
  return { row: updated, becameFinal };
}

/** CPF (só dígitos) de quem foi analisado: o gravado na análise; senão o do participante do card cujo nome bate com o titular da análise; senão o do 1º participante. */
export async function resolveHolderCpf(db: Db, row: { leadId: string; holderCpf?: string | null; holderName?: string | null; detail?: string | null; bank?: string }): Promise<string | null> {
  if (row.holderCpf) return row.holderCpf;
  const lead = await db.lead.findUnique({ where: { id: row.leadId }, select: { customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const dig = (v: unknown) => String(v ?? '').replace(/\D/g, '');
  const c1 = dig(cf.cpf_1); const c2 = dig(cf.cpf_2);
  const holder = normName(row.holderName || parseHolder(row.detail) || '');
  const n2 = normName(String(cf.participante_2 || ''));
  const n1 = normName(String(cf.participante_1 || ''));
  const bate = (a: string, b: string) => !!a && !!b && (a === b || a.includes(b) || b.includes(a));
  if (holder && bate(holder, n2) && c2.length === 11) return c2;
  if (holder && bate(holder, n1) && c1.length === 11) return c1;
  if (!holder) {
    const ov = row.bank ? await db.creditOverride.findFirst({ where: { leadId: row.leadId, bank: row.bank }, select: { data: true } }) : null;
    if ((ov?.data as any)?.inverter === true && c2.length === 11) return c2;
  }
  return c1.length === 11 ? c1 : null;
}

type AnalysisRow = NonNullable<Awaited<ReturnType<Db['creditAnalysis']['findFirst']>>>;

/** Depois de cada relato: (1) conferência que ainda não achou resultado volta pra fila — de 1 em 1 min nas primeiras 30 vezes,
 *  depois de 5 em 5 min até 60 (~3 h) — pra termos certeza do resultado real; (2) rodada que terminou "enviada" (resultado ainda
 *  não saiu) agenda essa conferência sozinha. Passou do limite, fica "conferir" pra olhar à mão. */
async function afterReport(db: Db, row: AnalysisRow): Promise<AnalysisRow> {
  if (row.dryRun) return row;
  if (row.kind === 'CHECK' && row.source === 'AI') return row; // leitura pontual pedida pela IA da conversa: não vira laço de reconferência
  const paused = !!(await db.creditAutoSetting.findUnique({ where: { accountId: row.accountId }, select: { paused: true } }))?.paused;
  if (row.kind === 'CHECK' && (row.status === 'SENT' || row.status === 'CHECK')) {
    if (paused) return db.creditAnalysis.update({ where: { id: row.id }, data: { status: 'CHECK', attempt: CHECK_MAX_TRIES, detail: `Conferência automática PAUSADA (pausa geral ligada). Use "Conferir" pra ler de novo. ${String(row.detail || '').slice(0, 300)}` } });
    const maxTries = CHECK_MAX_TRIES + (row.bank === 'CREDITAS' ? CREDITAS_EXTRA_TRIES : 0);
    if (row.attempt < maxTries) {
      const attempt = row.attempt + 1;
      const fast = attempt <= CHECK_FAST_TRIES;
      const slow = attempt > CHECK_MAX_TRIES; // só o Creditas chega aqui
      const passo = fast ? 'de 1 em 1 min' : slow ? 'de 15 em 15 min' : 'de 5 em 5 min';
      return db.creditAnalysis.update({
        where: { id: row.id },
        data: {
          status: 'REQUESTED', notBefore: new Date(Date.now() + (fast ? 60_000 : slow ? 15 * 60_000 : 5 * 60_000)), attempt, finishedAt: null,
          detail: `Conferindo ${passo} (conferência ${attempt} de ${maxTries}). Última leitura: ${String(row.detail || '').replace(/^Conferindo[^:]*:\s*(Última leitura:\s*)?/i, '').slice(0, 300)}`,
        },
      });
    }
    return db.creditAnalysis.update({ where: { id: row.id }, data: { status: 'CHECK', detail: `Sem resultado depois de ${maxTries} conferências: confira no portal. ${String(row.detail || '').slice(0, 300)}` } });
  }
  if (row.kind === 'RUN' && row.status === 'SENT' && CHECK_BANKS.includes(row.bank) && !paused) {
    const open = await db.creditAnalysis.findFirst({ where: { leadId: row.leadId, bank: row.bank, kind: 'CHECK', status: { in: ACTIVE } }, select: { id: true } });
    if (!open) {
      await db.creditAnalysis.create({
        data: { accountId: row.accountId, leadId: row.leadId, bank: row.bank, status: 'REQUESTED', kind: 'CHECK', attempt: 1, notBefore: new Date(Date.now() + 60_000), proposalNumber: row.proposalNumber, dryRun: false, source: 'EXTENSION', holderName: row.holderName, holderCpf: row.holderCpf, detail: 'Conferindo de 1 em 1 min até sair o resultado.' },
      });
    }
  }
  return row;
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
  // Aprovado "condicionado" (Inter pede documentos; Santander "Aprovado Condicional") é um status próprio: aprovou, mas falta algo.
  const status = p.status === 'APPROVED' && /condicion/i.test(p.detail || '') ? 'CONDITIONAL' : p.status;
  const numbers = p.bank === 'CREDIMORAR' ? parseSantanderConditions(p.detail || '') : {};
  const holderName = parseHolder(p.detail) || row.holderName || (FINAL.has(status) ? await resolveHolder(db, p.leadId, p.bank, null) : null);
  const { row: updated } = await applyUpdate(db, row, { status, detail: p.detail ?? null, holderName, ...numbers, ...pickResult(p.result || {}) });
  return afterReport(db, updated);
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
  const { row: updated } = await applyUpdate(db, row, { status: p.status, detail: p.detail ?? null, holderName: await resolveHolder(db, p.leadId, p.bank, p.detail), ...pickResult(p.result || {}) });
  return updated;
}

/** Escolhe a proposta do cliente (manual): marca como escolhida e preenche a aba Financiamento do card. */
export async function chooseAnalysis(db: Db, p: { accountId: string; id: string; userName?: string }) {
  const row = await db.creditAnalysis.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!row) throw new Error('análise não encontrada');
  if (row.status !== 'APPROVED' && row.status !== 'CONDITIONAL') throw new Error('só dá pra escolher uma proposta aprovada');
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
      content: `⭐ Proposta escolhida: ${b?.label || row.bank}${row.approvedValue ? ` — ${brl(row.approvedValue)}` : ''}${(await holderIfSecond(db, row.leadId, row.holderName)) ? `, no nome de ${row.holderName} (2º participante)` : ''}${p.userName ? ` (por ${p.userName})` : ''}. A aba Financiamento do card foi preenchida com ela (${campos}).${before.valor && row.approvedValue && Number(before.valor) !== row.approvedValue ? ` Valor pedido antes: ${brl(Number(before.valor))}.` : ''}`,
    },
  });
  return { ok: true, filled: Object.keys(fill).filter((k) => !k.startsWith('_')) };
}

/** Execução que ficou "rodando" sem a extensão dar sinal (Chrome fechado, janela fechada) vira "falhou". */
/** Texto da falha de uma execução que sumiu: diz POR QUÊ (o que aconteceu) e em que etapa parou, e o que fazer. */
function orphanDetail(why: string, lastDetail?: string | null): string {
  const ult = String(lastDetail || '').replace(/\s+/g, ' ').replace(/^Titular na análise:[^.]*\.\s*/i, '').slice(0, 220);
  return `${why}${ult ? ` Última etapa registrada: "${ult}".` : ' Não chegou a registrar nenhuma etapa.'} Nada foi concluído: peça de novo (se a proposta já tinha sido enviada ao banco, use "Conferir").`;
}

async function expireStuck(db: Db, where: { accountId: string; leadId?: string }) {
  const rows = await db.creditAnalysis.findMany({ where: { ...where, status: 'RUNNING', updatedAt: { lt: new Date(Date.now() - STUCK_RUNNING_MS) } }, select: { id: true, detail: true } });
  for (const r of rows) {
    await db.creditAnalysis.updateMany({
      where: { id: r.id, status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt: new Date(), detail: orphanDetail('A extensão ficou mais de 5 minutos sem andar para o passo seguinte (janela do banco sem foco, portal que não respondeu, Chrome fechado, computador dormiu ou extensão recarregada).', r.detail) },
    });
  }
}

/** A extensão acabou de (re)iniciar: o que ela tinha em execução se perdeu (recarregar a extensão, o Chrome reiniciar ou o service
 *  worker ser encerrado derruba a execução). Falha na hora, com o motivo, em vez de esperar 30 min. */
export async function releaseOrphans(db: Db, p: { accountId: string; bank: string }) {
  const rows = await db.creditAnalysis.findMany({ where: { accountId: p.accountId, bank: p.bank, status: 'RUNNING' }, select: { id: true, detail: true } });
  for (const r of rows) {
    await db.creditAnalysis.updateMany({
      where: { id: r.id, status: 'RUNNING' },
      data: { status: 'FAILED', finishedAt: new Date(), detail: orphanDetail('A extensão foi recarregada ou reiniciada no meio desta execução (recarregar a extensão no Chrome, reiniciar o Chrome ou o Chrome encerrar a extensão).', r.detail) },
    });
  }
  releaseLock(p.accountId, p.bank);
  return rows.length;
}

/** Quadro da aba: clientes do Home Equity em Pré-Análise (e quem teve análise nas últimas 3 semanas) × bancos. */
export async function board(db: Db, p: { accountId: string; scopeDepartmentIds: string[] }) {
  await expireStuck(db, { accountId: p.accountId });
  const since = new Date(Date.now() - 90 * 86_400_000);
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
      creditAnalyses: { orderBy: { createdAt: 'desc' }, take: 30 },
      creditOverrides: { select: { bank: true, data: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 300,
  });
  return leads.map((l) => {
    const cf = (l.customFields || {}) as Record<string, any>;
    const latest: Record<string, any> = latestPerBank(l.creditAnalyses); // já vem do mais novo pro mais antigo
    const byPart = latestByParticipant(l.creditAnalyses, String(cf.participante_2 || ''));
    return {
      latestP1: byPart.p1,
      latestP2: byPart.p2,
      id: l.id,
      name: String(cf.participante_1 || l.name),
      stage: l.stage?.name || '',
      status: l.status,
      requested: { creditValue: Number(cf.valor_credito) || Number(l.value) || 0, propertyValue: Number(cf.valor_imovel) || 0, term: cf.prazo_financ || null },
      // Dados do card pra mostrar ao lado dos ajustes (a extensão lê a proposta na conversa; o card costuma bater).
      card: {
        name1: String(cf.participante_1 || l.name || ''), name2: String(cf.participante_2 || ''),
        income1: cf.renda_1 ? String(cf.renda_1) : '', income2: cf.renda_2 ? String(cf.renda_2) : '',
        propertyValue: cf.valor_imovel ? String(cf.valor_imovel) : '', creditValue: cf.valor_credito ? String(cf.valor_credito) : '',
        term: cf.prazo_financ ? String(cf.prazo_financ) : '',
      },
      overrides: Object.fromEntries(l.creditOverrides.map((o) => [o.bank, o.data])),
      inPre: l.status === 'OPEN' && /^pré-an/i.test(l.stage?.name || ''),
      ran: l.creditAnalyses.length > 0,
      lastRunAt: l.creditAnalyses[0]?.createdAt || null,
      latest,
      history: l.creditAnalyses,
      chosenId: l.creditAnalyses.find((a) => a.chosen)?.id || null,
    };
  });
}

// ─── Ajustes do cliente na análise (inverter titular, valores, renda, prazo) ───
export interface OverrideData {
  valorImovel?: string; valorEmprestimo?: string; renda?: string; prazo?: string; rendaParticipante?: string; inverter?: boolean;
}
const OVERRIDE_TEXT_KEYS = ['valorImovel', 'valorEmprestimo', 'renda', 'prazo', 'rendaParticipante'] as const;

/** Só as chaves conhecidas, texto curto, vazio some. */
export function cleanOverride(input: Record<string, any> | null | undefined): OverrideData {
  const out: OverrideData = {};
  for (const k of OVERRIDE_TEXT_KEYS) {
    const v = input?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = String(v).trim().slice(0, 40);
  }
  if (input?.inverter === true) out.inverter = true;
  return out;
}

export async function getOverride(db: Db, p: { accountId: string; leadId: string; bank: string }) {
  const row = await db.creditOverride.findFirst({ where: { accountId: p.accountId, leadId: p.leadId, bank: p.bank } });
  return row ? (row.data as OverrideData) : null;
}

const OVERRIDE_LABEL: Record<string, string> = {
  valorImovel: 'valor do imóvel', valorEmprestimo: 'valor do financiamento', renda: 'renda', prazo: 'prazo', rendaParticipante: 'renda do 2º participante',
};

/** Grava (ou apaga, se ficar vazio) o ajuste do cliente nos bancos escolhidos. `merge` soma ao que já existe. */
export async function setOverrides(db: Db, p: { accountId: string; userId?: string; userName?: string; leadId: string; banks: string[]; data: Record<string, any>; merge?: boolean }) {
  const banks = p.banks.filter((b) => BANK_KEYS.includes(b));
  if (!banks.length) throw new Error('escolha pelo menos um banco');
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true } });
  if (!lead) throw new Error('card não encontrado');
  const touched: string[] = [];
  for (const bank of banks) {
    const existing = await db.creditOverride.findFirst({ where: { leadId: p.leadId, bank } });
    const base = p.merge && existing ? (existing.data as Record<string, any>) : {};
    const next = cleanOverride({ ...base, ...p.data }); // inverter:false (desfazer) some aqui, só o true é guardado
    const empty = Object.keys(next).length === 0;
    if (empty) { if (existing) await db.creditOverride.delete({ where: { id: existing.id } }); continue; }
    if (existing) await db.creditOverride.update({ where: { id: existing.id }, data: { data: next as any, updatedById: p.userId || null } });
    else await db.creditOverride.create({ data: { accountId: p.accountId, leadId: p.leadId, bank, data: next as any, updatedById: p.userId || null } });
    touched.push(bank);
  }
  // Nota no card, pra ficar registrado o que foi mudado (sem a palavra "aprov" de propósito: não confunde o aviso de crédito aprovado).
  const first = touched[0] ? await db.creditOverride.findFirst({ where: { leadId: p.leadId, bank: touched[0] } }) : null;
  const d = (first?.data || {}) as OverrideData;
  const parts = [
    ...OVERRIDE_TEXT_KEYS.filter((k) => d[k]).map((k) => `${OVERRIDE_LABEL[k]}: ${d[k]}`),
    d.inverter ? 'titular e 2º participante invertidos' : '',
  ].filter(Boolean);
  const where = banks.map((b) => BANKS[b].label).join(', ');
  await db.note.create({
    data: {
      leadId: p.leadId, type: 'COMMENT',
      content: touched.length
        ? `✏️ Ajuste para a análise de crédito (${where})${p.userName ? ` por ${p.userName}` : ''}: ${parts.join(' · ')}. Vale na próxima vez que a análise rodar.`
        : `✏️ Ajustes da análise de crédito removidos (${where})${p.userName ? ` por ${p.userName}` : ''}.`,
    },
  });
  return { ok: true, banks: touched };
}

/** Bloco "Análises de crédito" dentro do card: último resultado de cada banco + histórico. */
export async function leadAnalyses(db: Db, p: { accountId: string; leadId: string; scopeDepartmentIds: string[] }) {
  const lead = await db.lead.findFirst({
    where: { id: p.leadId, accountId: p.accountId },
    select: { id: true, name: true, customFields: true, pipeline: { select: { departmentId: true, department: { select: { name: true } } } } },
  });
  if (!lead) return null;
  const deptId = lead.pipeline?.departmentId;
  if (p.scopeDepartmentIds.length && deptId && !p.scopeDepartmentIds.includes(deptId)) return null;
  await expireStuck(db, { accountId: p.accountId, leadId: p.leadId });
  const history = await db.creditAnalysis.findMany({ where: { leadId: p.leadId }, orderBy: { createdAt: 'desc' }, take: 30 });
  const latest: Record<string, any> = latestPerBank(history);
  const cf = (lead.customFields || {}) as Record<string, any>;
  const overrides = await db.creditOverride.findMany({ where: { leadId: p.leadId }, select: { bank: true, data: true } });
  return {
    eligible: /home equity/i.test(lead.pipeline?.department?.name || ''),
    latest, latestP1: latestByParticipant(history, String(cf.participante_2 || '')).p1, latestP2: latestByParticipant(history, String(cf.participante_2 || '')).p2, history, chosenId: history.find((a) => a.chosen)?.id || null,
    participants: { name1: String(cf.participante_1 || lead.name || ''), name2: String(cf.participante_2 || ''), inverted: overrides.some((o) => (o.data as any)?.inverter === true) },
  };
}

// ─── Métricas pro Dashboard (Fabio 14/10: aprovados por banco, tempo até o resultado, taxa de aprovação) ───
const DECIDED_OK = new Set(['APPROVED', 'CONDITIONAL']);
const PENDING = new Set(['REQUESTED', 'RUNNING', 'SENT', 'CHECK']);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Métricas por mês e por banco. Conta UMA vez cada cliente×banco (o resultado mais recente já decidido; senão a linha mais
 *  recente) — refazer a análise do mesmo cliente no mesmo banco não infla os números. Teste e extensões em modo teste ficam de fora.
 *  Taxa de aprovação = aprovadas ÷ (aprovadas + reprovadas); "aprovada" inclui a condicional (o banco pede documentos).
 *  Tempo até o resultado = da 1ª solicitação do cliente naquele banco até o resultado final. */
export async function creditMetrics(db: Db, p: { accountId: string; scopeDepartmentIds: string[]; departmentId?: string; months: number }) {
  const monthKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).format(d);
  const [cy, cm] = monthKey(new Date()).split('-').map(Number);
  const keys: string[] = [];
  for (let i = p.months - 1; i >= 0; i--) {
    const y = cy + Math.floor((cm - 1 - i) / 12);
    const m = ((cm - 1 - i) % 12 + 12) % 12 + 1;
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  const from = new Date(`${keys[0]}-01T00:00:00-03:00`);
  const deptWhere = p.departmentId
    ? { departmentId: p.departmentId, ...(p.scopeDepartmentIds.length ? { AND: [{ departmentId: { in: p.scopeDepartmentIds } }] } : {}) }
    : (p.scopeDepartmentIds.length ? { departmentId: { in: p.scopeDepartmentIds } } : { departmentId: { not: null } });
  const rows = await db.creditAnalysis.findMany({
    where: { accountId: p.accountId, createdAt: { gte: from }, dryRun: false, status: { not: 'TEST' }, lead: { pipeline: deptWhere } },
    select: { leadId: true, bank: true, status: true, createdAt: true, finishedAt: true, source: true, detail: true },
    orderBy: { createdAt: 'asc' },
  });
  // "Desqualificado" (o cliente não atende às regras daquele banco: mínimo do imóvel, terreno, saldo devedor…) vale como REPROVADO (Fabio 14/10).
  const OBJETIVA = /N[ÃA]O RODEI|n[aã]o conformidade|recusou antes de consultar/i;
  const reprovou = (r: { status: string; detail?: string | null }) => r.status === 'REJECTED' || (r.status === 'FAILED' && OBJETIVA.test(r.detail || ''));

  const out = keys.map((key) => {
    const [y, m] = key.split('-').map(Number);
    const label = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', month: 'long', year: 'numeric' }).format(new Date(`${key}-15T12:00:00-03:00`));
    // cliente×banco → linhas do mês (pelo mês da 1ª solicitação)
    const pairs = new Map<string, typeof rows>();
    for (const r of rows) {
      if (monthKey(r.createdAt) !== key) continue;
      const k = `${r.leadId}|${r.bank}`;
      pairs.set(k, [...(pairs.get(k) || []), r]);
    }
    const banks: Record<string, { analyzed: number; approved: number; conditional: number; rejected: number; pending: number; failed: number; decided: number; approvalRate: number | null; medianMinutes: number | null; avgMinutes: number | null }> = {};
    for (const b of BANK_KEYS) banks[b] = { analyzed: 0, approved: 0, conditional: 0, rejected: 0, pending: 0, failed: 0, decided: 0, approvalRate: null, medianMinutes: null, avgMinutes: null };
    const mins: Record<string, number[]> = Object.fromEntries(BANK_KEYS.map((b) => [b, [] as number[]]));
    const byLead = new Map<string, { ok: boolean; rejected: boolean; pending: boolean }>();
    for (const [k, list] of Array.from(pairs.entries())) {
      const [leadId, bank] = k.split('|');
      if (!banks[bank]) continue;
      const decided = [...list].reverse().find((r) => DECIDED_OK.has(r.status) || reprovou(r));
      const rep = decided || list[list.length - 1];
      const b = banks[bank];
      b.analyzed++;
      if (DECIDED_OK.has(rep.status)) { b.approved++; if (rep.status === 'CONDITIONAL') b.conditional++; }
      else if (reprovou(rep)) b.rejected++;
      else if (PENDING.has(rep.status)) b.pending++;
      else b.failed++;
      if (decided && decided.finishedAt && list[0].source === 'EXTENSION') { // registro manual não mede tempo (não tem uma solicitação de verdade)
        const minutes = (decided.finishedAt.getTime() - list[0].createdAt.getTime()) / 60_000;
        if (minutes >= 0) mins[bank].push(minutes);
      }
      const l = byLead.get(leadId) || { ok: false, rejected: false, pending: false };
      if (DECIDED_OK.has(rep.status)) l.ok = true; else if (reprovou(rep)) l.rejected = true; else if (PENDING.has(rep.status)) l.pending = true;
      byLead.set(leadId, l);
    }
    for (const b of BANK_KEYS) {
      const x = banks[b];
      x.decided = x.approved + x.rejected;
      x.approvalRate = x.decided ? Math.round((x.approved / x.decided) * 1000) / 10 : null;
      x.medianMinutes = median(mins[b]) === null ? null : Math.round(median(mins[b])! * 10) / 10;
      x.avgMinutes = mins[b].length ? Math.round((mins[b].reduce((a, c) => a + c, 0) / mins[b].length) * 10) / 10 : null;
    }
    const leads = Array.from(byLead.values());
    const clientsApproved = leads.filter((l) => l.ok).length;
    const clientsRejected = leads.filter((l) => !l.ok && l.rejected && !l.pending).length; // reprovado em todos os bancos que já responderam
    const allMins = BANK_KEYS.flatMap((b) => mins[b]);
    return {
      month: key, label,
      clientsAnalyzed: leads.length, clientsApproved, clientsRejected,
      clientsPending: leads.filter((l) => !l.ok && l.pending).length,
      approvalRate: clientsApproved + clientsRejected ? Math.round((clientsApproved / (clientsApproved + clientsRejected)) * 1000) / 10 : null,
      medianMinutes: median(allMins) === null ? null : Math.round(median(allMins)! * 10) / 10,
      banks,
    };
  });
  return { rows: out.reverse() }; // mês mais novo primeiro, igual ao painel do mês
}

// ─── Trava única: uma extensão por vez usa o navegador ───
// As 3 extensões trabalham como uma pessoa (a aba do banco precisa ficar visível, senão o Chrome congela a página). Rodando
// juntas, cada uma puxa a aba pra frente e derruba a outra. Então elas pedem a vez aqui e esperam. A trava vence sozinha
// (10 min sem sinal) pra uma extensão travada/fechada não segurar a fila, e cada relato da extensão dona renova o prazo.
const LOCK_TTL_MS = 10 * 60 * 1000;
const locks = new Map<string, { bank: string; expiresAt: number }>();
export function acquireLock(accountId: string, bank: string): { ok: boolean; holder?: string } {
  const now = Date.now();
  const cur = locks.get(accountId);
  if (cur && cur.expiresAt > now && cur.bank !== bank) return { ok: false, holder: cur.bank };
  locks.set(accountId, { bank, expiresAt: now + LOCK_TTL_MS });
  return { ok: true };
}
export function releaseLock(accountId: string, bank: string) {
  const cur = locks.get(accountId);
  if (cur && cur.bank === bank) locks.delete(accountId);
}
export function renewLock(accountId: string, bank: string) {
  const cur = locks.get(accountId);
  if (cur && cur.bank === bank) cur.expiresAt = Date.now() + LOCK_TTL_MS;
}

// ─── Presença das extensões (quando cada uma buscou a fila pela última vez) ───
const lastSeen = new Map<string, { at: number; extId: string | null }>();
const EXT_ID_RE = /^[a-p]{32}$/;
/** `extId` = id da extensão no Chrome, que o CRM usa pra avisá-la na hora (externally_connectable). */
export function touchExtension(accountId: string, bank: string, extId?: string | null) {
  const key = `${accountId}:${bank}`;
  const prev = lastSeen.get(key);
  lastSeen.set(key, { at: Date.now(), extId: extId && EXT_ID_RE.test(extId) ? extId : prev?.extId || null });
}
export function extensionStatus(accountId: string): Record<string, { lastSeenAt: string | null; online: boolean; extId: string | null }> {
  const out: Record<string, { lastSeenAt: string | null; online: boolean; extId: string | null }> = {};
  for (const bank of BANK_KEYS) {
    const seen = lastSeen.get(`${accountId}:${bank}`);
    out[bank] = { lastSeenAt: seen ? new Date(seen.at).toISOString() : null, online: !!seen && Date.now() - seen.at < 3 * 60 * 1000, extId: seen?.extId || null };
  }
  return out;
}


// ═══ IA da conversa × extensões (Fabio 13/10: "sempre que a IA responder o cliente, consultar agora no sistema, usando a extensão") ═══

/** Taxa MENSAL (%) lida do texto da análise ("1,09% a.m. + IPCA", "1.40% a.m.", "13,89% a.a."). null = não informou. */
export function monthlyRatePct(text?: string | null): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*%/.exec(String(text || ''));
  if (!m) return null;
  const v = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0) return null;
  return /a\.?\s*a\b|ao ano|anual/i.test(String(text)) ? (Math.pow(1 + v / 100, 1 / 12) - 1) * 100 : v;
}

/** Ordem fixa de preferência dos bancos (Fabio 14/10): Inter primeiro, Creditas segundo, Santander terceiro. */
const SIM_BANK_PRIORITY: Record<string, number> = { INTER: 0, CREDITAS: 1, CREDIMORAR: 2 };
const simPriority = (bank: string) => SIM_BANK_PRIORITY[bank] ?? 9;

/** Banco cuja simulação em PDF vai pro cliente: só UM — a proposta que o cliente ESCOLHEU (`chosen`) ou, sem escolha, o primeiro na ordem
 *  Inter > Creditas > Santander entre os aprovados (Fabio 14/10: "não há taxa alta, segue a ordem dos bancos"). */
export function pickSimulationBank(approved: Array<{ bank: string; rate?: string | null; chosen?: boolean; firstInstallment?: number | null }>): { bank: string; why: string } | null {
  if (!approved.length) return null;
  const chosen = approved.find((a) => a.chosen);
  if (chosen) return { bank: chosen.bank, why: 'proposta escolhida' };
  if (approved.length === 1) return { bank: approved[0].bank, why: 'única aprovada' };
  const first = [...approved].sort((x, y) => simPriority(x.bank) - simPriority(y.bank))[0];
  return { bank: first.bank, why: 'ordem Inter > Creditas > Santander' };
}

const BANK_LABEL_IA: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
const PERGUNTA_DE_STATUS = /(anali[sz]|aprov|resultad|retorno|saiu|sair|reprov|negad|deu certo|j[aá] sai|como (est|t[aá])|novidade|andamento|cr[eé]dito|propost|simula|banco|parcela|liberad|taxa|prazo)/i;

/** Texto pra IA da conversa: a leitura MAIS RECENTE de cada banco (por participante), com "lido há N min". Vazio se o cliente nunca foi rodado. */
export async function aiCreditContext(db: Db, leadId: string): Promise<string> {
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  if (!lead) return '';
  const cf = (lead.customFields || {}) as Record<string, any>;
  const rows = await db.creditAnalysis.findMany({
    where: { leadId, dryRun: false, createdAt: { gte: new Date(Date.now() - 60 * 86_400_000) }, status: { notIn: ['REQUESTED', 'RUNNING', 'TEST'] } },
    orderBy: { createdAt: 'desc' }, take: 40,
  });
  if (!rows.length) return '';
  // Leitura que FALHOU (ex.: conferência que travou) não pode esconder o último resultado conhecido: só entra se não houver nada melhor.
  const n2 = String(cf.participante_2 || '');
  const bons = latestByParticipant(rows.filter((r) => r.status !== 'FAILED'), n2);
  const ruins = latestByParticipant(rows.filter((r) => r.status === 'FAILED'), n2);
  const p1 = { ...ruins.p1, ...bons.p1 };
  const p2 = { ...ruins.p2, ...bons.p2 };
  const agora = Date.now();
  const ha = (d: Date) => { const m = Math.max(0, Math.round((agora - d.getTime()) / 60000)); return m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} dia(s)`; };
  const descreve = (r: any): string => {
    const aMenor = /aprovad[oa] a menor/i.test(r.detail || '');
    switch (r.status) {
      case 'APPROVED': {
        const partes = [
          r.netValue ? `valor líquido ${brl(r.netValue)}` : r.approvedValue ? `valor ${brl(r.approvedValue)}` : '',
          r.termMonths ? `${r.termMonths} meses` : '', r.rate ? `taxa ${r.rate}` : '',
          r.firstInstallment ? `1ª parcela ${brl(r.firstInstallment)}` : '', r.lastInstallment ? `última parcela ${brl(r.lastInstallment)}` : '',
        ].filter(Boolean);
        const docs = aMenor ? parseDocumentosExigidos(r.detail) : null;
        const docsTxt = docs ? `. Para seguir com esse valor o banco exige comprovação de renda${docs.perfil ? ` (perfil ${docs.perfil})` : ''} — documentos: ${docs.itens.join('; ')} (peça ao cliente)` : '';
        return `${aMenor ? 'APROVADO A MENOR (valor menor que o pedido)' : 'APROVADO'}${partes.length ? `: ${partes.join(', ')}` : ' (os números ainda não foram lidos)'}${docsTxt}`;
      }
      case 'CONDITIONAL': return 'APROVADO COM CONDIÇÃO — o banco pede documentos para seguir';
      case 'REJECTED': return 'REPROVADO';
      case 'SENT': return 'ENVIADO ao banco, EM ANÁLISE — ainda sem resultado';
      case 'INCOMPLETE': return 'EM ANÁLISE — o banco pediu mais dados do cliente (a equipe está completando)';
      case 'CHECK': return 'EM ANÁLISE — ainda sem resultado conclusivo';
      default: return 'NÃO ANALISADO nesse banco (assunto interno: não explique o motivo ao cliente)';
    }
  };
  const linhas: string[] = [];
  for (const [bucket, quem] of [[p1, ''], [p2, ' [análise no nome do 2º participante]']] as [Record<string, any>, string][]) {
    for (const bank of ['CREDIMORAR', 'CREDITAS', 'INTER']) {
      const r = bucket[bank];
      if (r) linhas.push(`- ${BANK_LABEL_IA[bank]}${quem}: ${descreve(r)} (lido há ${ha(r.updatedAt)})`);
    }
  }
  const aprovados = Object.entries(p1).filter(([, r]: [string, any]) => r && (r.status === 'APPROVED' || r.status === 'CONDITIONAL') && r.approvedValue != null).map(([bank, r]: [string, any]) => ({ bank, rate: r.rate, chosen: r.chosen, firstInstallment: r.firstInstallment }));
  const escolha = aprovados.length >= 2 ? pickSimulationBank(aprovados) : null;
  if (escolha) linhas.push(`- Simulação em PDF: ${aprovados.some((a) => a.chosen) ? 'o cliente já escolheu' : 'se o cliente ainda não escolheu, mande só a do primeiro banco na ordem Inter, Creditas, Santander'} → ${BANK_LABEL_IA[escolha.bank]} (${escolha.why}).`);
  if (!linhas.length) return '';
  return `ANÁLISE DE CRÉDITO DESTE CLIENTE (leitura dos portais dos bancos feita pela extensão do Chrome; entre parênteses, há quanto tempo foi lida):\n${linhas.join('\n')}`;
};

/** Cliente perguntou da análise: pede uma LEITURA NOVA (só leitura, não cria proposta) nos bancos já rodados e espera a extensão
 *  ler (até maxWaitMs). A extensão busca pedidos a cada ~1 min, então leva de 1 a 2 min. Nunca lança erro. */
export async function refreshAnalysesForAi(db: Db, p: { accountId: string; leadId: string; text: string; maxWaitMs?: number }): Promise<{ asked: boolean; waited: boolean }> {
  try {
    if (process.env.AI_SKIP_REFRESH === '1') return { asked: false, waited: false }; // só pra teste (não cria pedido nas extensões)
    if (!PERGUNTA_DE_STATUS.test(String(p.text || ''))) return { asked: false, waited: false };
    const ran = await db.creditAnalysis.findMany({
      where: { leadId: p.leadId, dryRun: false, status: { in: REAL_SENT }, createdAt: { gt: new Date(Date.now() - 60 * 86_400_000) } },
      orderBy: { updatedAt: 'desc' }, select: { bank: true, updatedAt: true },
    });
    const banks = Array.from(new Set(ran.map((r) => r.bank))).filter((b) => CHECK_BANKS.includes(b));
    if (!banks.length) return { asked: false, waited: false };
    // leitura recente (menos de 10 min) em todos os bancos: não precisa de outra
    const ultimaPorBanco = new Map<string, number>();
    for (const r of ran) if (!ultimaPorBanco.has(r.bank)) ultimaPorBanco.set(r.bank, r.updatedAt.getTime());
    const precisa = banks.filter((b) => Date.now() - (ultimaPorBanco.get(b) || 0) > 10 * 60_000);
    if (precisa.length) await createRequests(db, { accountId: p.accountId, leadIds: [p.leadId], banks: precisa, dryRun: false, kind: 'CHECK', source: 'AI' });
    // espera as leituras abertas (as que acabei de pedir e as que já estavam na fila)
    const abertas = await db.creditAnalysis.findMany({ where: { leadId: p.leadId, kind: 'CHECK', status: { in: ['REQUESTED', 'RUNNING'] }, updatedAt: { gt: new Date(Date.now() - 25 * 60_000) } }, select: { id: true, attempt: true } });
    if (!abertas.length) return { asked: precisa.length > 0, waited: false };
    const limite = Date.now() + (p.maxWaitMs ?? 120_000);
    while (Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 4000));
      const agora = await db.creditAnalysis.findMany({ where: { id: { in: abertas.map((a) => a.id) } }, select: { id: true, status: true, attempt: true } });
      const pendente = agora.some((r) => {
        const antes = abertas.find((a) => a.id === r.id)!;
        return ['REQUESTED', 'RUNNING'].includes(r.status) && r.attempt <= antes.attempt;
      });
      if (!pendente) return { asked: true, waited: true };
    }
    return { asked: true, waited: true };
  } catch (err: any) {
    console.error('[IA × análise] não consegui renovar a leitura:', err?.message);
    return { asked: false, waited: false };
  }
}

// ─── Simulação em OUTRO prazo, feita pela IA (Fabio 14/10: "a IA tem autonomia de fazer a simulação e encaminhar ao cliente") ───
// A IA marca `simulate`; aqui o CRM põe o prazo (e o valor aprovado) como ajuste do Inter, pede um teste (dryRun) à extensão — que preenche o
// simulador do portal e PARA antes de "Solicitar análise" (nada é enviado ao banco) — lê o painel de resultado e manda os valores ao cliente.
const SIM_ROW_NOTE = 'AI_SIM';

export interface InterSimulation { prazo?: number; primeira?: number; ultima?: number; taxa?: string; cet?: string; valor?: number }

/** Lê o texto do painel "Resultado da simulação" do Inter (capturado pela extensão em `| SIMULACAO: …`). */
export function parseInterSimText(detail: string | null | undefined): InterSimulation | null {
  const t = String(detail || '');
  const i = t.indexOf('SIMULACAO:');
  if (i < 0) return null;
  const txt = t.slice(i + 10).replace(/\s+/g, ' ');
  const money = (re: RegExp) => { const m = re.exec(txt); return m ? brNumber(m[1]) : undefined; };
  const out: InterSimulation = {
    primeira: money(/(?:1[ªa]|primeira)\s*parcela[^R\d]{0,40}R\$\s*([\d.]+,\d{2})/i),
    ultima: money(/[úu]ltima\s*parcela[^R\d]{0,40}R\$\s*([\d.]+,\d{2})/i),
    valor: money(/valor\s+(?:do\s+)?(?:financiamento|empr[ée]stimo|solicitado)[^R\d]{0,40}R\$\s*([\d.]+,\d{2})/i),
  };
  const taxa = /taxa[^%\d]{0,40}(\d+,\d+)\s*%/i.exec(txt); if (taxa) out.taxa = `${taxa[1]}%`;
  const cet = /CET[^%\d]{0,40}(\d+,\d+)\s*%/i.exec(txt); if (cet) out.cet = `${cet[1]}%`;
  return out.primeira || out.ultima ? out : null;
}

const fmtBRL = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function requestSimulationForAi(db: Db, accountId: string, leadId: string, p: { prazo: number }): Promise<{ ok: boolean; detail: string }> {
  const prazo = Math.round(Number(p.prazo));
  if (!(prazo >= 60 && prazo <= 240)) return { ok: false, detail: `prazo de ${p.prazo} meses fora do que o Inter simula (60 a 240)` };
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { status: true, archived: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead || lead.status !== 'OPEN' || lead.archived) return { ok: false, detail: 'o card não está aberto' };
  if (!/home equity/i.test(lead.pipeline?.department?.name || '')) return { ok: false, detail: 'só vale para Home Equity' };
  const aprovadas = await db.creditAnalysis.findMany({ where: { leadId, dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL'] }, createdAt: { gt: new Date(Date.now() - 60 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 8, select: { bank: true, approvedValue: true, chosen: true } });
  const banco = aprovadas.find((a) => a.chosen) || [...aprovadas].sort((a, b) => simPriority(a.bank) - simPriority(b.bank))[0];
  if (!banco) return { ok: false, detail: 'o cliente não tem banco aprovado pra simular' };
  if (banco.bank !== 'INTER') return { ok: false, detail: `a simulação de outro prazo só roda sozinha no Inter (o banco aprovado é ${BANKS[banco.bank]?.label || banco.bank})` };
  const aberta = await db.creditAnalysis.findFirst({ where: { leadId, bank: 'INTER', source: SIM_ROW_NOTE, status: { in: ACTIVE }, updatedAt: { gt: new Date(Date.now() - STALE_ACTIVE_MS) } }, select: { id: true } });
  if (aberta) return { ok: false, detail: 'já havia uma simulação em andamento' };
  const anterior = await db.creditOverride.findFirst({ where: { leadId, bank: 'INTER' }, select: { data: true } });
  const data: Record<string, any> = { prazo: String(prazo) };
  if (banco.approvedValue) data.valorEmprestimo = fmtBRL(banco.approvedValue).replace('R$ ', '');
  await setOverrides(db, { accountId, leadId, banks: ['INTER'], data, merge: true });
  await createRequests(db, { accountId, leadIds: [leadId], banks: ['INTER'], dryRun: true, kind: 'RUN', source: SIM_ROW_NOTE, force: true });
  const row = await db.creditAnalysis.findFirst({ where: { leadId, bank: 'INTER', source: SIM_ROW_NOTE, status: 'REQUESTED' }, orderBy: { createdAt: 'desc' }, select: { id: true } });
  if (row) await db.creditAnalysis.update({ where: { id: row.id }, data: { conditions: JSON.stringify({ prazo, anterior: anterior ? anterior.data : null }) } });
  return { ok: true, detail: `simulação de ${prazo}x pedida ao Inter (modo teste, sem enviar proposta)` };
}

/** O teste do portal terminou: devolve o ajuste do Inter ao que era e manda os valores ao cliente (ou avisa a equipe se não deu pra ler). */
async function deliverAiSimulation(db: Db, row: AnalysisRow): Promise<void> {
  let prazo = 0; let anterior: any = null;
  try { const c = JSON.parse(row.conditions || '{}'); prazo = Number(c.prazo) || 0; anterior = c.anterior ?? null; } catch { /* sem dados de volta */ }
  const existing = await db.creditOverride.findFirst({ where: { leadId: row.leadId, bank: 'INTER' } });
  if (anterior && existing) await db.creditOverride.update({ where: { id: existing.id }, data: { data: anterior } });
  else if (existing) await db.creditOverride.delete({ where: { id: existing.id } });
  const nota = (content: string) => db.note.create({ data: { leadId: row.leadId, type: 'COMMENT', content } }).catch(() => {});
  const sim = row.status === 'TEST' ? parseInterSimText(row.detail) : null;
  if (!sim) { await nota(`⚠️ A IA pediu a simulação de ${prazo || '?'}x no Inter, mas não consegui ler os valores do portal (${row.status}: ${String(row.detail || '').slice(0, 220)}). Mande a simulação ao cliente à mão.`); return; }
  const linhas = [
    `Simulação em ${prazo} parcelas (Inter):`,
    sim.primeira ? `• 1ª parcela: ${fmtBRL(sim.primeira)}` : '',
    sim.ultima ? `• Última parcela: ${fmtBRL(sim.ultima)}` : '',
    sim.taxa ? `• Taxa: ${sim.taxa} a.m. + IPCA` : '',
    sim.cet ? `• CET: ${sim.cet}` : '',
    '',
    'Os valores são uma simulação e podem variar um pouco na contratação. Se quiser seguir com esse prazo, é só me avisar.',
  ].filter((l, i, a) => l !== '' || (a[i - 1] !== '' && i < a.length - 1)).join('\n');
  const lead = await db.lead.findUnique({ where: { id: row.leadId }, select: { accountId: true } });
  const { sendOutboundWhatsApp } = require('./message.service') as typeof import('./message.service');
  const r = await sendOutboundWhatsApp({ accountId: lead!.accountId, leadId: row.leadId, content: linhas });
  await nota(r.success ? `🤖 A IA simulou ${prazo}x no Inter (modo teste, nada enviado ao banco) e mandou os valores ao cliente: 1ª parcela ${sim.primeira ? fmtBRL(sim.primeira) : '?'}, última ${sim.ultima ? fmtBRL(sim.ultima) : '?'}.` : `⚠️ Simulei ${prazo}x no Inter (1ª ${sim.primeira ? fmtBRL(sim.primeira) : '?'}, última ${sim.ultima ? fmtBRL(sim.ultima) : '?'}), mas a mensagem ao cliente não saiu: ${(r as any).error || 'falha'}.`);
}

/** Valor de crédito pedido na última análise real (o Credimorar informa em "proposta N, R$ X") — pra saber se o cliente pediu OUTRO valor depois. */
export function lastRunCredit(rows: { detail: string | null }[]): number | null {
  for (const r of rows) {
    const m = /proposta\s+\d+,\s*R\$\s*([\d.]+,\d{2})/i.exec(r.detail || '');
    if (m) return brNumber(m[1]);
  }
  return null;
}

/** A IA da conversa pediu pra RODAR a análise do cliente (ponte: a extensão roda nos bancos). Só vale com a "Análise automática" LIGADA e sem
 *  pausa geral, com o card em Pré-Análise (proposta preenchida) do Home Equity. Banco já rodado vira só consulta (não duplica proposta). */
export async function requestRunForAi(db: Db, accountId: string, leadId: string): Promise<{ ok: boolean; detail: string }> {
  const set = await db.creditAutoSetting.findUnique({ where: { accountId } });
  if (!set?.enabled) return { ok: false, detail: 'a "Análise automática" do CRM está desligada' };
  if (set.paused) return { ok: false, detail: 'a pausa geral das execuções automáticas está ligada' };
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { status: true, archived: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead || lead.status !== 'OPEN' || lead.archived) return { ok: false, detail: 'o card não está aberto' };
  if (!/home equity/i.test(lead.pipeline?.department?.name || '')) return { ok: false, detail: 'só vale para Home Equity' };
  if (!/^pre-?an/.test(normName(lead.stage?.name || ''))) return { ok: false, detail: `o card está em "${lead.stage?.name || '?'}", não na Pré-Análise` };
  // O cliente pode ter pedido OUTRO valor depois da 1ª análise (Aline e Dannilo, 14/10: "queria até 50 mil"): a proposta antiga não vale mais, então roda
  // DE NOVO com o valor do card (ajuste do financiamento nos 3 bancos) — antes o pedido da IA só relia a proposta velha e a "nova análise" nunca acontecia.
  // Pedido de nova análise entra na fila normal (um cliente por vez), não na via livre da IA.
  const cf = (lead.customFields || {}) as Record<string, any>;
  const atual = typeof cf.valor_credito === 'number' ? cf.valor_credito : Number(String(cf.valor_credito ?? '').replace(/[R$\s.]/g, '').replace(',', '.'));
  const antigas = await db.creditAnalysis.findMany({ where: { leadId, dryRun: false, status: { in: REAL_SENT }, createdAt: { gt: new Date(Date.now() - 60 * 86_400_000) } }, orderBy: { createdAt: 'desc' }, take: 12, select: { detail: true } });
  const anterior = lastRunCredit(antigas);
  const mudou = atual > 0 && !!anterior && Math.abs(atual - anterior) / anterior > 0.01;
  if (mudou) {
    await setOverrides(db, { accountId, leadId, banks: BANK_KEYS, merge: true, data: { valorEmprestimo: atual.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) } });
  }
  const r = await createRequests(db, { accountId, leadIds: [leadId], banks: BANK_KEYS, dryRun: false, kind: 'RUN', source: mudou ? 'EXTENSION' : 'AI', force: mudou });
  if (!r.created) return { ok: false, detail: 'já havia análise em andamento' };
  if (mudou) return { ok: true, detail: `o valor pedido mudou (de R$ ${anterior!.toLocaleString('pt-BR')} para R$ ${atual.toLocaleString('pt-BR')}): análise NOVA pedida a ${r.created} banco(s), um cliente por vez` };
  return { ok: true, detail: `pedido enviado a ${r.created} banco(s)${r.consulted.length ? ` (${r.consulted.length} já rodado(s): só consulta)` : ''}` };
}
