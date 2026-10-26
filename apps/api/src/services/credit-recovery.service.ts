import { prisma } from '../lib/prisma';
import { createRequests, loginNeededFor } from './credit-analysis.service';
import { OBJECTIVE_FAIL, DADO_PARA_CORRIGIR, semRuidoDeSimulacao } from './credit-auto.service';

/**
 * RETOMAR ANÁLISE TRAVADA (Fabio 21/10, caso Melissa Patrocínio: Inter "solicitada" que nunca apareceu no portal e Santander parado em "Simulação" por 18 h, com a cliente cobrando).
 * Duas regras dele:
 *  1) "SEMPRE QUE O CLIENTE COBRAR, A EXTENSÃO DEVE SER ATIVADA PARA CONFERÊNCIA OU PARA RODAR NOVAMENTE" → `onClientChase`: a mensagem da cliente ("deu certo?", "saiu o resultado?", "e aí?")
 *     aciona a extensão na hora: lê de novo o que já está no portal (conferência) ou, se a proposta NÃO aparece / ficou só em simulação / a rodada falhou, RODA DE NOVO.
 *  2) "SEMPRE ÀS 08 DA MANHÃ DEVE RODAR OS CLIENTES QUE FICARAM TRAVADOS POR ALGUM MOTIVO (aba fechada, captcha não feito…)" → `processMorningRerun`: a partir das 8h (Brasília), uma vez por dia por card.
 * Quem decide o que fazer em cada banco é `planRecovery` (pura). Fora do escopo dela (a equipe resolve): reprovado/aprovado (já tem resposta), "NÃO RODEI" (regra do banco), "DADO PARA CORRIGIR" (o portal recusou um dado
 * do cadastro: rodar igual dá o mesmo erro), análise manual do Santander (espera por documentos), dados incompletos, banco pedindo login.
 */

type Cf = Record<string, any>;

const BANKS = ['CREDIMORAR', 'CREDITAS', 'INTER'];
const LABEL: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };

const NAO_ACHEI = /n[aã]o achei o cliente na lista|ainda n[aã]o apareceu na lista|proposta aberta pelo n[uú]mero n[aã]o traz/i;
const SO_SIMULACAO = /SIMULA[ÇC][ÃA]O[^\n]*Ainda sem resultado/i;
const SANTANDER_MANUAL = /AN[ÁA]LISE MANUAL ABERTA/i;
const NAO_ACHEI_MIN = 30; // a lista do portal pode demorar a mostrar a proposta recém-enviada
const SIMULACAO_MIN = 120; // Santander leva um tempo pra sair de "Simulação"
const RUN_GAP_COBRANCA_MS = 3 * 3600_000; // cliente cobrando de novo não dispara outra rodada em menos de 3 h
const RUN_MAX_POR_DIA = 2;
// 26/10 (Welma, Alziro, Daniel): o Inter dizia "proposta solicitada" e ela NUNCA aparecia na lista de Propostas — a retomada das 8h rodou de novo 7 dias seguidos
// (uma proposta nova por dia). Depois de RODADAS_SEM_APARECER rodadas assim em SEM_APARECER_DIAS dias, para de rodar sozinho e avisa a equipe pra conferir no portal.
const RODADAS_SEM_APARECER = 2;
const SEM_APARECER_DIAS = 7;
const CHECK_GAP_MS = 10 * 60_000;

export type RecRow = { bank: string; kind: string; status: string; detail: string | null; createdAt: Date; updatedAt: Date; source: string; proposalNumber?: string | null };
export type RecAction = { bank: string; mode: 'RUN' | 'CHECK' | 'STOP'; why: string };

/** Cobrança do cliente: mensagem curta perguntando do resultado/andamento (não vale proposta preenchida nem texto longo). Pura (testável). */
export function isChase(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length > 180 || /Proposta preenchida no site|C[oó]digo de confirma[cç][aã]o/i.test(t)) return false;
  return /(deu certo|n[aã]o deu|j[aá] sa(iu|i)\b|\bsaiu\b|\bsair\b|resultado|novidade|retorno|andamento|alguma (coisa|resposta|not[ií]cia|posi[cç][aã]o)|cad[eê]\b|demor|aprov(ou|ad)|\be a[ií]\b|\be ent[aã]o\b|como (est[aá]|t[aá])\b|ajuda a dar certo|sem resposta|alguma previs[aã]o|posi[cç][aã]o)/i.test(t);
}

/** O que fazer em cada banco com a análise que não saiu. Pura (testável). RUN = rodar de novo; CHECK = conferir o que já está no portal. */
export function planRecovery(rows: RecRow[], opts: { now?: number; loginNeeded?: (bank: string) => boolean } = {}): RecAction[] {
  const now = opts.now ?? Date.now();
  const out: RecAction[] = [];
  for (const bank of BANKS) {
    const mine = rows.filter((r) => r.bank === bank && semRuidoDeSimulacao(r)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (!mine.length) continue;
    // rodada (ou leitura) EM EXECUÇÃO nesse banco agora: espera. Só conferência na fila (as de 3–10 min, até 18 vezes) não segura uma nova rodada — senão uma proposta que nunca aparece
    // ficaria 3 h sendo reconferida sem ninguém rodar de novo (Melissa 21/10).
    const abertas = mine.filter((r) => (r.status === 'REQUESTED' || r.status === 'RUNNING') && now - r.updatedAt.getTime() < 25 * 60_000);
    if (abertas.some((r) => r.status === 'RUNNING' || r.kind === 'RUN')) continue;
    const conferenciaNaFila = abertas.length > 0;
    const efetivas = mine.filter((r) => !(r.kind === 'CHECK' && ['CHECK', 'REQUESTED', 'RUNNING'].includes(r.status)));
    const efetiva = efetivas[efetivas.length - 1];
    if (!efetiva) continue;
    if (['APPROVED', 'CONDITIONAL', 'REJECTED', 'TEST'].includes(efetiva.status)) continue; // já tem resposta
    const ultimaRodada = [...mine].reverse().find((r) => r.kind === 'RUN');
    if (!ultimaRodada) continue;
    const desde = mine.filter((r) => r.createdAt.getTime() >= ultimaRodada.createdAt.getTime());
    if (desde.some((r) => SANTANDER_MANUAL.test(r.detail || ''))) continue; // análise manual aberta: espera os documentos

    if (efetiva.status === 'FAILED') {
      const d = efetiva.detail || '';
      if (OBJECTIVE_FAIL.test(d) || DADO_PARA_CORRIGIR.test(d) || /RODADA ANULADA/i.test(d)) continue;
      if (/n[aã]o est[aá] logada/i.test(d) && opts.loginNeeded && opts.loginNeeded(bank)) continue; // banco pedindo login: espera alguém entrar
      // falha de um RODAR que já tinha ENVIADO a proposta: rodar de novo duplicaria a proposta no portal
      const jaEnviada = efetiva.kind === 'CHECK' || !!efetiva.proposalNumber || /proposta (j[aá] )?enviada|lendo o resultado/i.test(d);
      if (jaEnviada && conferenciaNaFila) continue;
      out.push({ bank, mode: jaEnviada ? 'CHECK' : 'RUN', why: 'falha técnica na rodada (aba fechada, captcha, janela do banco…)' });
      continue;
    }
    if (efetiva.status !== 'SENT') continue; // INCOMPLETE e afins: o dado precisa de gente

    const leituras = desde.filter((r) => r.kind === 'CHECK' || r.status === 'SENT');
    const ult = (leituras[leituras.length - 1]?.detail || ultimaRodada.detail || '');
    const idadeMin = (now - ultimaRodada.createdAt.getTime()) / 60_000;
    if (NAO_ACHEI.test(ult)) {
      const semAparecer = mine.filter((r) => r.kind === 'RUN' && r.status === 'SENT' && !r.proposalNumber && now - r.createdAt.getTime() < SEM_APARECER_DIAS * 86400_000).length;
      if (idadeMin >= NAO_ACHEI_MIN && semAparecer >= RODADAS_SEM_APARECER) {
        out.push({ bank, mode: 'STOP', why: `rodei ${semAparecer} vezes e a proposta nunca apareceu na lista do portal — rodar de novo só cria outra proposta igual` });
        continue;
      }
      out.push(idadeMin >= NAO_ACHEI_MIN ? { bank, mode: 'RUN', why: 'a proposta não aparece no portal do banco' } : { bank, mode: 'CHECK', why: 'proposta recém-enviada: conferir de novo' });
    } else if (SO_SIMULACAO.test(ult)) {
      out.push(idadeMin >= SIMULACAO_MIN ? { bank, mode: 'RUN', why: 'a proposta ficou só em simulação, não foi pra análise' } : { bank, mode: 'CHECK', why: 'ainda em simulação: conferir de novo' });
    } else if (!conferenciaNaFila) {
      out.push({ bank, mode: 'CHECK', why: 'conferir o resultado no portal' });
    }
  }
  // conferência já na fila e o plano era só conferir: nada a criar
  return out.filter((a) => !(a.mode === 'CHECK' && rows.some((r) => r.bank === a.bank && r.kind === 'CHECK' && r.status === 'REQUESTED' && now - r.updatedAt.getTime() < 25 * 60_000)));
}

const brt = (ms = Date.now()) => new Date(ms - 3 * 3600_000);
const dayBrt = (ms = Date.now()) => brt(ms).toISOString().slice(0, 10);
const addNote = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});

type Why = 'cobranca' | 'manha';
type Rec = { runAt?: string; checkAt?: string; day?: string; n?: number; stopAt?: string };

/** Aplica `planRecovery` no card: cria os pedidos (rodar de novo / conferir), com freio por banco, e deixa nota. Devolve o que foi pedido. */
export async function recoverStuckAnalyses(accountId: string, leadId: string, why: Why): Promise<RecAction[]> {
  const lead = await prisma.lead.findFirst({
    where: {
      id: leadId, accountId, status: 'OPEN', archived: false, isGroup: false,
      stage: { name: { startsWith: 'Pré-An', mode: 'insensitive' } },
      pipeline: { department: { name: { contains: 'Home Equity', mode: 'insensitive' } } },
    },
    select: { id: true, name: true, customFields: true, creditAnalyses: { where: { dryRun: false }, orderBy: { createdAt: 'asc' }, select: { bank: true, kind: true, status: true, detail: true, createdAt: true, updatedAt: true, source: true, proposalNumber: true } } },
  });
  if (!lead) return [];
  const cf = (lead.customFields || {}) as Cf;
  if (cf._autoPaused || cf._noticeAt) return []; // cliente pausado pela equipe / já avisado do resultado
  // Conferência já marcada pra daqui a pouco (3–10 min): cliente cobrando adianta pra agora.
  if (why === 'cobranca') await prisma.creditAnalysis.updateMany({ where: { leadId, dryRun: false, kind: 'CHECK', status: 'REQUESTED', notBefore: { gt: new Date() } }, data: { notBefore: null } }).catch(() => {});
  const plan = planRecovery(lead.creditAnalyses as RecRow[], { loginNeeded: (b) => loginNeededFor(accountId, b) });
  if (!plan.length) return [];

  const hoje = dayBrt();
  const rec: Record<string, Rec> = { ...(cf._recover || {}) };

  // banco em que rodar de novo não adianta: avisa a equipe UMA vez (por última rodada) e não roda mais sozinho
  const paradas = plan.filter((a) => a.mode === 'STOP');
  if (paradas.length) {
    const novas = paradas.filter((a) => {
      const ultRun = [...lead.creditAnalyses].reverse().find((r) => r.bank === a.bank && r.kind === 'RUN');
      const stopAt = rec[a.bank]?.stopAt;
      return !stopAt || (ultRun && ultRun.createdAt.getTime() > new Date(stopAt).getTime());
    });
    if (novas.length) {
      const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf;
      const r2: Record<string, Rec> = { ...(fresh._recover || {}) };
      for (const a of novas) r2[a.bank] = { ...(r2[a.bank] || {}), stopAt: new Date().toISOString() };
      await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, _recover: r2 } } });
      const bancos = novas.map((a) => LABEL[a.bank] || a.bank).join(' e ');
      await addNote(leadId, `⏸️ Parei de rodar ${bancos} sozinho: ${novas.map((a) => a.why).join('; ')}.\nConfira no portal se a proposta existe (pelo CPF do titular e do 2º participante) e anote o nº da proposta no card — ou peça uma nova rodada pela Análise de Crédito.`);
      try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: `${bancos}: proposta não aparece no portal`, body: `${lead.name}: rodei ${bancos} mais de uma vez e a proposta nunca apareceu na lista. Confira no portal.`, leadId }).catch(() => {}); } catch { /* aviso */ }
    }
  }
  const run: RecAction[] = [], check: RecAction[] = [];
  for (const a of plan) {
    if (a.mode === 'STOP') continue;
    const r = rec[a.bank] || {};
    if (a.mode === 'RUN') {
      const noDia = r.day === hoje ? (r.n || 0) : 0;
      if (noDia >= RUN_MAX_POR_DIA) continue;
      if (why === 'cobranca' && r.runAt && Date.now() - new Date(r.runAt).getTime() < RUN_GAP_COBRANCA_MS) continue;
      if (why === 'manha' && r.runAt && dayBrt(new Date(r.runAt).getTime()) === hoje) continue;
      run.push(a);
    } else {
      if (r.checkAt && Date.now() - new Date(r.checkAt).getTime() < CHECK_GAP_MS) continue;
      check.push(a);
    }
  }
  if (!run.length && !check.length) return [];

  const feitos: RecAction[] = [];
  if (run.length) {
    // a cadeia de conferências marcada (3–10 min) é encerrada: a nova rodada recomeça a contagem
    await prisma.creditAnalysis.updateMany({ where: { leadId, dryRun: false, bank: { in: run.map((a) => a.bank) }, kind: 'CHECK', status: 'REQUESTED' }, data: { status: 'CHECK', finishedAt: new Date(), detail: `Conferência encerrada: nova rodada pedida (${why === 'manha' ? 'retomada das 8h' : 'cliente cobrou'}).` } });
    const out = await createRequests(prisma, { accountId, leadIds: [leadId], banks: run.map((a) => a.bank), dryRun: false, force: true });
    if (out.created) feitos.push(...run);
  }
  if (check.length) {
    const out = await createRequests(prisma, { accountId, leadIds: [leadId], banks: check.map((a) => a.bank), dryRun: false, kind: 'CHECK' });
    if (out.created) feitos.push(...check);
  }
  if (!feitos.length) return [];

  // marca o freio e zera as tentativas automáticas dos bancos que vão rodar de novo (a retentativa de falha técnica recomeça do zero)
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf;
  const agora = new Date().toISOString();
  const recNovo: Record<string, Rec> = { ...(fresh._recover || {}) };
  const retries: Record<string, any> = { ...(fresh._autoRetries || {}) };
  for (const a of feitos) {
    const r = recNovo[a.bank] || {};
    if (a.mode === 'RUN') { recNovo[a.bank] = { ...r, runAt: agora, day: hoje, n: (r.day === hoje ? (r.n || 0) : 0) + 1 }; delete retries[a.bank]; }
    else recNovo[a.bank] = { ...r, checkAt: agora };
  }
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, _recover: recNovo, _autoRetries: retries } } });
  const topo = why === 'manha' ? '🌅 8h: retomei a análise que estava travada' : '🔔 O cliente cobrou o resultado: acionei a extensão';
  const linhas = feitos.map((a) => `• ${LABEL[a.bank] || a.bank}: ${a.mode === 'RUN' ? 'rodando de novo' : 'conferindo o portal'} — ${a.why}`);
  await addNote(leadId, `${topo}.\n${linhas.join('\n')}`);
  return feitos;
}

/** Hook da mensagem recebida: cliente cobrou → aciona a extensão (conferir ou rodar de novo). Sem análise parada não faz nada. */
export async function onClientChase(accountId: string, leadId: string, text: string): Promise<void> {
  if (!isChase(text)) return;
  await recoverStuckAnalyses(accountId, leadId, 'cobranca');
}

/** Das 08h às 12h (Brasília) varre os cards da Pré-Análise uma vez por dia e retoma o que travou. A janela até o meio-dia cobre o servidor que estava fora às 8h; as extensões só trabalham 07h–22h. */
export async function processMorningRerun(accountId: string): Promise<void> {
  const h = brt().getUTCHours();
  if (h < 8 || h >= 12) return;
  const hoje = dayBrt();
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l
    JOIN "Pipeline" p ON p.id = l."pipelineId" JOIN "Department" d ON d.id = p."departmentId" JOIN "Stage" st ON st.id = l."stageId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND d.name ILIKE '%home equity%' AND st.name ILIKE 'Pré-An%'
      AND COALESCE(l."customFields"->>'_morningRerunDay', '') <> ${hoje}
      AND EXISTS (SELECT 1 FROM "CreditAnalysis" ca WHERE ca."leadId" = l.id AND ca."dryRun" = false)
    ORDER BY l."stageEnteredAt" ASC
    LIMIT 40`;
  for (const { id } of ids) {
    try { await recoverStuckAnalyses(accountId, id, 'manha'); } catch (e: any) { console.warn('[Retomar 8h]', e?.message); }
    const fresh = await prisma.lead.findUnique({ where: { id }, select: { customFields: true } });
    if (fresh) await prisma.lead.update({ where: { id }, data: { customFields: { ...((fresh.customFields || {}) as Cf), _morningRerunDay: hoje } } }).catch(() => {});
  }
}
