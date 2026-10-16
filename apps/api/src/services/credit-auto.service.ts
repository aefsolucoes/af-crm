import { PrismaClient } from '@prisma/client';
import { createRequests, setOverrides, parseHolder } from './credit-analysis.service';
import { sendApprovalNoticeNow, sendEarlyStatusNotice, previewApprovalNotice, novoBancoPendente, sendRejectionNoticeNow, markRejectedAndMove, buildRejectionText, aprovadasSemNumeros } from './approval-notice.service';

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
      model: 'claude-sonnet-5', max_tokens: 2000,
      system: `Você é a IA de um correspondente bancário (crédito com garantia de imóvel, Home Equity). Decida se a PROPOSTA do cliente já pode ir para a ANÁLISE DE CRÉDITO nos bancos. Está pronta quando: os dados essenciais estão completos (nome, CPF, nascimento, renda, e-mail, telefone, valor do imóvel, valor do crédito, prazo, endereço do imóvel) e fazem sentido juntos (valores plausíveis, crédito dentro do que o imóvel comporta, nada que pareça erro de preenchimento) e NÃO há pergunta nossa pendente ao cliente sobre o preenchimento, nem ele pediu pra esperar, corrigir ou cancelar. Pergunta pendente sobre a DOCUMENTAÇÃO do imóvel (habite-se, certidão de ônus, matrícula, escritura) ou qualquer dúvida que não muda os dados da proposta NÃO segura a análise: isso é da fase de documentação (Eva, 14/10: ficou 1 h parada esperando a resposta do habite-se). Regras dos bancos (quem recusa é a extensão, não você): crédito mínimo R$ 50 mil; imóvel mínimo R$ 150 mil (Creditas) / R$ 200 mil (Inter) / R$ 144 mil se for TERRENO no Santander; crédito até ~58–60% do valor do imóvel. Esses limites NÃO são motivo pra dizer que a proposta não está pronta: cada banco recusa só o seu limite e os outros seguem (Solange 14/10: a IA barrou a proposta toda por causa do mínimo de 2 bancos) — marque ready=false só por dado faltando, incoerente ou pergunta pendente. NÃO questione datas nem escolha de bancos. Responda SÓ com JSON: {"ready":true|false,"reason":"motivo curto em português"}.`,
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
    if (cf._autoPaused) continue; // cliente PAUSADO pelo botão da tela: nada automático (rodar, refazer, 2º participante, avisos, fechar)
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

/** Em quais bancos rodar no 2º participante: o 1º foi REPROVADO, APROVADO A MENOR ou já foi ENVIADO e o resultado está pendente (roda sem esperar), e o 2º ainda não foi tentado nem está rodando.
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
    if (decided) {
      if (decided.status === 'REJECTED') todo.push({ bank, why: 'reprovado' });
      else if (decided.status === 'APPROVED' && /aprovad[oa] a menor/i.test(decided.detail || '')) todo.push({ bank, why: 'aprovado a menor' });
      continue; // aprovado no valor total: não precisa do 2º
    }
    // SEM esperar a resposta do 1º (Fabio 15/10: "roda 1 e depois roda outro, sem aguardar a resposta do primeiro"): o 1º já foi ENVIADO ao banco e o resultado demora
    // (Creditas leva horas) — o 2º participante entra na fila agora, atrás dele. Falha por regra do imóvel (mínimo, terreno, saldo devedor) NÃO entra: vale igual pro 2º.
    const ultimaRodada = [...rows].reverse().find((a) => a.kind === 'RUN');
    if (ultimaRodada && ultimaRodada.status === 'SENT') todo.push({ bank, why: 'aguardando o resultado (o 2º roda sem esperar)' });
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
    if (cf._autoPaused) continue; // cliente PAUSADO pelo botão da tela: nada automático (rodar, refazer, 2º participante, avisos, fechar)
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
    if (cf._autoPaused) continue; // cliente PAUSADO pelo botão da tela: nada automático (rodar, refazer, 2º participante, avisos, fechar)
    // Card que a análise automática NÃO iniciou também entra, se o cliente já recebeu um resumo e agora saiu o resultado de OUTRO banco (Juan, 14/10).
    if (!cf._autoStartedAt && !(await novoBancoPendente(l.id).catch(() => false))) continue;
    const rows = l.creditAnalyses;
    // Aviso IMEDIATO (Fabio 14/10: "o Inter é o primeiro banco e foi aprovado o valor total, por que não avisou?"): quando o banco de MAIOR prioridade entre os aprovados
    // aprovou o valor TOTAL com os números completos e todos os bancos acima dele na ordem já responderam, não espera os de baixo — se algum deles aprovar depois, sai o aviso de "mais um banco".
    // Os 3 bancos já responderam (aprovou/reprovou/regra barrou) e há aprovação: não tem mais nada a esperar — avisa NA HORA, sem os 10 min de silêncio (Eva, 14/10: Santander aprovou
    // a menor, Creditas e Inter desqualificaram e o aviso ficou parado esperando).
    const todosDecididos = BANKS.every((b) => bankVerdict(rows as any, b) !== 'PENDING');
    if (!avisoCedo(rows as any) && !todosDecididos) {
      if (rows.some((a) => a.kind === 'RUN' && ['REQUESTED', 'RUNNING'].includes(a.status))) continue; // ainda tem análise rodando
      // O silêncio conta só o que JÁ ASSENTOU: conferência ainda rodando (Creditas leva horas) atualiza a linha a cada 10 min e o aviso da aprovação que já saiu nunca chegava (Azevedo, 14/10).
      const last = rows.filter((a) => !(a.kind === 'CHECK' && ['REQUESTED', 'RUNNING'].includes(a.status)))[0]?.updatedAt;
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
    // Nome do titular normalizado (só o 1º nome) e sem repetição: o portal às vezes devolve "Danilo Bezerra" e outras "Danilo Bezerra cortes" — isso mudava a assinatura e reenviava o aviso (Maria Antônia, 15/10).
    const nomeCurto = (n: string | null) => { const t = String(n || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/\s+/).filter((w) => w && !['de', 'da', 'do', 'dos', 'das', 'e'].includes(w)); return t[0] || ''; };
    const sig = Array.from(new Set(rows.filter((a) => ['APPROVED', 'CONDITIONAL'].includes(a.status) && a.approvedValue).map((a) => `${a.bank}:${a.approvedValue}:${nomeCurto(a.holderName)}`))).sort().join('|');
    const sigAntiga = rows.filter((a) => ['APPROVED', 'CONDITIONAL'].includes(a.status) && a.approvedValue).map((a) => `${a.bank}:${a.approvedValue}:${a.holderName || ''}`).sort().join('|'); // formato antigo: não reenvia pra quem já tinha aviso gravado
    if (cf._autoNoticeSig === sig || cf._autoNoticeSig === sigAntiga) continue;
    const out = await sendApprovalNoticeNow({ accountId, leadId: l.id, io, holdForPdf: true }); // aviso automático: o PDF da simulação sai junto (Fabio 15/10)
    if (out.waiting) continue; // PDF ainda sendo gerado: tenta de novo no próximo minuto
    if (out.already) { // a conversa já tem esse aviso (equipe, IA ou aviso anterior): não duplica e não tenta de novo a cada minuto
      await saveCf(l.id, { _autoNoticeSig: sig, _autoNoticeAt: new Date().toISOString() });
      await addNote(l.id, `ℹ️ Aviso de aprovação NÃO reenviado: ${out.error}`);
      continue;
    }
    if (!out.ok) { console.warn(`[Análise automática] ${l.name}: aviso não enviado — ${out.error}`); continue; }
    await saveCf(l.id, { _autoNoticeSig: sig, _autoNoticeAt: new Date().toISOString() });
    await prisma.lead.update({ where: { id: l.id }, data: { aiAutoReplyActive: true } }).catch(() => {});
  }
}

/** Falha OBJETIVA (regra do banco/imóvel), não técnica: "NÃO RODEI: … abaixo do mínimo / terreno / saldo devedor", "Não conformidade…". */
const OBJECTIVE_FAIL = /N[ÃA]O RODEI|n[aã]o conformidade|recusou antes de consultar|CPF j[aá] possui uma proposta ativa na Creditas/i;
/** Creditas: "Este CPF já possui uma proposta ativa … ela NÃO está na lista de Propostas da nossa conta" (Fabio 15/10, Arlan): não tem como rodar na Creditas — conta como NÃO desse banco
 *  (se os outros também não deram, o cliente é avisado e vai pra Perdido; se algum aprovou, o aviso de aprovação sai sem esperar a Creditas). */
const CREDITAS_CPF_ATIVO = /CPF j[aá] possui uma proposta ativa na Creditas/i;
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
  if (bank === 'CREDITAS' && CREDITAS_CPF_ATIVO.test(r.detail || '')) return 'NEG'; // conferir/"verificar" com esse aviso: não tem como rodar
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
    if (cf._autoPaused) continue; // cliente PAUSADO pelo botão da tela: nada automático (rodar, refazer, 2º participante, avisos, fechar)
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
    if (out.already) await addNote(l.id, `ℹ️ Aviso de negativa NÃO reenviado: ${out.error}`); // já foi avisado: segue pro fechamento do card, sem duplicar a mensagem
    if (!out.ok && !out.already) {
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
    if (cf._autoPaused) continue; // Stop total do cliente
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
    select: { id: true, name: true, customFields: true, creditAnalyses: { where: { dryRun: false }, orderBy: { createdAt: 'asc' }, select: { bank: true, kind: true, status: true, detail: true, createdAt: true, updatedAt: true, source: true, proposalNumber: true } } },
    orderBy: { createdAt: 'asc' }, take: 80,
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Cf;
    if (cf._autoPaused) continue; // cliente PAUSADO pelo botão da tela: nada automático (rodar, refazer, 2º participante, avisos, fechar)
    const rows = l.creditAnalyses;
    if (cf._noticeAt) continue;
    // Só barra o banco que ainda tem pedido aberto: a conferência do Creditas (horas) não pode segurar a nova tentativa do Inter (Mauricio Rodrigues, 14/10).
    const aberto = (b: string) => rows.some((r) => r.bank === b && (r.status === 'REQUESTED' || r.status === 'RUNNING'));
    const retries: Record<string, { n: number; at: string; gaveUp?: boolean }> = { ...(cf._autoRetries || {}) };
    const redo: string[] = [];
    const redoCheck = new Set<string>(); // bancos cuja ÚLTIMA linha era uma CONFERÊNCIA que falhou: refaz a conferência, NUNCA cria proposta nova
    const gaveUp: string[] = [];
    for (const b of BANKS) {
      const r = rows.filter((x) => x.bank === b && x.source !== 'AI_SIM' && !(x.kind === 'CHECK' && x.status === 'CHECK')).sort((a, c) => c.createdAt.getTime() - a.createdAt.getTime())[0];
      if (!r || aberto(b)) continue;
      const tecnica = (r.status === 'FAILED' && !OBJECTIVE_FAIL.test(r.detail || '')) || r.status === 'INCOMPLETE';
      if (!tecnica || /RODADA ANULADA/i.test(r.detail || '')) continue;
      const st = retries[b] || { n: 0, at: '' };
      if (st.gaveUp || Date.now() - r.updatedAt.getTime() < RETRY_GAP_MS) continue;
      if (st.n >= RETRY_MAX) { retries[b] = { ...st, gaveUp: true }; gaveUp.push(b); continue; }
      retries[b] = { n: st.n + 1, at: new Date().toISOString() };
      redo.push(b);
      // Falha de um RODAR que já tinha ENVIADO a proposta ao banco (teto de tempo/extensão travada depois do envio): refazer como RODAR criaria proposta DUPLICADA no portal.
      if (r.kind === 'CHECK' || r.proposalNumber || /proposta (j[aá] )?enviada|lendo o resultado/i.test(r.detail || '')) redoCheck.add(b);
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
/** Inter marcado como "ENVIADO" SEM número de proposta (Fabio 14/10, Mauricio de Azevedo): no portal o cliente estava só como RASCUNHO — a extensão leu a linha de
 *  outro cliente na lista e deu a rodada como enviada. Só AVISA (nota no card, uma vez por rodada); NÃO roda nada sozinho: a equipe confere no portal e, se for erro,
 *  manda "Rodar de novo" no cartão do Inter. Só o Inter: ele sempre devolve número; o Creditas não devolve, então SEM número não é sinal de erro lá. */
async function flagInterSemNumero(accountId: string) {
  const rows = await prisma.creditAnalysis.findMany({
    where: {
      accountId, bank: 'INTER', kind: 'RUN', status: 'SENT', proposalNumber: null, dryRun: false, source: { notIn: ['AI', 'AI_SIM', 'MANUAL'] },
      updatedAt: { gte: new Date(Date.now() - 24 * 3_600_000), lte: new Date(Date.now() - 3 * 60_000) }, // 3 min de folga: o número pode chegar logo depois
      lead: { status: 'OPEN', archived: false },
    },
    select: { id: true, leadId: true, createdAt: true, lead: { select: { name: true, customFields: true } } },
    take: 50,
  });
  for (const r of rows) {
    const cf = (r.lead?.customFields || {}) as Cf;
    const avisados: string[] = Array.isArray(cf._interSemNumero) ? cf._interSemNumero : [];
    if (avisados.includes(r.id)) continue;
    // Uma rodada/conferência POSTERIOR do Inter já trouxe o número: está tudo certo.
    const depois = await prisma.creditAnalysis.count({ where: { leadId: r.leadId, bank: 'INTER', dryRun: false, proposalNumber: { not: null }, status: { notIn: ['FAILED'] }, createdAt: { gt: r.createdAt } } });
    await saveCf(r.leadId, { _interSemNumero: [...avisados, r.id].slice(-10) });
    if (depois) continue;
    // Regra do Fabio (14/10): se já rodou 2 vezes e deu o MESMO sinal, NÃO rodar de novo — aguardar a conferência ver se o resultado sai.
    const vezes = await prisma.creditAnalysis.count({ where: { leadId: r.leadId, bank: 'INTER', kind: 'RUN', status: 'SENT', proposalNumber: null, dryRun: false, source: { notIn: ['AI', 'AI_SIM', 'MANUAL'] } } });
    await addNote(r.leadId, vezes >= 2
      ? '⚠️ Inter: já foi rodado 2 vezes e as duas constam como ENVIADAS sem número de proposta. NÃO rodar de novo: aguardar a conferência (segue lendo o portal) pra ver se o resultado sai.'
      : '⚠️ Inter: a rodada consta como ENVIADA, mas SEM número de proposta — no portal o cliente pode estar só como rascunho (a proposta pode não ter sido criada). Confira no portal do Inter; se for erro, use "Rodar de novo" no cartão do Inter na Análise de Crédito.');
    console.warn(`[Análise automática] ${r.lead?.name}: Inter enviado sem número de proposta — nota de aviso criada`);
  }
}

const INTER_GESTORA_EMAIL = 'vania.tavares@inter.co'; // Vania da Silva Said Tavares — gestora do Inter que resolve proposta travada e vincula o cadastro (Fabio 15/10)

/** Lê a ficha da proposta do cliente (mensagem "Nome completo: … CPF: …" mais recente no card): pares "Rótulo: valor". */
function parseFicha(text: string): { label: string; value: string }[] {
  return text.split('\n').map((l) => l.trim()).map((l) => { const i = l.indexOf(':'); return i > 0 && i < 48 ? { label: l.slice(0, i).trim(), value: l.slice(i + 1).trim() } : null; }).filter((x): x is { label: string; value: string } => !!x && !!x.value);
}

/** O CRM NÃO conseguiu capturar a proposta do Inter (Fabio 15/10, Mauricio de Azevedo): ao CONFERIR o resultado, o portal do Inter mostra o modal "Ocorreu um erro ao processar os dados da
 *  sua proposta" e manda de volta pra lista. Na 1ª vez pode ser passageiro; na 2ª (ou 3ª) conferência com o mesmo erro, manda UM e-mail à Vania — da conta do Fabio, cc Andreia — com o
 *  problema E os dados completos do cliente pra ela vincular o cadastro/proposta lá (o mesmo texto que o Fabio aprovou à mão). A extensão do Inter (2026.10.15.1+) marca esses casos com
 *  "ERRO DO PORTAL INTER" no detalhe. 1 e-mail por card (`_interVaniaAt`), 08h–20h, máx. 5 por dia; nota + push. */
async function emailInterSemProposta(accountId: string) {
  const hora = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }));
  if (hora < 7 || hora >= 21) return; // e-mail pra gestora só em horário comercial
  const grupos = await prisma.$queryRaw<{ leadId: string; first: Date }[]>`
    SELECT a."leadId", min(a."createdAt") AS first FROM "CreditAnalysis" a
    WHERE a."accountId" = ${accountId} AND a.bank = 'INTER' AND a."dryRun" = false AND a."createdAt" > now() - interval '3 days' AND a.detail ~* 'ERRO DO PORTAL INTER'
    GROUP BY a."leadId" HAVING count(*) >= 2 LIMIT 5`;
  for (const g of grupos) {
    const lead = await prisma.lead.findUnique({ where: { id: g.leadId }, select: { id: true, name: true, status: true, archived: true, customFields: true } });
    const cf = (lead?.customFields || {}) as Cf;
    if (!lead || lead.status !== 'OPEN' || lead.archived || cf._interVaniaAt || cf._autoPaused) continue;
    const resultado = await prisma.creditAnalysis.count({ where: { leadId: g.leadId, bank: 'INTER', dryRun: false, status: { in: ['APPROVED', 'CONDITIONAL', 'REJECTED'] }, createdAt: { gt: g.first } } });
    if (resultado) continue; // o Inter já deu resultado depois: o erro passou
    const comNumero = await prisma.creditAnalysis.findFirst({ where: { leadId: g.leadId, bank: 'INTER', dryRun: false, proposalNumber: { not: null } }, orderBy: { createdAt: 'desc' }, select: { proposalNumber: true } });
    const hoje = await prisma.note.count({ where: { content: { startsWith: '📧 E-mail enviado à Vania' }, createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) } } });
    if (hoje >= 5) return; // freio: no máximo 5 e-mails por dia
    const acc = await prisma.emailAccount.findFirst({ where: { accountId, address: { startsWith: 'fabio@', mode: 'insensitive' } } });
    if (!acc) { console.warn('[Inter sem proposta] conta de e-mail do Fabio não encontrada'); return; }
    // Dados do cliente: a ficha da proposta no card (pares "Rótulo: valor"), com o que o card tem como reserva.
    const ficha = await prisma.message.findFirst({ where: { leadId: g.leadId, direction: 'INBOUND', content: { contains: 'Nome completo:' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
    const pares = parseFicha(ficha?.content || '');
    const pega = (rx: RegExp) => pares.find((x) => rx.test(x.label))?.value || '';
    const cpf = pega(/^cpf$/i) || String(cf.cpf_1 || '');
    const brl = (v: unknown) => (Number(v) > 0 ? `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '');
    const cliente = [
      ['Nome completo', pega(/^nome completo/i) || lead.name],
      ['CPF', cpf], ['Data de nascimento', pega(/data (de )?nascimento/i) || String(cf.nascimento_1 || '')],
      ['E-mail', pega(/^e-?mail/i) || String(cf.email_1 || '')], ['Celular', pega(/^(celular|whatsapp|telefone)/i) || String(cf.telefone_1 || '')],
      ['Gênero', pega(/^g[êe]nero/i)], ['Nacionalidade', pega(/^nacionalidade/i)], ['Naturalidade', pega(/^naturalidade/i)], ['Estado civil', pega(/^estado civil/i)],
      ['Renda bruta', pega(/^renda/i) || brl(cf.renda_1)],
      ['Endereço', [pega(/^logradouro/i), pega(/^bairro/i), pega(/^cidade\/uf resid/i), pega(/^cep$/i) && `CEP ${pega(/^cep$/i)}`].filter(Boolean).join(', ')],
    ].filter(([, v]) => v).map(([k, v]) => `• ${k}: ${v}`);
    const operacao = [
      ['Produto', 'Home Equity'], ['Crédito desejado', pega(/^cr[ée]dito desejado/i) || brl(cf.valor_credito)], ['Prazo', pega(/^prazo/i) || String(cf.prazo_financ || '')], ['LTV', pega(/^ltv/i)],
      ['Tipo do imóvel', pega(/^tipo do im[óo]vel/i)], ['Valor do imóvel', pega(/^valor do im[óo]vel/i) || brl(cf.valor_imovel)],
      ['Imóvel em garantia', [pega(/^endere[çc]o do im[óo]vel/i), pega(/^im[óo]vel em garantia/i), pega(/^cep do im[óo]vel/i) && `CEP ${pega(/^cep do im[óo]vel/i)}`].filter(Boolean).join(' — ')],
      ['Imóvel quitado', pega(/^im[óo]vel quitado/i)],
    ].filter(([, v]) => v).map(([k, v]) => `• ${k}: ${v}`);
    const dias = await prisma.creditAnalysis.findMany({ where: { leadId: g.leadId, bank: 'INTER', kind: 'RUN', dryRun: false, createdAt: { gt: new Date(Date.now() - 3 * 86_400_000) } }, select: { createdAt: true }, orderBy: { createdAt: 'asc' } });
    const datas = Array.from(new Set(dias.map((d) => d.createdAt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })))).join(' e ');
    const problema = comNumero?.proposalNumber
      ? `a proposta nº ${comNumero.proposalNumber} foi enviada pelo portal de parceiros ${datas ? `(${datas})` : ''}, mas ao conferir o resultado o portal mostra "Ocorreu um erro ao processar os dados da sua proposta" e volta pra lista, então não conseguimos acompanhar a análise`
      : `enviamos a proposta pelo portal de parceiros ${datas ? `nos dias ${datas}` : 'mais de uma vez'}, mas ela não gerou número de proposta: no portal o cliente aparece só como rascunho (sem número, valor ou status) e, ao conferir, o portal mostra "Ocorreu um erro ao processar os dados da sua proposta" e volta pra lista, então não conseguimos acompanhar a análise`;
    const body = `Olá, Vania, tudo bem?\n\nPreciso da sua ajuda com o cliente ${lead.name.toUpperCase()}${cpf ? ` (CPF ${cpf})` : ''}, Home Equity: ${problema}.\n\nSeguem os dados completos do cliente para você vincular o cadastro/proposta aí no Inter:\n\nDADOS DO CLIENTE\n${cliente.join('\n')}\n\nOPERAÇÃO\n${operacao.join('\n')}\n\nVocê poderia verificar o que aconteceu com esse cadastro e, se possível, liberar/criar a proposta ou nos orientar sobre o que precisamos ajustar?\n\nObrigado!`;
    try {
      const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
      await sendEmailFrom({ acc, userId: acc.userId, to: [INTER_GESTORA_EMAIL], cc: ['andreia@aefsolucoesfinanceiras.com.br'], subject: `CPF ${cpf || '-'} - ${lead.name.toUpperCase()} - proposta Home Equity com erro no portal`, body, leadId: lead.id, io: null });
      await saveCf(lead.id, { _interVaniaAt: new Date().toISOString() });
      await addNote(lead.id, '📧 E-mail enviado à Vania (Inter, vania.tavares@inter.co, cc Andreia) automaticamente: o portal do Inter deu o erro "Ocorreu um erro ao processar os dados da sua proposta" em 2 conferências. Mandei os dados completos do cliente pra ela vincular o cadastro.');
      const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
      sendPushToAccount(accountId, { title: lead.name, body: 'Inter deu erro na proposta — e-mail com os dados enviado à Vania', leadId: lead.id }).catch(() => {});
      console.log(`[Inter sem proposta] ${lead.name}: e-mail com os dados enviado à Vania`);
    } catch (e: any) {
      await saveCf(lead.id, { _interVaniaAt: new Date().toISOString() }); // não repete em laço
      await addNote(lead.id, `⚠️ O Inter deu erro na proposta em 2 conferências: NÃO consegui enviar o e-mail à Vania (${e?.message || e}). Mande à mão.`);
    }
  }
}

const SEM_RETORNO_MS = 24 * 3_600_000;

/** SEM RETORNO há mais de 24 h (Fabio 15/10): Inter → e-mail à Vania (gestora); Creditas → e-mail ao Jonatas (suporte). "Sem retorno" = a conferência não achou resultado REAL: nem aprovação
 *  (no Creditas, só vale com as condições: valor, prazo e parcela — pré-qualificação não conta) nem negativa. Aprovado ou negado = já houve retorno, nada a perguntar. */
const SEM_RETORNO = {
  INTER: { flag: '_interSemRetornoAt', email: INTER_GESTORA_EMAIL, quem: 'Vania', empresa: 'Inter', notaPrefixo: '📧 E-mail enviado à Vania' },
  CREDITAS: { flag: '_creditasSuporteAt', email: 'jonatas.carmona@creditas.com', quem: 'Jonatas', empresa: 'Creditas', notaPrefixo: '📧 E-mail enviado ao Jonatas' },
} as const;

export function semRetornoHa24h(bank: 'INTER' | 'CREDITAS', cf: Cf, rows: { bank: string; kind: string; status: string; createdAt: Date; finishedAt?: Date | null; dryRun?: boolean }[], now = Date.now()): { desde: Date } | null {
  if (cf._autoPaused || cf[SEM_RETORNO[bank].flag]) return null;
  if (bank === 'INTER' && cf._interVaniaAt) return null; // a Vania já recebeu e-mail deste card (erro do portal)
  const doBanco = rows.filter((r) => r.bank === bank && !r.dryRun);
  if (doBanco.some((r) => ['APPROVED', 'CONDITIONAL'].includes(r.status))) return null; // já tem aprovação real
  const enviados = doBanco.filter((r) => r.kind === 'RUN' && ['SENT', 'CHECK'].includes(r.status));
  if (!enviados.length) return null;
  const primeiro = enviados.reduce((a, b) => (a.createdAt < b.createdAt ? a : b));
  if (doBanco.some((r) => r.status === 'REJECTED' && r.createdAt >= primeiro.createdAt)) return null; // negado = houve retorno
  let base = primeiro.createdAt.getTime();
  if (bank === 'CREDITAS') {
    const scr = cf._scrCreditas as { status?: string; sentAt?: string } | undefined;
    if (scr && ['PENDING', 'ASKED', 'SENDING'].includes(String(scr.status))) return null; // esperando a autorização do cliente: pendência nossa
    if (scr?.status === 'SENT' && scr.sentAt) base = Math.max(base, new Date(scr.sentAt).getTime());
  }
  return now - base >= SEM_RETORNO_MS ? { desde: new Date(base) } : null;
}

/** 1 e-mail por card e banco (fabio@, cc Andreia), 07h–21h; nota + push. Só card que ainda espera aprovação (Pré-Análise). */
async function emailSemRetorno(accountId: string, bank: 'INTER' | 'CREDITAS') {
  const cfg = SEM_RETORNO[bank];
  const hora = Number(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }));
  if (hora < 7 || hora >= 21) return;
  const leads = await prisma.lead.findMany({
    where: { accountId, status: 'OPEN', archived: false, isGroup: false, OR: [{ stage: { name: { startsWith: 'Pré-An', mode: 'insensitive' } } }, { stage: { name: { startsWith: 'Aprovado Pr', mode: 'insensitive' } } }], creditAnalyses: { some: { bank, kind: 'RUN', status: { in: ['SENT', 'CHECK'] }, dryRun: false, createdAt: { lt: new Date(Date.now() - SEM_RETORNO_MS) } } } },
    select: { id: true, name: true, customFields: true, creditAnalyses: { where: { bank, dryRun: false }, orderBy: { createdAt: 'asc' }, select: { bank: true, kind: true, status: true, createdAt: true, finishedAt: true, proposalNumber: true, holderName: true, holderCpf: true } } },
    take: 40,
  });
  for (const lead of leads) {
    const cf = (lead.customFields || {}) as Cf;
    const precisa = semRetornoHa24h(bank, cf, lead.creditAnalyses);
    if (!precisa) continue;
    const acc = await prisma.emailAccount.findFirst({ where: { accountId, address: { startsWith: 'fabio@', mode: 'insensitive' } } });
    if (!acc) { console.warn(`[${cfg.empresa} sem retorno] conta de e-mail do Fabio não encontrada`); return; }
    const sent = lead.creditAnalyses.filter((r) => r.kind === 'RUN' && ['SENT', 'CHECK'].includes(r.status)).pop()!;
    const quem = sent.holderName || String(cf.participante_1 || lead.name);
    const cpfRaw = String(sent.holderCpf || cf.cpf_1 || '').replace(/\D/g, '');
    const cpf = cpfRaw.length === 11 ? `${cpfRaw.slice(0, 3)}.${cpfRaw.slice(3, 6)}.${cpfRaw.slice(6, 9)}-${cpfRaw.slice(9)}` : '';
    const numero = [...lead.creditAnalyses].reverse().find((r) => r.proposalNumber)?.proposalNumber || (bank === 'CREDITAS' ? (cf._scrCreditas as any)?.creditasId : '') || '';
    const quando = precisa.desde.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
    const horas = Math.round((Date.now() - precisa.desde.getTime()) / 3_600_000); // só pra nota interna; o e-mail não cita horas
    const situacao = bank === 'CREDITAS'
      ? `ela segue sem as condições de aprovação (valor, prazo e parcela) — só consta a pré-qualificação`
      : `ela segue sem decisão (nem aprovada nem negada) na Análise de Crédito`;
    const pendencia = bank === 'CREDITAS' ? 'algum documento, a Autorização SCR Bacen ou qualquer pendência' : 'algum documento ou qualquer pendência';
    const corpo = `Olá, ${cfg.quem}, tudo bem?\n\nPoderia me ajudar a verificar ${bank === 'CREDITAS' ? 'a aprovação' : 'a proposta'} do cliente ${quem.toUpperCase()}${cpf ? ` (CPF ${cpf})` : ''}, Home Equity?${numero ? ` ${bank === 'CREDITAS' ? 'ID/proposta' : 'Proposta nº'} ${numero}.` : ''}\n\nEnviamos a proposta ${bank === 'CREDITAS' ? 'pela plataforma da Creditas' : 'pelo portal de parceiros do Inter'} em ${quando} e, até agora, ${situacao}.\n\nSe faltar ${pendencia} da nossa parte, me avise que resolvo na hora.\n\nObrigado!`;
    try {
      const { sendEmailFrom } = require('./email-inbox.service') as typeof import('./email-inbox.service');
      await sendEmailFrom({ acc, userId: acc.userId, to: [cfg.email], cc: ['andreia@aefsolucoesfinanceiras.com.br'], subject: `CPF ${cpf || '-'} - ${quem.toUpperCase()} - ${bank === 'CREDITAS' ? 'aprovação' : 'proposta'} Home Equity sem retorno no ${cfg.empresa}`, body: corpo, leadId: lead.id, io: null } as any);
      await saveCf(lead.id, { [cfg.flag]: new Date().toISOString() });
      await addNote(lead.id, `${cfg.notaPrefixo} (${cfg.empresa}, ${cfg.email}, cc Andreia) automaticamente: o ${cfg.empresa} está há mais de ${horas} h sem retorno (${bank === 'CREDITAS' ? 'sem as condições da proposta' : 'sem aprovação nem negativa'}). Perguntei da proposta de ${quem}.`);
      const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
      sendPushToAccount(accountId, { title: lead.name, body: `${cfg.empresa} há +24 h sem retorno — e-mail enviado ${bank === 'CREDITAS' ? 'ao Jonatas' : 'à Vania'}`, leadId: lead.id }).catch(() => {});
      console.log(`[${cfg.empresa} sem retorno] ${lead.name}: e-mail enviado a ${cfg.quem}`);
    } catch (e: any) {
      await saveCf(lead.id, { [cfg.flag]: new Date().toISOString() }); // não repete em laço
      await addNote(lead.id, `⚠️ O ${cfg.empresa} está há mais de ${horas} h sem retorno: NÃO consegui enviar o e-mail ${bank === 'CREDITAS' ? 'ao Jonatas' : 'à Vania'} (${e?.message || e}). Mande à mão para ${cfg.email}.`);
    }
  }
}

/** Aviso ANTECIPADO (Fabio 14/10): análise demorando (Creditas/Inter levam horas) e a janela de 24 h do WhatsApp perto de fechar → o cliente recebe a aprovação que já saiu (e que
 *  seguimos esperando outros bancos pra tentar taxa menor) ou o "análise em andamento". Uma vez por janela; as regras de horário/janela/dedupe ficam em sendEarlyStatusNotice. */
async function earlyStatusNotices(accountId: string, io: any) {
  const leads = await prisma.lead.findMany({
    where: {
      accountId, status: 'OPEN', archived: false, isGroup: false,
      stage: { name: { startsWith: 'Pré-An', mode: 'insensitive' } },
      pipeline: { department: { name: { contains: 'Home Equity', mode: 'insensitive' } } },
      creditAnalyses: { some: { dryRun: false } },
    },
    select: { id: true, name: true, customFields: true, creditAnalyses: { where: { dryRun: false }, select: { bank: true, kind: true, status: true, detail: true, createdAt: true, source: true } } },
    take: 60,
  });
  for (const l of leads) {
    const cf = (l.customFields || {}) as Cf;
    if (cf._autoPaused) continue; // cliente PAUSADO pelo botão da tela: nada automático (rodar, refazer, 2º participante, avisos, fechar)
    if (!cf._autoStartedAt || cf._noticeAt) continue;
    const verdicts = BANKS.map((b) => bankVerdict(l.creditAnalyses as any, b));
    if (!verdicts.includes('PENDING')) continue; // todos decididos: aviso final / fechamento cuidam
    const out = await sendEarlyStatusNotice({ accountId, leadId: l.id, variant: verdicts.includes('POS') ? 'APPROVED_PARTIAL' : 'WAITING', io });
    if (out.ok) console.log(`[Análise automática] ${l.name}: aviso antecipado enviado (${verdicts.includes('POS') ? 'aprovação parcial' : 'em andamento'})`);
    else if (out.error) console.warn(`[Análise automática] ${l.name}: aviso antecipado falhou — ${out.error}`);
  }
}

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
      await flagInterSemNumero(s.accountId).catch((e) => console.error('[Análise automática] Inter sem número:', e?.message));
      await emailInterSemProposta(s.accountId).catch((e) => console.error('[Análise automática] e-mail Vania:', e?.message));
      await emailSemRetorno(s.accountId, 'INTER').catch((e) => console.error('[Análise automática] e-mail Vania (sem retorno):', e?.message));
      await emailSemRetorno(s.accountId, 'CREDITAS').catch((e) => console.error('[Análise automática] e-mail Jonatas (sem retorno):', e?.message));
      await earlyStatusNotices(s.accountId, io).catch((e) => console.error('[Análise automática] aviso antecipado:', e?.message));
      { const { processDocsChecks } = require('./docs-checker.service') as typeof import('./docs-checker.service'); await processDocsChecks(s.accountId, io).catch((e: any) => console.error('[Docs]', e?.message)); }
      { const { processDocsFollowUps } = require('./docs-checker.service') as typeof import('./docs-checker.service'); await processDocsFollowUps(s.accountId, io).catch((e: any) => console.error('[Docs] cobrança:', e?.message)); }
      { const { processSaldoDevedor } = require('./saldo-devedor.service') as typeof import('./saldo-devedor.service'); await processSaldoDevedor(s.accountId, io).catch((e: any) => console.error('[Saldo]', e?.message)); }
      { const { processScrFlows } = require('./creditas-scr.service') as typeof import('./creditas-scr.service'); await processScrFlows(s.accountId, io).catch((e: any) => console.error('[Creditas SCR]', e?.message)); }
    }
  } finally {
    running = false;
  }
}
