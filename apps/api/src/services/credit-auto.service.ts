import { PrismaClient } from '@prisma/client';
import { createRequests, setOverrides, parseHolder } from './credit-analysis.service';
import { sendApprovalNoticeNow, previewApprovalNotice, novoBancoPendente, sendRejectionNoticeNow, markRejectedAndMove, buildRejectionText, aprovadasSemNumeros } from './approval-notice.service';

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
  return { enabled: !!s?.enabled, enabledAt: s?.enabledAt || null, paused: !!s?.paused };
}

/** Pausa geral: nada roda sozinho (nem a análise automática do CRM, nem as reconferências, nem as extensões por conta própria). */
export async function setPaused(accountId: string, paused: boolean, userId?: string) {
  await prisma.creditAutoSetting.upsert({
    where: { accountId },
    create: { accountId, enabled: false, paused, updatedById: userId || null },
    update: { paused, updatedById: userId || null },
  });
  return getAutoSetting(accountId);
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
      system: `Você é a IA de um correspondente bancário (crédito com garantia de imóvel, Home Equity). Decida se a PROPOSTA do cliente já pode ir para a ANÁLISE DE CRÉDITO nos bancos. Está pronta quando: os dados essenciais estão completos (nome, CPF, nascimento, renda, e-mail, telefone, valor do imóvel, valor do crédito, prazo, endereço do imóvel) e fazem sentido juntos (valores plausíveis, crédito dentro do que o imóvel comporta, nada que pareça erro de preenchimento) e NÃO há pergunta nossa pendente ao cliente sobre o preenchimento, nem ele pediu pra esperar, corrigir ou cancelar. Regras dos bancos (quem recusa é a extensão, não você): crédito mínimo R$ 50 mil; imóvel mínimo R$ 150 mil (Creditas) / R$ 200 mil (Inter) / R$ 144 mil se for TERRENO no Santander; crédito até ~58–60% do valor do imóvel. Esses limites NÃO são motivo pra dizer que a proposta não está pronta: cada banco recusa só o seu limite e os outros seguem (Solange 14/10: a IA barrou a proposta toda por causa do mínimo de 2 bancos) — marque ready=false só por dado faltando, incoerente ou pergunta pendente. NÃO questione datas nem escolha de bancos. Responda SÓ com JSON: {"ready":true|false,"reason":"motivo curto em português"}.`,
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
    select: { id: true, name: true, customFields: true }, orderBy: { stageEnteredAt: 'asc' }, take: 30, // por ordem de entrada na Pré-Análise (Fabio 14/10)
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

const PRIORIDADE_BANCOS = ['INTER', 'CREDITAS', 'CREDIMORAR']; // mesma ordem fixa dos PDFs: Inter > Creditas > Santander
/** O aprovado de MAIOR prioridade é valor TOTAL (não "a menor") e tem os números completos, e os bancos acima dele na ordem já responderam? Pura (testável). */
export function avisoCedo(rows: VRow[] & { approvedValue?: number | null; firstInstallment?: number | null }[]): boolean {
  const aprovados = (rows as any[]).filter((a) => (a.status === 'APPROVED' || a.status === 'CONDITIONAL') && a.approvedValue && a.firstInstallment && !/aprovad[oa] a menor/i.test(a.detail || ''));
  if (!aprovados.length) return false;
  const melhor = [...aprovados].sort((a, b) => PRIORIDADE_BANCOS.indexOf(a.bank) - PRIORIDADE_BANCOS.indexOf(b.bank))[0];
  const acima = PRIORIDADE_BANCOS.slice(0, PRIORIDADE_BANCOS.indexOf(melhor.bank));
  return acima.every((b) => bankVerdict(rows as any, b) !== 'PENDING');
}

/** 3) Quando as respostas assentam, avisa o cliente de todas as opções aprovadas (até 3) pra ele escolher. A IA do CRM dá o apoio. */
async function noticeClients(accountId: string, io: any) {
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, creditAnalyses: { some: { status: { in: ['APPROVED', 'CONDITIONAL'] }, dryRun: false } } },
    select: { id: true, name: true, customFields: true, creditAnalyses: { where: { dryRun: false }, orderBy: { updatedAt: 'desc' }, select: { kind: true, status: true, updatedAt: true, createdAt: true, bank: true, approvedValue: true, firstInstallment: true, holderName: true, detail: true, source: true } } },
    take: 80,
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Cf;
    // Card que a análise automática NÃO iniciou também entra, se o cliente já recebeu um resumo e agora saiu o resultado de OUTRO banco (Juan, 14/10).
    if (!cf._autoStartedAt && !(await novoBancoPendente(l.id).catch(() => false))) continue;
    const rows = l.creditAnalyses;
    // Aviso IMEDIATO (Fabio 14/10: "o Inter é o primeiro banco e foi aprovado o valor total, por que não avisou?"): quando o banco de MAIOR prioridade entre os aprovados
    // aprovou o valor TOTAL com os números completos e todos os bancos acima dele na ordem já responderam, não espera os de baixo — se algum deles aprovar depois, sai o aviso de "mais um banco".
    if (!avisoCedo(rows as any)) {
      if (rows.some((a) => a.kind === 'RUN' && ['REQUESTED', 'RUNNING'].includes(a.status))) continue; // ainda tem análise rodando
      const last = rows[0]?.updatedAt;
      if (!last || Date.now() - last.getTime() < NOTICE_QUIET_MS) continue;
    }
    if (cf._autoNoticeAt && Date.now() - new Date(cf._autoNoticeAt).getTime() < NOTICE_MIN_GAP_MS) continue;
    // Aprovação SEM números (a extensão ainda não leu): segura o aviso e pede a leitura — senão sai só a outra opção (Alexandre/Larissa, 14/10).
    const semNum = await aprovadasSemNumeros(l.id).catch(() => [] as string[]);
    if (semNum.length) {
      const jaPedido = await prisma.creditAnalysis.findFirst({ where: { leadId: l.id, kind: 'CHECK', bank: { in: semNum }, OR: [{ status: { in: ['REQUESTED', 'RUNNING'] } }, { createdAt: { gte: new Date(Date.now() - 10 * 60_000) } }] }, select: { id: true } });
      if (!jaPedido) await createRequests(prisma, { accountId, leadIds: [l.id], banks: semNum, dryRun: false, kind: 'CHECK' });
      continue;
    }
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

/** Falha OBJETIVA (regra do banco/imóvel), não técnica: "NÃO RODEI: … abaixo do mínimo / terreno / saldo devedor", "Não conformidade…". */
const OBJECTIVE_FAIL = /N[ÃA]O RODEI|n[aã]o conformidade|recusou antes de consultar/i;
type VRow = { bank: string; kind: string; status: string; detail: string | null; createdAt: Date; source: string };

/** Resposta de um banco: NEG = não vai (reprovou ou a regra dele barrou), POS = aprovou, PENDING = falta resposta / falha técnica a refazer. A última rodada decide;
 *  conferência sem leitura ("conferir") não conta. Pura (testável). */
export function bankVerdict(rows: VRow[], bank: string): 'NEG' | 'POS' | 'PENDING' {
  const mine = rows.filter((r) => r.bank === bank && r.source !== 'AI_SIM' && !(r.kind === 'CHECK' && r.status === 'CHECK')).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const r = mine[0];
  if (!r) return 'PENDING';
  if (r.status === 'APPROVED' || r.status === 'CONDITIONAL') return 'POS';
  if (r.status === 'REJECTED') return 'NEG';
  if (r.status === 'FAILED' && OBJECTIVE_FAIL.test(r.detail || '')) return 'NEG';
  return 'PENDING';
}

/** 4) Os 3 bancos responderam NÃO (reprovou ou a regra do banco/imóvel barrou): avisa o cliente que retornou reprovado e tira o card da Pré-Análise (Reprovado → Perdidos),
 *  senão a fila acumula (Fabio 14/10). Falha técnica (extensão, dado faltando) NÃO conta: essa fica pra refazer. */
async function closeRejected(accountId: string, io: any) {
  const leads = await prisma.lead.findMany({
    where: {
      accountId, status: 'OPEN', archived: false, isGroup: false,
      stage: { name: { startsWith: 'Pré-An', mode: 'insensitive' } },
      pipeline: { department: { name: { contains: 'Home Equity', mode: 'insensitive' } } },
      creditAnalyses: { some: { dryRun: false } },
    },
    select: { id: true, name: true, customFields: true, creditAnalyses: { where: { dryRun: false }, orderBy: { createdAt: 'asc' }, select: { bank: true, kind: true, status: true, detail: true, createdAt: true, updatedAt: true, holderName: true, source: true } } },
    orderBy: { createdAt: 'asc' }, take: 80,
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Cf;
    if (cf._noticeAt) continue; // aviso já agendado (o poller dos agendados fecha depois de enviar)
    if (cf._autoCloseTriedAt && Date.now() - new Date(cf._autoCloseTriedAt).getTime() < 6 * 3_600_000) continue;
    const rows = l.creditAnalyses;
    if (BANKS.some((b) => bankVerdict(rows, b) !== 'NEG')) continue;
    const last = Math.max(...rows.map((r) => r.updatedAt.getTime()));
    if (Date.now() - last < 2 * 60_000) continue; // resultado final dos 3 bancos: só uma folga curta pra conferências em andamento
    if (cascadePlan(cf, l.name, rows as any).length) continue; // ainda falta rodar no 2º participante
    // Desqualificado x Reprovado: se NENHUM banco chegou a reprovar (todas as respostas são regra do banco/imóvel — mínimo, terreno, saldo devedor), o lead não atende
    // aos critérios → "desqualificado". Basta um banco ter reprovado de verdade → "reprovado".
    const ultima = (b: string) => rows.filter((r) => r.bank === b && r.source !== 'AI_SIM' && !(r.kind === 'CHECK' && r.status === 'CHECK')).sort((a, c) => c.createdAt.getTime() - a.createdAt.getTime())[0];
    const desqualificado = BANKS.every((b) => ultima(b)?.status === 'FAILED');
    const out = await sendRejectionNoticeNow({ accountId, leadId: l.id, io });
    if (out.scheduled) { await saveCf(l.id, { _autoCloseAfterNotice: desqualificado ? 'DESQ' : true }); continue; } // fora das 07h–21h: o aviso sai às 07:00 e o poller dos agendados fecha o card
    if (!out.ok) {
      await saveCf(l.id, { _autoCloseTriedAt: new Date().toISOString() });
      console.warn(`[Análise automática] ${l.name}: reprovado, mas o aviso não saiu — ${out.error}`);
      continue;
    }
    const built = await buildRejectionText(l.id).catch(() => null);
    await markRejectedAndMove({ accountId, leadId: l.id, io, disqualify: desqualificado, motivo: `Reprovado nos bancos${built?.reasons.length ? ' — ' + built.reasons.join('; ') : ''}`.slice(0, 280) }).catch((e: any) => console.error('[Análise automática] mover reprovado:', e?.message));
  }
}

/** 6) Confirmação da proposta que NÃO saiu: o e-mail do formulário do site chega segundos ANTES do WhatsApp do cliente — a automação da Pré-Análise tenta falar sem a janela de 24 h
 *  aberta e falha, e depois ninguém tentava de novo (Mauricio, 14/10: a IA "não respondeu"). Quando o cliente já escreveu no WhatsApp e ninguém respondeu, roda a etapa de novo (1x por card). */
async function ackPendingProposals(accountId: string, io: any) {
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, isGroup: false, stage: { name: { startsWith: 'Pré-An', mode: 'insensitive' } }, stageEnteredAt: { gte: new Date(Date.now() - 3 * 3_600_000) } },
    select: { id: true, name: true, stageId: true, customFields: true }, take: 50,
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Cf;
    if (cf._ackRetryAt) continue;
    const email = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'INBOUND', channel: 'EMAIL', content: { startsWith: '📋 Proposta preenchida no site' } }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } });
    if (!email || Date.now() - email.createdAt.getTime() < 90_000) continue; // dá tempo do fluxo normal
    const wa = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'INBOUND', channel: 'WHATSAPP', createdAt: { gt: email.createdAt } }, select: { id: true } });
    if (!wa) continue;
    const ack = await prisma.message.findFirst({ where: { leadId: l.id, direction: 'OUTBOUND', channel: 'WHATSAPP', createdAt: { gt: email.createdAt } }, select: { id: true } });
    if (ack) continue;
    await saveCf(l.id, { _ackRetryAt: new Date().toISOString() });
    const { runAutomations } = require('./automation.service') as typeof import('./automation.service');
    await runAutomations({ accountId, trigger: 'STAGE_CHANGE', leadId: l.id, io, context: { newStageId: l.stageId } }).catch(() => {});
    await addNote(l.id, '🤖 A confirmação "Recebi sua proposta" não tinha saído (o e-mail do formulário chegou antes do WhatsApp do cliente): enviada agora.');
  }
}

const RETRY_MAX = 3;
const RETRY_GAP_MS = 15 * 60_000;

/** 5) Falha TÉCNICA (extensão travou, tela não carregou, dado faltando) não deixa o cliente parado na Pré-Análise: refaz sozinho o banco que falhou, até 3 vezes, de 15 em
 *  15 min (Fabio 14/10: "como faz pros clientes que falhou rodar sozinha depois?"). Falha OBJETIVA (regra do banco/imóvel) e "rodada anulada" não entram — essas são decisão. */
async function retryTechnicalFailures(accountId: string) {
  const leads = await prisma.lead.findMany({
    where: {
      accountId, status: 'OPEN', archived: false, isGroup: false,
      stage: { name: { startsWith: 'Pré-An', mode: 'insensitive' } },
      pipeline: { department: { name: { contains: 'Home Equity', mode: 'insensitive' } } },
      creditAnalyses: { some: { dryRun: false } },
    },
    select: { id: true, name: true, customFields: true, creditAnalyses: { where: { dryRun: false }, orderBy: { createdAt: 'asc' }, select: { bank: true, kind: true, status: true, detail: true, createdAt: true, updatedAt: true, source: true } } },
    orderBy: { createdAt: 'asc' }, take: 80,
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Cf;
    const rows = l.creditAnalyses;
    if (cf._noticeAt || rows.some((r) => r.status === 'REQUESTED' || r.status === 'RUNNING')) continue;
    const retries: Record<string, { n: number; at: string; gaveUp?: boolean }> = { ...(cf._autoRetries || {}) };
    const redo: string[] = [];
    const redoCheck = new Set<string>(); // bancos cuja ÚLTIMA linha era uma CONFERÊNCIA que falhou: refaz a conferência, NUNCA cria proposta nova
    const gaveUp: string[] = [];
    for (const b of BANKS) {
      const r = rows.filter((x) => x.bank === b && x.source !== 'AI_SIM' && !(x.kind === 'CHECK' && x.status === 'CHECK')).sort((a, c) => c.createdAt.getTime() - a.createdAt.getTime())[0];
      if (!r) continue;
      const tecnica = (r.status === 'FAILED' && !OBJECTIVE_FAIL.test(r.detail || '')) || r.status === 'INCOMPLETE';
      if (!tecnica || /RODADA ANULADA/i.test(r.detail || '')) continue;
      const st = retries[b] || { n: 0, at: '' };
      if (st.gaveUp || Date.now() - r.updatedAt.getTime() < RETRY_GAP_MS) continue;
      if (st.n >= RETRY_MAX) { retries[b] = { ...st, gaveUp: true }; gaveUp.push(b); continue; }
      retries[b] = { n: st.n + 1, at: new Date().toISOString() };
      redo.push(b);
      if (r.kind === 'CHECK') redoCheck.add(b);
    }
    const label: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };
    if (redo.length) {
      const runBanks = redo.filter((b) => !redoCheck.has(b));
      if (runBanks.length) await createRequests(prisma, { accountId, leadIds: [l.id], banks: runBanks, dryRun: false, force: true });
      if (redoCheck.size) await createRequests(prisma, { accountId, leadIds: [l.id], banks: [...redoCheck], dryRun: false, kind: 'CHECK' });
      await saveCf(l.id, { _autoRetries: retries });
      await addNote(l.id, `🤖 Falha técnica na análise (${redo.map((b) => label[b]).join(', ')}): refazendo sozinha — tentativa ${Math.max(...redo.map((b) => retries[b].n))} de ${RETRY_MAX}.`);
    } else if (gaveUp.length) {
      await saveCf(l.id, { _autoRetries: retries });
      await addNote(l.id, `⚠️ ${gaveUp.map((b) => label[b]).join(', ')} falhou ${RETRY_MAX} vezes seguidas por problema técnico: precisa de olhada (botão "Rodar" ou "Ajustar").`);
    }
  }
}

let running = false;
/** Roda a cada minuto (index.ts). Só mexe em conta com a chave "Análise automática" LIGADA. */
export async function processCreditAutomation(io: any): Promise<void> {
  if (running) return;
  running = true;
  try {
    const settings = await prisma.creditAutoSetting.findMany({ where: { enabled: true, paused: false, enabledAt: { not: null } } });
    for (const s of settings) {
      await startNewLeads(s.accountId, s.enabledAt!).catch((e) => console.error('[Análise automática] início:', e?.message));
      await cascadeToSecond(s.accountId).catch((e) => console.error('[Análise automática] 2º participante:', e?.message));
      await noticeClients(s.accountId, io).catch((e) => console.error('[Análise automática] aviso:', e?.message));
      await closeRejected(s.accountId, io).catch((e) => console.error('[Análise automática] fechar reprovados:', e?.message));
      await retryTechnicalFailures(s.accountId).catch((e) => console.error('[Análise automática] refazer falhas técnicas:', e?.message));
      await ackPendingProposals(s.accountId, io).catch((e) => console.error('[Análise automática] confirmação da proposta:', e?.message));
    }
  } finally {
    running = false;
  }
}
