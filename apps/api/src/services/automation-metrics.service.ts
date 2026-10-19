import { PrismaClient, Prisma } from '@prisma/client';
import { extensionStatus } from './credit-analysis.service';

/**
 * Painel "Medição da automação" (Fabio 19/10: "um painel que meça a certeza de todo o processo da nossa automação… quero medir tudo e a gente verificar o que podemos ajustar").
 * Só LÊ o que o CRM já registra (análises dos bancos, notas do card, mensagens do WhatsApp, dúvidas da IA, uso da IA, histórico reversível) — nada novo é gravado.
 * Cada bloco responde: quanto a automação fez, quanto acertou sozinha e onde a equipe teve que corrigir. `atencao` junta, em frases, o que mais merece ajuste.
 */
const prisma = new PrismaClient();

/** Falha OBJETIVA (regra do banco/imóvel/idade) = o cliente "não passa": não é erro da automação. Mesmo critério do credit-auto.service (OBJECTIVE_FAIL). */
const OBJETIVA = 'N[ÃA]O RODEI|n[aã]o conformidade|recusou antes de consultar|CPF j[aá] possui uma proposta ativa na Creditas';
const BANK_LABEL: Record<string, string> = { INTER: 'Inter', CREDITAS: 'Creditas', CREDIMORAR: 'Santander' };

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const round1 = (v: unknown): number | null => (v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 10) / 10);
const pct = (a: number, b: number): number | null => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

export async function automationMetrics(accountId: string, days: number) {
  const d = Math.min(Math.max(Math.round(days) || 14, 1), 90);
  const since = new Date(Date.now() - d * 86_400_000);
  const sinceDay = since.toISOString().slice(0, 10);

  // ── 1. Análises nos bancos ─────────────────────────────────────────────
  const bancoRows = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT "bank",
      count(*)::int AS total,
      count(*) FILTER (WHERE "status" IN ('APPROVED','CONDITIONAL'))::int AS aprovadas,
      count(*) FILTER (WHERE "status" = 'REJECTED')::int AS reprovadas,
      count(*) FILTER (WHERE "status" = 'FAILED' AND "detail" ~* ${OBJETIVA})::int AS desqualificadas,
      count(*) FILTER (WHERE "status" = 'FAILED' AND ("detail" IS NULL OR "detail" !~* ${OBJETIVA}))::int AS falhas,
      count(*) FILTER (WHERE "status" IN ('REQUESTED','RUNNING','SENT','CHECK','INCOMPLETE'))::int AS andamento,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ("finishedAt" - COALESCE("startedAt","createdAt")))/60)
        FILTER (WHERE "finishedAt" IS NOT NULL AND "status" IN ('APPROVED','CONDITIONAL','REJECTED')) AS mediana_min,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM ("finishedAt" - COALESCE("startedAt","createdAt")))/60)
        FILTER (WHERE "finishedAt" IS NOT NULL AND "status" IN ('APPROVED','CONDITIONAL','REJECTED')) AS p90_min
    FROM "CreditAnalysis"
    WHERE "accountId" = ${accountId} AND "kind" = 'RUN' AND "dryRun" = false AND "source" <> 'AI_SIM' AND "createdAt" >= ${since}
    GROUP BY "bank" ORDER BY "bank"`);
  const bancos = bancoRows.map((r) => {
    const fechadas = num(r.total) - num(r.andamento);
    const conclusivas = num(r.aprovadas) + num(r.reprovadas) + num(r.desqualificadas);
    return {
      bank: r.bank as string, label: BANK_LABEL[r.bank] || r.bank, total: num(r.total), aprovadas: num(r.aprovadas), reprovadas: num(r.reprovadas), desqualificadas: num(r.desqualificadas),
      falhas: num(r.falhas), andamento: num(r.andamento), conclusivasPct: pct(conclusivas, fechadas), falhaPct: pct(num(r.falhas), fechadas),
      medianaMin: round1(r.mediana_min), p90Min: round1(r.p90_min),
    };
  });

  const causas = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT "bank", left(trim(regexp_replace(coalesce("detail",'(sem detalhe)'), '(Titular na análise:[^.]*\\.\\s*)|[0-9]{3,}', '', 'g')), 120) AS causa, count(*)::int AS n
    FROM "CreditAnalysis"
    WHERE "accountId" = ${accountId} AND "kind" = 'RUN' AND "dryRun" = false AND "status" = 'FAILED' AND ("detail" IS NULL OR "detail" !~* ${OBJETIVA}) AND "createdAt" >= ${since}
    GROUP BY 1, 2 ORDER BY n DESC LIMIT 10`);

  const analisados = num((await prisma.$queryRaw<any[]>(Prisma.sql`SELECT count(DISTINCT "leadId")::int AS n FROM "CreditAnalysis" WHERE "accountId" = ${accountId} AND "kind" = 'RUN' AND "dryRun" = false AND "createdAt" >= ${since}`))[0]?.n);

  // ── 2. Tempo do processo ──────────────────────────────────────────────
  const primeiro = (await prisma.$queryRaw<any[]>(Prisma.sql`
    WITH ini AS (SELECT "leadId", min("createdAt") AS t FROM "CreditAnalysis" WHERE "accountId" = ${accountId} AND "kind" = 'RUN' AND "dryRun" = false AND "createdAt" >= ${since} GROUP BY 1),
         fim AS (SELECT "leadId", min("finishedAt") AS t FROM "CreditAnalysis" WHERE "accountId" = ${accountId} AND "kind" = 'RUN' AND "dryRun" = false AND "status" IN ('APPROVED','CONDITIONAL','REJECTED') AND "finishedAt" IS NOT NULL GROUP BY 1)
    SELECT count(*)::int AS n,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (fim.t - ini.t))/60) AS mediana_min,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (fim.t - ini.t))/60) AS p90_min
    FROM ini JOIN fim USING ("leadId") WHERE fim.t >= ini.t`))[0] || {};

  const aviso = (await prisma.$queryRaw<any[]>(Prisma.sql`
    WITH apr AS (SELECT "leadId", min("createdAt") AS t FROM "CreditAnalysis" WHERE "accountId" = ${accountId} AND "status" IN ('APPROVED','CONDITIONAL') AND "approvedValue" IS NOT NULL AND "dryRun" = false AND "createdAt" >= ${since} GROUP BY 1),
         av AS (SELECT apr."leadId", apr.t AS aprovou, (SELECT min(n."createdAt") FROM "Note" n WHERE n."leadId" = apr."leadId" AND n."content" LIKE '📣 Cliente avisado das opções%' AND n."createdAt" >= apr.t) AS avisou FROM apr)
    SELECT count(*)::int AS aprovadas, count(avisou)::int AS avisadas,
      count(*) FILTER (WHERE avisou IS NOT NULL AND extract(epoch FROM (avisou - aprovou)) <= 900)::int AS ate15,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (avisou - aprovou))/60) FILTER (WHERE avisou IS NOT NULL) AS mediana_min,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM (avisou - aprovou))/60) FILTER (WHERE avisou IS NOT NULL) AS p90_min
    FROM av`))[0] || {};

  const semAviso = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT l."id", l."name", l."aiAutoReplyActive" AS ia, extract(epoch FROM (now() - a.t))/3600 AS horas
    FROM (SELECT "leadId", min("createdAt") AS t FROM "CreditAnalysis" WHERE "accountId" = ${accountId} AND "status" IN ('APPROVED','CONDITIONAL') AND "approvedValue" IS NOT NULL AND "dryRun" = false AND "createdAt" >= ${since} GROUP BY 1) a
    JOIN "Lead" l ON l."id" = a."leadId"
    WHERE l."status" = 'OPEN' AND l."archived" = false AND a.t < now() - interval '1 hour'
      AND NOT jsonb_exists(COALESCE(l."customFields", '{}'::jsonb), '_autoPaused') -- cliente pausado à mão (Stop total): não é falha da automação
      AND NOT EXISTS (SELECT 1 FROM "Stage" st WHERE st."id" = l."stageId" AND st."name" ILIKE 'Venda Futura%')
      AND NOT EXISTS (SELECT 1 FROM "Note" n WHERE n."leadId" = a."leadId" AND n."content" LIKE '📣 Cliente avisado%' AND n."createdAt" >= a.t)
      AND NOT EXISTS (SELECT 1 FROM "Message" m WHERE m."leadId" = a."leadId" AND m."direction" = 'OUTBOUND' AND m."createdAt" >= a.t AND (m."content" LIKE '%Crédito aprovado%' OR m."templateName" = 'credito_aprovado_condicoes'))
    ORDER BY a.t ASC LIMIT 15`);

  // ── 3. Avisos ao cliente ──────────────────────────────────────────────
  const avisos = (await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT
      count(*) FILTER (WHERE n."content" LIKE '📣 Cliente avisado das opções%')::int AS aprovacao,
      count(*) FILTER (WHERE n."content" LIKE '📣 Cliente avisado%que não foi aprovado%')::int AS negativa,
      count(*) FILTER (WHERE n."content" LIKE '✋ Aprovação pronta%')::int AS aprovacao_segurada,
      count(*) FILTER (WHERE n."content" LIKE '✋ Nenhum banco aprovou%')::int AS negativa_segurada,
      count(*) FILTER (WHERE n."content" LIKE 'ℹ️ Aviso de aprovação NÃO reenviado%' OR n."content" LIKE 'ℹ️ Aviso de negativa NÃO reenviado%')::int AS duplicados_evitados,
      count(*) FILTER (WHERE n."content" LIKE '⚠️ O aviso de "não aprovado" NÃO saiu%')::int AS negativa_nao_saiu
    FROM "Note" n JOIN "Lead" l ON l."id" = n."leadId"
    WHERE l."accountId" = ${accountId} AND n."createdAt" >= ${since}`))[0] || {};

  const wa = (await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE m."status" = 'FAILED')::int AS falhas
    FROM "Message" m JOIN "Lead" l ON l."id" = m."leadId"
    WHERE l."accountId" = ${accountId} AND m."direction" = 'OUTBOUND' AND m."channel" = 'WHATSAPP' AND m."createdAt" >= ${since}`))[0] || {};
  const waErros = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT left(coalesce(m."statusError",'(sem motivo)'), 110) AS motivo, count(*)::int AS n
    FROM "Message" m JOIN "Lead" l ON l."id" = m."leadId"
    WHERE l."accountId" = ${accountId} AND m."direction" = 'OUTBOUND' AND m."channel" = 'WHATSAPP' AND m."status" = 'FAILED' AND m."createdAt" >= ${since}
    GROUP BY 1 ORDER BY n DESC LIMIT 6`);

  // ── 4. IA de atendimento ──────────────────────────────────────────────
  const ia = (await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT count(*) FILTER (WHERE "action" = 'ai_replied')::int AS respostas, count(*) FILTER (WHERE "action" = 'ai_team_question')::int AS perguntas
    FROM "ActivityLog" WHERE "accountId" = ${accountId} AND "createdAt" >= ${since}`))[0] || {};
  const humanoAssumiu = num((await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT count(*)::int AS n FROM "Note" n JOIN "Lead" l ON l."id" = n."leadId" WHERE l."accountId" = ${accountId} AND n."createdAt" >= ${since} AND n."content" LIKE 'IA desligada automaticamente: alguém da equipe respondeu%'`))[0]?.n);
  const duvidas = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT "kind", count(*)::int AS total, count(*) FILTER (WHERE "status" = 'ANSWERED')::int AS respondidas, count(*) FILTER (WHERE "status" = 'OPEN')::int AS abertas,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ("answeredAt" - "createdAt"))/60) FILTER (WHERE "answeredAt" IS NOT NULL) AS mediana_min
    FROM "AiTeamQuestion" WHERE "accountId" = ${accountId} AND "createdAt" >= ${since} GROUP BY "kind" ORDER BY total DESC`);
  const uso = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT "feature", sum("calls")::int AS chamadas, sum("errors")::int AS erros, sum("inputTokens" + "cacheReadTokens" + "cacheWriteTokens")::bigint AS entrada, sum("outputTokens")::bigint AS saida
    FROM "AiUsage" WHERE "day" >= ${sinceDay} GROUP BY "feature" ORDER BY chamadas DESC LIMIT 12`);
  // Gasto ESTIMADO com a Anthropic (preço de tabela suposto: Sonnet US$ 3/15 por milhão, Haiku 1/5; cache lido 10% e gravado 125% da entrada) — conferir o valor real no console da Anthropic.
  const usoLinhas = await prisma.aiUsage.findMany({ where: { day: { gte: sinceDay } }, select: { day: true, feature: true, model: true, calls: true, inputTokens: true, outputTokens: true, cacheReadTokens: true, cacheWriteTokens: true } });
  const usd = (r: (typeof usoLinhas)[number]) => { const pr = /haiku/i.test(r.model) ? { i: 1, o: 5 } : { i: 3, o: 15 }; return (r.inputTokens * pr.i + r.cacheReadTokens * pr.i * 0.1 + r.cacheWriteTokens * pr.i * 1.25 + r.outputTokens * pr.o) / 1e6; };
  const custoDia = new Map<string, { usd: number; calls: number }>();
  const custoFuncao = new Map<string, { usd: number; calls: number; entrada: number }>();
  for (const r of usoLinhas) {
    const a = custoDia.get(r.day) || { usd: 0, calls: 0 }; a.usd += usd(r); a.calls += r.calls; custoDia.set(r.day, a);
    const f = custoFuncao.get(r.feature) || { usd: 0, calls: 0, entrada: 0 }; f.usd += usd(r); f.calls += r.calls; f.entrada += r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens; custoFuncao.set(r.feature, f);
  }
  const custo = {
    totalUsd: Math.round([...custoDia.values()].reduce((a, b) => a + b.usd, 0) * 100) / 100,
    porDia: [...custoDia].sort((a, b) => a[0].localeCompare(b[0])).map(([day, v]) => ({ day, usd: Math.round(v.usd * 100) / 100, chamadas: v.calls })),
    porFuncao: [...custoFuncao].sort((a, b) => b[1].usd - a[1].usd).slice(0, 10).map(([feature, v]) => ({ feature, usd: Math.round(v.usd * 100) / 100, chamadas: v.calls, entradaMedia: v.calls ? Math.round(v.entrada / v.calls) : 0 })),
  };

  // ── 5. Correções da equipe (sinal de erro da automação) ────────────────
  const reverts = (await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT count(*)::int AS feitas, count(*) FILTER (WHERE "revertedAt" IS NOT NULL)::int AS desfeitas
    FROM "LeadChange" WHERE "accountId" = ${accountId} AND "createdAt" >= ${since}`))[0] || {};
  const revertLabels = await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT left("label", 90) AS acao, count(*)::int AS n FROM "LeadChange" WHERE "accountId" = ${accountId} AND "revertedAt" IS NOT NULL AND "revertedAt" >= ${since} GROUP BY 1 ORDER BY n DESC LIMIT 6`);
  const reabertos = num((await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT count(DISTINCT n."leadId")::int AS n FROM "Note" n JOIN "Lead" l ON l."id" = n."leadId"
    WHERE l."accountId" = ${accountId} AND n."createdAt" >= ${since} AND n."content" LIKE 'Status alterado para "Aberto"%'
      AND EXISTS (SELECT 1 FROM "Note" p WHERE p."leadId" = n."leadId" AND p."createdAt" < n."createdAt" AND p."createdAt" >= n."createdAt" - interval '14 days'
                  AND (p."content" LIKE '%marcado como Perdido — por Análise automática%' OR p."content" LIKE '%marcado como Perdido — por Assistente IA%'))`))[0]?.n);
  const ajustes = (await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT count(DISTINCT "leadId")::int AS cards FROM "CreditOverride" WHERE "accountId" = ${accountId} AND "updatedAt" >= ${since}`))[0] || {};
  const manuais = num((await prisma.$queryRaw<any[]>(Prisma.sql`
    SELECT count(*)::int AS n FROM "CreditAnalysis" WHERE "accountId" = ${accountId} AND "source" = 'MANUAL' AND "createdAt" >= ${since}`))[0]?.n);

  // ── 6. Extensões ───────────────────────────────────────────────────────
  const ext = extensionStatus(accountId);
  const extensoes = Object.entries(ext).map(([bank, e]) => ({ bank, label: BANK_LABEL[bank] || bank, online: e.online, lastSeenAt: e.lastSeenAt, loginNeeded: e.loginNeeded }));

  // ── Resumo e pontos de atenção ─────────────────────────────────────────
  const tot = bancos.reduce((a, b) => ({ total: a.total + b.total, andamento: a.andamento + b.andamento, conclusivas: a.conclusivas + b.aprovadas + b.reprovadas + b.desqualificadas, falhas: a.falhas + b.falhas }), { total: 0, andamento: 0, conclusivas: 0, falhas: 0 });
  const fechadas = tot.total - tot.andamento;
  const correcoes = num(reverts.desfeitas) + reabertos + num(ajustes.cards);
  const resumo = {
    analises: tot.total, cardsAnalisados: analisados,
    conclusivasPct: pct(tot.conclusivas, fechadas), falhaPct: pct(tot.falhas, fechadas),
    medianaPrimeiroResultadoMin: round1(primeiro.mediana_min),
    avisoAte15minPct: pct(num(aviso.ate15), num(aviso.aprovadas)),
    whatsappFalhaPct: pct(num(wa.falhas), num(wa.total)),
    correcoesPor100: analisados > 0 ? Math.round((correcoes / analisados) * 1000) / 10 : null,
  };

  const atencao: { nivel: 'alto' | 'medio' | 'info'; texto: string }[] = [];
  for (const b of bancos) {
    if (b.total >= 5 && (b.falhaPct ?? 0) >= 15) {
      const top = causas.find((c) => c.bank === b.bank);
      atencao.push({ nivel: (b.falhaPct ?? 0) >= 30 ? 'alto' : 'medio', texto: `${b.label}: ${b.falhaPct}% das análises falham por motivo técnico (${b.falhas} de ${b.total - b.andamento})${top ? ` — mais comum: "${top.causa}" (${top.n}x)` : ''}.` });
    }
  }
  if (semAviso.length) atencao.push({ nivel: 'alto', texto: `${semAviso.length} aprovação(ões) há mais de 1 h sem aviso ao cliente (${semAviso.slice(0, 3).map((s) => s.name).join(', ')}${semAviso.length > 3 ? '…' : ''}).` });
  if (num(avisos.aprovacao_segurada) + num(avisos.negativa_segurada) > 0) atencao.push({ nivel: 'info', texto: `${num(avisos.aprovacao_segurada)} aviso(s) de aprovação e ${num(avisos.negativa_segurada)} de negativa ficaram esperando a equipe (IA do card desligada) — conferir se não estão parados.` });
  if ((resumo.whatsappFalhaPct ?? 0) >= 3) atencao.push({ nivel: 'medio', texto: `${resumo.whatsappFalhaPct}% das mensagens de WhatsApp falharam (${num(wa.falhas)} de ${num(wa.total)})${waErros[0] ? ` — principal motivo: ${waErros[0].motivo}` : ''}.` });
  if (reabertos > 0) atencao.push({ nivel: 'medio', texto: `${reabertos} card(s) que a automação mandou pra Perdidos foram reabertos pela equipe em seguida — revisar a regra que fechou.` });
  if (num(reverts.desfeitas) > 0) atencao.push({ nivel: 'info', texto: `A equipe usou "Reverter" ${num(reverts.desfeitas)} vez(es)${revertLabels[0] ? ` — mais comum: ${revertLabels[0].acao}` : ''}.` });
  for (const e of extensoes) { if (e.loginNeeded) atencao.push({ nivel: 'alto', texto: `${e.label}: sessão do portal vencida — alguém precisa entrar (CAPTCHA + código por e-mail); os pedidos estão esperando na fila.` }); else if (!e.online) atencao.push({ nivel: 'medio', texto: `Extensão ${e.label} sem sinal agora.` }); }
  const abertas = duvidas.reduce((a, q) => a + num(q.abertas), 0);
  if (abertas > 0) atencao.push({ nivel: 'info', texto: `${abertas} dúvida(s) da IA esperando resposta da equipe.` });

  return {
    periodoDias: d, desde: since.toISOString(), geradoEm: new Date().toISOString(),
    resumo, atencao,
    bancos, causasFalha: causas.map((c) => ({ bank: c.bank as string, label: BANK_LABEL[c.bank] || c.bank, causa: c.causa as string, n: num(c.n) })),
    tempos: {
      primeiroResultado: { n: num(primeiro.n), medianaMin: round1(primeiro.mediana_min), p90Min: round1(primeiro.p90_min) },
      aprovacaoAteAviso: { aprovadas: num(aviso.aprovadas), avisadas: num(aviso.avisadas), ate15minPct: pct(num(aviso.ate15), num(aviso.aprovadas)), medianaMin: round1(aviso.mediana_min), p90Min: round1(aviso.p90_min) },
      semAviso: semAviso.map((s) => ({ id: s.id as string, name: s.name as string, iaLigada: !!s.ia, horas: round1(s.horas) })),
    },
    avisos: {
      aprovacao: num(avisos.aprovacao), negativa: num(avisos.negativa), aprovacaoSegurada: num(avisos.aprovacao_segurada), negativaSegurada: num(avisos.negativa_segurada),
      duplicadosEvitados: num(avisos.duplicados_evitados), negativaNaoSaiu: num(avisos.negativa_nao_saiu),
      whatsapp: { total: num(wa.total), falhas: num(wa.falhas), falhaPct: pct(num(wa.falhas), num(wa.total)), erros: waErros.map((e) => ({ motivo: e.motivo as string, n: num(e.n) })) },
    },
    ia: {
      respostasAutomaticas: num(ia.respostas), perguntasAEquipe: num(ia.perguntas), humanoAssumiu,
      duvidas: duvidas.map((q) => ({ kind: q.kind as string, total: num(q.total), respondidas: num(q.respondidas), abertas: num(q.abertas), medianaMin: round1(q.mediana_min) })),
      uso: uso.map((u) => ({ feature: u.feature as string, chamadas: num(u.chamadas), erros: num(u.erros), entrada: num(u.entrada), saida: num(u.saida) })),
      custo,
    },
    correcoes: { feitas: num(reverts.feitas), desfeitas: num(reverts.desfeitas), principais: revertLabels.map((r) => ({ acao: r.acao as string, n: num(r.n) })), reabertosAposFechamentoAutomatico: reabertos, cardsComAjuste: num(ajustes.cards), resultadosManuais: manuais },
    extensoes,
  };
}
