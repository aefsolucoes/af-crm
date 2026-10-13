import { PrismaClient } from '@prisma/client';
import { createRequests, setOverrides, parseHolder } from './credit-analysis.service';
import { sendApprovalNoticeNow, previewApprovalNotice } from './approval-notice.service';

/**
 * Análise automática de crédito (Fabio 14/10): assim que o cliente preenche a proposta e a IA do CRM confere que os dados estão
 * certos, as análises rodam sozinhas nos 3 bancos (via extensões). Se o 1º participante vier REPROVADO ou APROVADO A MENOR num
 * banco, roda nesse banco no 2º participante. Quando as respostas assentam, o cliente é avisado de TODAS as opções aprovadas (até 3)
 * para escolher, e a IA do CRM dá o apoio na conversa. Vem DESLIGADA; só entram cards que chegaram na Pré-Análise depois de ligar.
 * O estado de cada cliente fica em campos escondidos do card (_auto*): iniciou, 2º participante já tentado por banco, aviso enviado.
 */
const prisma = new PrismaClient();
type Cf = Record<string, any>;

const BANKS = ['CREDIMORAR', 'CREDITAS', 'INTER'];
const MIN_AFTER_STAGE_MS = 3 * 60_000; // dá tempo da IA do atendimento conferir a proposta antes
const AI_CHECK_EVERY_MS = 4 * 60_000;
const AI_CHECK_MAX = 6;
const NOTICE_QUIET_MS = 10 * 60_000; // espera as respostas assentarem antes de avisar o cliente
const NOTICE_MIN_GAP_MS = 10 * 60_000;
const PROPOSAL_MARKERS = ['Proposta preenchida no site', 'PROPOSTA RECEBIDA', 'Preenchi a proposta', 'Proposta manual'];

const norm = (s: string) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export async function getAutoSetting(accountId: string) {
  const s = await prisma.creditAutoSetting.findUnique({ where: { accountId } });
  return { enabled: !!s?.enabled, enabledAt: s?.enabledAt || null };
}

export async function setAutoSetting(accountId: string, enabled: boolean, userId?: string) {
  const cur = await prisma.creditAutoSetting.findUnique({ where: { accountId } });
  const enabledAt = enabled ? (cur?.enabled && cur.enabledAt ? cur.enabledAt : new Date()) : cur?.enabledAt || null;
  await prisma.creditAutoSetting.upsert({
    where: { accountId },
    create: { accountId, enabled, enabledAt: enabled ? new Date() : null, updatedById: userId || null },
    update: { enabled, enabledAt, updatedById: userId || null },
  });
  return getAutoSetting(accountId);
}

async function saveCf(leadId: string, patch: Cf) {
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, ...patch } } });
}
const addNote = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});

/** A IA confere se a proposta está pronta pra ir pra análise: dados completos e coerentes e nenhuma pergunta pendente ao cliente. */
async function aiReadiness(leadId: string): Promise<{ ready: boolean; reason: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, value: true, customFields: true } });
  const proposal = await prisma.message.findFirst({
    where: { leadId, OR: PROPOSAL_MARKERS.map((m) => ({ content: { contains: m } })) },
    orderBy: { createdAt: 'desc' }, select: { content: true, createdAt: true },
  });
  if (!proposal) return { ready: false, reason: 'ainda não achei a proposta preenchida na conversa' };
  const recent = await prisma.message.findMany({ where: { leadId, createdAt: { gte: proposal.createdAt } }, orderBy: { createdAt: 'asc' }, take: 14, select: { direction: true, content: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const card = ['participante_1', 'cpf_1', 'nascimento_1', 'renda_1', 'email_1', 'telefone_1', 'participante_2', 'cpf_2', 'renda_2', 'valor_imovel', 'valor_credito', 'prazo_financ']
    .map((k) => `${k}: ${cf[k] ?? ''}`).join('\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 400,
      system: `Você é a IA de um correspondente bancário (crédito com garantia de imóvel, Home Equity). Decida se a PROPOSTA do cliente já pode ir para a ANÁLISE DE CRÉDITO nos bancos. Está pronta quando: os dados essenciais estão completos (nome, CPF, nascimento, renda, e-mail, telefone, valor do imóvel, valor do crédito, prazo, endereço do imóvel) e fazem sentido juntos (valores plausíveis, crédito dentro do que o imóvel comporta, nada que pareça erro de preenchimento) e NÃO há pergunta nossa pendente ao cliente sobre o preenchimento, nem ele pediu pra esperar, corrigir ou cancelar. Regras dos bancos (quem recusa é a extensão, não você): crédito mínimo R$ 50 mil; imóvel mínimo R$ 150 mil (Creditas) / R$ 200 mil (Inter); crédito até ~58–60% do valor do imóvel. NÃO questione datas nem escolha de bancos. Responda SÓ com JSON: {"ready":true|false,"reason":"motivo curto em português"}.`,
      messages: [{ role: 'user', content: `PROPOSTA:\n${proposal.content.slice(0, 3500)}\n\nCARD:\n${card}\n\nCONVERSA DEPOIS DA PROPOSTA:\n${recent.map((m) => `${m.direction === 'INBOUND' ? 'CLIENTE' : 'NÓS'}: ${String(m.content).slice(0, 220)}`).join('\n') || '(nada ainda)'}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const data: any = await res.json().catch(() => null);
  const raw = String(data?.content?.find((b: any) => b.type === 'text')?.text || '');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { const j = JSON.parse(m[0]); return { ready: j.ready === true, reason: String(j.reason || '').slice(0, 300) }; } catch { return null; }
}

/** 1) Cards novos na Pré-Análise: a IA confere os dados e, estando certos, pede as análises nos 3 bancos. */
async function startNewLeads(accountId: string, enabledAt: Date) {
  const leads = await prisma.lead.findMany({
    where: {
      accountId, status: 'OPEN', archived: false, isGroup: false, stageEnteredAt: { gte: enabledAt, lte: new Date(Date.now() - MIN_AFTER_STAGE_MS) },
      stage: { name: { startsWith: 'Pré-An', mode: 'insensitive' } },
      pipeline: { department: { name: { contains: 'Home Equity', mode: 'insensitive' } } },
      creditAnalyses: { none: {} },
    },
    select: { id: true, name: true, customFields: true }, take: 30,
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Cf;
    if (cf._autoStartedAt || cf._autoGiveUp) continue;
    if (cf._autoCheckedAt && Date.now() - new Date(cf._autoCheckedAt).getTime() < AI_CHECK_EVERY_MS) continue;
    const checks = Number(cf._autoChecks || 0) + 1;
    const verdict = await aiReadiness(l.id).catch(() => null);
    if (!verdict) { await saveCf(l.id, { _autoCheckedAt: new Date().toISOString() }); continue; }
    if (!verdict.ready) {
      if (checks >= AI_CHECK_MAX) {
        await saveCf(l.id, { _autoChecks: checks, _autoCheckedAt: new Date().toISOString(), _autoGiveUp: true });
        await addNote(l.id, `🤖 Análise automática NÃO iniciada: a IA acha que a proposta precisa de atenção — ${verdict.reason}. Depois de acertar, rode a análise na aba Análise de Crédito.`);
      } else {
        await saveCf(l.id, { _autoChecks: checks, _autoCheckedAt: new Date().toISOString() });
      }
      continue;
    }
    const out = await createRequests(prisma, { accountId, leadIds: [l.id], banks: BANKS, dryRun: false, force: false });
    await saveCf(l.id, { _autoStartedAt: new Date().toISOString(), _autoChecks: checks });
    await addNote(l.id, `🤖 Análise automática iniciada nos 3 bancos (a IA conferiu que os dados da proposta estão certos: ${verdict.reason || 'ok'}). ${out.created} pedido(s) na fila pras extensões.`);
  }
}

/** Em quais bancos rodar no 2º participante: o 1º foi REPROVADO ou APROVADO A MENOR, o 2º ainda não foi tentado nem está rodando.
 *  Sem 2º participante (nome e CPF no card), nada. Pura (testável). */
export function cascadePlan(cf: Cf, leadName: string, analyses: { bank: string; kind: string; status: string; detail: string | null; holderName: string | null }[]): { bank: string; why: string }[] {
  const p2 = String(cf.participante_2 || '').trim();
  const cpf2 = String(cf.cpf_2 || '').replace(/\D/g, '');
  if (!p2 || cpf2.length < 11) return [];
  const main = norm(String(cf.participante_1 || leadName));
  const tried: string[] = Array.isArray(cf._autoP2Banks) ? cf._autoP2Banks : [];
  const isSecond = (a: { holderName: string | null; detail: string | null }) => { const h = a.holderName || parseHolder(a.detail); return !!h && norm(h) !== main; };
  const todo: { bank: string; why: string }[] = [];
  for (const bank of BANKS) {
    if (tried.includes(bank)) continue;
    const rows = analyses.filter((a) => a.bank === bank);
    if (rows.some(isSecond)) continue; // já foi rodado no 2º
    if (rows.some((a) => a.kind === 'RUN' && ['REQUESTED', 'RUNNING'].includes(a.status))) continue; // ainda rodando
    const decided = [...rows].reverse().find((a) => ['APPROVED', 'CONDITIONAL', 'REJECTED'].includes(a.status));
    if (!decided) continue;
    if (decided.status === 'REJECTED') todo.push({ bank, why: 'reprovado' });
    else if (decided.status === 'APPROVED' && /aprovad[oa] a menor/i.test(decided.detail || '')) todo.push({ bank, why: 'aprovado a menor' });
  }
  return todo;
}

/** 2) Cascata: 1º participante reprovado ou aprovado a menor num banco → roda nesse banco no 2º participante (1 vez por banco). */
async function cascadeToSecond(accountId: string) {
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, creditAnalyses: { some: {} } },
    select: { id: true, name: true, customFields: true, creditAnalyses: { where: { dryRun: false }, orderBy: { createdAt: 'asc' } } },
    take: 80,
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Cf;
    if (!cf._autoStartedAt) continue;
    const p2 = String(cf.participante_2 || '').trim();
    const todo = cascadePlan(cf, l.name, l.creditAnalyses);
    const tried: string[] = Array.isArray(cf._autoP2Banks) ? cf._autoP2Banks : [];
    if (!todo.length) continue;
    const banks = todo.map((t) => t.bank);
    await setOverrides(prisma, { accountId, leadId: l.id, banks, data: { inverter: true }, merge: true, userName: 'Análise automática' });
    const out = await createRequests(prisma, { accountId, leadIds: [l.id], banks, dryRun: false, force: true });
    await saveCf(l.id, { _autoP2Banks: Array.from(new Set([...tried, ...banks])) });
    const label: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
    await addNote(l.id, `🤖 ${todo.map((t) => `${label[t.bank]} (1º participante ${t.why})`).join(', ')} → rodando no 2º participante, ${p2}. ${out.created} pedido(s) na fila.`);
  }
}

/** 3) Quando as respostas assentam, avisa o cliente de todas as opções aprovadas (até 3) pra ele escolher. A IA do CRM dá o apoio. */
async function noticeClients(accountId: string, io: any) {
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, creditAnalyses: { some: { status: { in: ['APPROVED', 'CONDITIONAL'] }, dryRun: false } } },
    select: { id: true, name: true, customFields: true, creditAnalyses: { where: { dryRun: false }, orderBy: { updatedAt: 'desc' }, select: { kind: true, status: true, updatedAt: true, bank: true, approvedValue: true, holderName: true } } },
    take: 80,
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Cf;
    if (!cf._autoStartedAt) continue;
    const rows = l.creditAnalyses;
    if (rows.some((a) => a.kind === 'RUN' && ['REQUESTED', 'RUNNING'].includes(a.status))) continue; // ainda tem análise rodando
    const last = rows[0]?.updatedAt;
    if (!last || Date.now() - last.getTime() < NOTICE_QUIET_MS) continue;
    if (cf._autoNoticeAt && Date.now() - new Date(cf._autoNoticeAt).getTime() < NOTICE_MIN_GAP_MS) continue;
    const preview = await previewApprovalNotice(l.id).catch(() => null);
    if (!preview || preview.warnings.length) continue; // nenhuma aprovada com valor, ou ainda faltam as parcelas da nova simulação
    const sig = rows.filter((a) => ['APPROVED', 'CONDITIONAL'].includes(a.status) && a.approvedValue).map((a) => `${a.bank}:${a.approvedValue}:${a.holderName || ''}`).sort().join('|');
    if (cf._autoNoticeSig === sig) continue;
    const out = await sendApprovalNoticeNow({ accountId, leadId: l.id, io });
    if (!out.ok) { console.warn(`[Análise automática] ${l.name}: aviso não enviado — ${out.error}`); continue; }
    await saveCf(l.id, { _autoNoticeSig: sig, _autoNoticeAt: new Date().toISOString() });
    await prisma.lead.update({ where: { id: l.id }, data: { aiAutoReplyActive: true } }).catch(() => {});
  }
}

let running = false;
/** Roda a cada minuto (index.ts). Só mexe em conta com a chave "Análise automática" LIGADA. */
export async function processCreditAutomation(io: any): Promise<void> {
  if (running) return;
  running = true;
  try {
    const settings = await prisma.creditAutoSetting.findMany({ where: { enabled: true, enabledAt: { not: null } } });
    for (const s of settings) {
      await startNewLeads(s.accountId, s.enabledAt!).catch((e) => console.error('[Análise automática] início:', e?.message));
      await cascadeToSecond(s.accountId).catch((e) => console.error('[Análise automática] 2º participante:', e?.message));
      await noticeClients(s.accountId, io).catch((e) => console.error('[Análise automática] aviso:', e?.message));
    }
  } finally {
    running = false;
  }
}
