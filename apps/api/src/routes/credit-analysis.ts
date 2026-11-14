import express, { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getScopeDepartmentIds } from '../services/department.service';
import { previewApprovalNotice, sendApprovalNoticeNow, forwardApprovalToClient } from '../services/approval-notice.service';
import { sendRejectionAndClose } from '../services/credit-auto.service';
import { setLeadAutoPause, expediteCheck } from '../services/credit-analysis.service';
import { getAutoSetting, setAutoSetting, setPaused, setPauseInterEmails } from '../services/credit-auto.service';
import { pedirBuscaPortal, claimBuscas, resultadoBusca, escolherDoPortal } from '../services/busca-portal.service';
import { requestSimulationDocs, claimSimulationDocs, finishSimulationDoc, finishInterDoc, finishCreditasDoc, finishItauDoc, failSimulationDoc, listSimulationDocs, parseInstitutions } from '../services/simulation-doc.service';
import {
  BANK_KEYS, EXT_BANK_KEYS, FH_BANK, FH_RUN_BANKS, FH_ITAU_BANK, fhBoard, EXTENSION_STATUS, foraDoHorario, liberadoAte, setLoginNeeded, alertLoginNeeded, holdRunForLogin, extensionsLive, board, createRequests, claimQueue, reportAnalysis, updateAnalysis,
  registerManual, chooseAnalysis, trocarOpcaoCreditas, touchExtension, extensionStatus, leadAnalyses, getOverride, setOverrides, creditMetrics, acquireLock, releaseLock, renewLock, releaseOrphans,
} from '../services/credit-analysis.service';

/** Aba "Análise de Crédito" — ver credit-analysis.service.ts. As extensões do Chrome entram com o login normal do CRM. */
const router = Router();
router.use(authMiddleware);

const io = (req: AuthRequest) => (req as any).app.get('io');
const emit = (req: AuthRequest, extra: Record<string, any> = {}) =>
  io(req)?.to(`account_${req.user!.accountId}`).emit('credit_analysis_updated', extra);
const fail = (res: Response, err: any, fallback: string, code = 500) => res.status(code).json({ error: err?.message || fallback });

router.get('/board', async (req: AuthRequest, res: Response) => {
  try {
    const scope = await getScopeDepartmentIds(req.user!.accountId, req.user!.id, req.user!.role);
    res.json({ leads: await board(prisma, { accountId: req.user!.accountId, scopeDepartmentIds: scope }), extensions: extensionStatus(req.user!.accountId) });
  } catch (err) { fail(res, err, 'Erro ao carregar as análises'); }
});

// Total de crédito por banco em cada estágio do Kanban (Fabio 28/10: "em cada estágio mostre o total de crédito feito por cada banco") e o selo do banco
// no card ("o símbolo do banco no card que está fazendo naquele banco"). Devolve, por card do funil, o valor aprovado de cada banco (a aprovação mais
// recente; a escolhida ⭐ do banco, se houver) e o banco escolhido — a coluna soma os cards que está mostrando, então segue a busca e os filtros da tela.
router.get('/approved-by-lead', async (req: AuthRequest, res: Response) => {
  try {
    const pipelineId = String(req.query.pipelineId || '');
    if (!pipelineId) return res.json({});
    const rows = await prisma.creditAnalysis.findMany({
      where: { accountId: req.user!.accountId, dryRun: false, status: 'APPROVED', approvedValue: { gt: 0 }, lead: { pipelineId } },
      orderBy: { createdAt: 'desc' },
      select: { leadId: true, bank: true, approvedValue: true, chosen: true },
    });
    const out: Record<string, { banks: Record<string, number>; chosen?: string }> = {};
    const escolhida = new Set<string>();
    for (const r of rows) {
      const k = `${r.leadId}:${r.bank}`;
      const card = (out[r.leadId] ||= { banks: {} });
      if (r.chosen && !escolhida.has(k)) { card.banks[r.bank] = r.approvedValue!; escolhida.add(k); card.chosen ||= r.bank; continue; }
      if (!(r.bank in card.banks)) card.banks[r.bank] = r.approvedValue!;
    }
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao somar o crédito por banco'); }
});

// Aba "Análise de Crédito — Financiamento Imobiliário" (Fabio 27/10): cards do Financiamento Habitacional × 6 bancos.
router.get('/fh-board', async (req: AuthRequest, res: Response) => {
  try {
    const scope = await getScopeDepartmentIds(req.user!.accountId, req.user!.id, req.user!.role);
    res.json({ leads: await fhBoard(prisma, { accountId: req.user!.accountId, scopeDepartmentIds: scope }), extension: extensionStatus(req.user!.accountId)[FH_BANK] || null, extensions: extensionStatus(req.user!.accountId) });
  } catch (err) { fail(res, err, 'Erro ao carregar o Financiamento'); }
});
// Financiamento de UM card (bloco do card, aba Financiamento — Fabio 29/10: o card do Jaime mostrava os bancos do Home Equity com "—").
router.get('/fh-lead/:leadId', async (req: AuthRequest, res: Response) => {
  try {
    const rows = await fhBoard(prisma, { accountId: req.user!.accountId, scopeDepartmentIds: [], leadId: req.params.leadId });
    res.json({ lead: rows[0] || null, extensions: extensionStatus(req.user!.accountId) });
  } catch (err) { fail(res, err, 'Erro ao carregar o Financiamento do card'); }
});
// Rodar (simulação nova nos 4 bancos do Credimorar) ou conferir a situação de um cliente do Financiamento.
router.post('/fh-request', async (req: AuthRequest, res: Response) => {
  try {
    const leadId = String(req.body?.leadId || '');
    const kind = req.body?.kind === 'CHECK' ? 'CHECK' : 'RUN';
    if (!leadId) return res.status(400).json({ error: 'leadId é obrigatório' });
    // Construção (Fabio 05/11): só pela CAIXA, financiado acima de R$ 200 mil — o botão também não roda Credimorar/Inter/Itaú.
    if (kind === 'RUN') {
      const { ehConstrucaoFh, financiadoFh, textoConstrucao } = require('../services/construcao-fh.service') as typeof import('../services/construcao-fh.service');
      const l = await prisma.lead.findFirst({ where: { id: leadId, accountId: req.user!.accountId }, select: { customFields: true } });
      const prop = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Financiamento Habitacional' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
      const cf = (l?.customFields || {}) as Record<string, any>;
      if (l && ehConstrucaoFh(prop?.content || '', cf)) return res.status(400).json({ error: textoConstrucao(financiadoFh(prop?.content || '', cf)).replace(/^🏗️ /, '') });
    }
    const out = await createRequests(prisma, { accountId: req.user!.accountId, userId: req.user!.id, leadIds: [leadId], banks: Array.isArray(req.body?.banks) && req.body.banks.length ? FH_RUN_BANKS.filter((b) => req.body.banks.includes(b)) : FH_RUN_BANKS, dryRun: req.body?.dryRun === true, kind, force: kind === 'RUN', queueIfBusy: kind === 'RUN' }); // Credimorar (Bradesco/Santander) + Inter no nosso portal + Itaú no portal Itaú Imóveis (03/11)
    emit(req, { leadId });
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao pedir a análise do Financiamento'); }
});

// "Ajustar" do Financiamento (Fabio 11/11, Jaime): no FH os valores vêm do CARD (regra de 05/11) — grava só estas chaves no card (jsonb, sem regravar o resto) e deixa nota.
router.put('/fh-valores', async (req: AuthRequest, res: Response) => {
  try {
    const leadId = String(req.body?.leadId || '');
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId: req.user!.accountId }, select: { id: true, customFields: true } });
    if (!lead) return res.status(404).json({ error: 'Card não encontrado' });
    const cf = (lead.customFields || {}) as Record<string, any>;
    const num = (v: unknown) => { const t = String(v ?? '').trim(); if (!t) return null; const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
    const v = (req.body?.valores || {}) as Record<string, unknown>;
    const novo: Record<string, string> = {};
    const imovel = num(v.valor_imovel), credito = num(v.valor_credito), renda1 = num(v.renda_1), renda2 = num(v.renda_2), prazo = num(v.prazo);
    if (imovel) novo.valor_imovel = String(imovel);
    if (credito) novo.valor_credito = String(credito);
    // Entrada = imóvel − financiamento: a extensão lê a entrada antes do financiamento, então as duas andam juntas.
    const im = imovel || num(cf.valor_imovel), cr = credito || num(cf.valor_credito);
    if ((imovel || credito) && im && cr && im > cr) novo.valor_entrada = String(Math.round((im - cr) * 100) / 100);
    if (renda1) novo.renda_1 = String(renda1);
    if (renda2) novo.renda_2 = String(renda2);
    if (prazo) { if (prazo < 60 || prazo > 420) return res.status(400).json({ error: 'Prazo entre 60 e 420 meses' }); novo._fhPrazo = String(Math.round(prazo)); }
    if (!Object.keys(novo).length) return res.status(400).json({ error: 'Nada para ajustar' });
    await prisma.$executeRawUnsafe(`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || $1::jsonb WHERE id = $2`, JSON.stringify(novo), leadId);
    const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
    const rot: Record<string, string> = { valor_imovel: 'valor do imóvel', valor_credito: 'financiamento', valor_entrada: 'entrada', renda_1: 'renda do 1º', renda_2: 'renda do 2º', _fhPrazo: 'prazo (meses)' };
    const brl = (x: unknown) => (num(x) ? `R$ ${num(x)!.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');
    const linhas = Object.entries(novo).map(([k, val]) => `• ${rot[k]}: ${k === '_fhPrazo' ? (cf[k] || '—') : brl(cf[k])} → ${k === '_fhPrazo' ? val : brl(val)}`);
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `✎ ${quem} ajustou o Financiamento (vale na próxima rodada):\n${linhas.join('\n')}` } }).catch(() => {});
    emit(req, { leadId });
    res.json({ ok: true, valores: novo });
  } catch (err) { fail(res, err, 'Erro ao ajustar o Financiamento'); }
});

// CAIXA/BRB do Financiamento rodam à mão (ainda sem extensão): a equipe registra o resultado aqui (Fabio 29/10 — "só após aprovar na CAIXA" mandam os próximos passos).
router.post('/fh-manual-result', async (req: AuthRequest, res: Response) => {
  try {
    const leadId = String(req.body?.leadId || '');
    const bank = ['CAIXA_FH', 'BRB_FH'].includes(req.body?.bank) ? String(req.body.bank) : '';
    const status = ['APPROVED', 'CONDITIONAL', 'REJECTED'].includes(req.body?.status) ? String(req.body.status) : '';
    if (!leadId || !bank || !status) return res.status(400).json({ error: 'leadId, bank (CAIXA_FH/BRB_FH) e status (APPROVED/CONDITIONAL/REJECTED) são obrigatórios' });
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId: req.user!.accountId }, select: { id: true } });
    if (!lead) return res.status(404).json({ error: 'Card não encontrado' });
    const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
    const valor = num(req.body?.value); const prazo = num(req.body?.term); const parcela = num(req.body?.firstInstallment);
    const taxa = String(req.body?.rate || '').trim().slice(0, 60) || null;
    const nome = bank === 'CAIXA_FH' ? 'CAIXA' : 'BRB';
    const brl = (n: number) => `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const rotulo = status === 'APPROVED' ? 'Aprovado' : status === 'CONDITIONAL' ? 'Aprovado condicional' : 'Reprovado';
    const quem = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
    const detail = `${rotulo}${valor ? `, ${brl(valor)}` : ''}${prazo ? `, ${prazo} meses` : ''}${taxa ? `, taxa ${taxa}` : ''}${parcela ? `, 1ª parcela ${brl(parcela)}` : ''} — registrado à mão por ${quem}`;
    const row = await prisma.creditAnalysis.create({ data: { accountId: req.user!.accountId, leadId, bank, kind: 'RUN', status, source: 'MANUAL', detail, approvedValue: status === 'REJECTED' ? null : valor, termMonths: prazo ? Math.round(prazo) : null, rate: taxa, firstInstallment: parcela, requestedById: req.user!.id, finishedAt: new Date() } });
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 ${nome} (Financiamento): ${detail}.` } }).catch(() => {});
    emit(req, { leadId });
    res.json({ ok: true, id: row.id });
  } catch (err) { fail(res, err, 'Erro ao registrar o resultado'); }
});

// Análises de UM card (bloco dentro do card).
router.get('/lead/:leadId', async (req: AuthRequest, res: Response) => {
  try {
    const scope = await getScopeDepartmentIds(req.user!.accountId, req.user!.id, req.user!.role);
    const out = await leadAnalyses(prisma, { accountId: req.user!.accountId, leadId: req.params.leadId, scopeDepartmentIds: scope });
    if (!out) return res.status(404).json({ error: 'Card não encontrado' });
    res.json({ ...out, extensions: extensionStatus(req.user!.accountId) });
  } catch (err) { fail(res, err, 'Erro ao carregar as análises do card'); }
});

// Ajuste do cliente pra um banco (a extensão consulta antes de preencher o portal).
router.get('/overrides', async (req: AuthRequest, res: Response) => {
  const bank = String(req.query.bank || '').toUpperCase();
  const leadId = String(req.query.leadId || '');
  if (!leadId || !EXT_BANK_KEYS.includes(bank)) return res.status(400).json({ error: 'leadId e bank são obrigatórios' }); // só leitura: ITAU_FH nunca tem ajuste gravado (devolve data:null), mas a extensão do Itaú pode perguntar
  try {
    res.json({ data: await getOverride(prisma, { accountId: req.user!.accountId, leadId, bank }) });
  } catch (err) { fail(res, err, 'Erro ao buscar o ajuste'); }
});

// "Conferir resultado": a extensão lê agora o resultado de uma proposta já enviada (cliente "Em análise").
router.post('/check-now', async (req: AuthRequest, res: Response) => {
  const b = req.body || {};
  const bank = String(b.bank || '').toUpperCase();
  if (!b.leadId || !EXT_BANK_KEYS.includes(bank)) return res.status(400).json({ error: 'leadId e banco são obrigatórios' }); // Financiamento também (03/11): conferência do Itaú/Inter/Credimorar FH de card em STOP só anda pedida por pessoa
  try {
    // `semAviso: true` (Fabio 14/11): quando essa conferência terminar, os valores novos ficam como já avisados — o aviso de aprovação não sai sozinho (credit-auto noticeClients).
    if (b.semAviso === true) {
      const seg = JSON.stringify({ at: new Date().toISOString(), bank });
      await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_avisoSegurado}', ${seg}::jsonb, true) WHERE id = ${String(b.leadId)} AND "accountId" = ${req.user!.accountId}`;
    }
    const out = await expediteCheck(prisma, { accountId: req.user!.accountId, leadId: String(b.leadId), bank, userId: req.user!.id });
    emit(req, { leadId: String(b.leadId) });
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao pedir a conferência', 400); }
});

// Pausa/retoma a análise automática SÓ de um cliente (botão "Pausar" no cartão do cliente).
router.put('/pause', async (req: AuthRequest, res: Response) => {
  const b = req.body || {};
  if (!b.leadId) return res.status(400).json({ error: 'leadId é obrigatório' });
  try {
    const userName = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || undefined;
    const out = await setLeadAutoPause(prisma, { accountId: req.user!.accountId, leadId: String(b.leadId), paused: b.paused !== false, userId: req.user!.id, userName });
    emit(req, { leadId: String(b.leadId) });
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao pausar o cliente', 400); }
});

// Grava o ajuste (valores, renda, prazo, inverter) nos bancos escolhidos; `merge` soma ao que já existe; vazio apaga.
router.put('/overrides', async (req: AuthRequest, res: Response) => {
  const b = req.body || {};
  const banks = Array.isArray(b.banks) ? (b.banks as unknown[]).map((v) => String(v).toUpperCase()).filter((v) => EXT_BANK_KEYS.includes(v)) : []; // HE + FH
  if (!b.leadId || !banks.length) return res.status(400).json({ error: 'leadId e pelo menos um banco são obrigatórios' });
  try {
    const userName = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || undefined;
    const out = await setOverrides(prisma, { accountId: req.user!.accountId, userId: req.user!.id, userName, leadId: String(b.leadId), banks, data: b.data && typeof b.data === 'object' ? b.data : {}, merge: b.merge === true });
    emit(req, { leadId: String(b.leadId) });
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao salvar o ajuste', 400); }
});

// Métricas do Dashboard: aprovados por banco, taxa de aprovação, tempo até o resultado.
router.get('/metrics', async (req: AuthRequest, res: Response) => {
  try {
    const scope = await getScopeDepartmentIds(req.user!.accountId, req.user!.id, req.user!.role);
    res.json(await creditMetrics(prisma, {
      accountId: req.user!.accountId, scopeDepartmentIds: scope,
      departmentId: req.query.departmentId ? String(req.query.departmentId) : undefined,
      months: Math.min(Math.max(Number(req.query.months) || 6, 1), 24),
    }));
  } catch (err) { fail(res, err, 'Erro ao calcular as métricas'); }
});

// Uma extensão por vez usa o navegador: pede a vez (ok:false = outra está rodando, tente de novo) e devolve quando termina.
router.post('/lock', (req: AuthRequest, res: Response) => {
  const bank = String(req.body?.bank || '').toUpperCase();
  if (!BANK_KEYS.includes(bank) && bank !== FH_ITAU_BANK) return res.status(400).json({ error: 'banco inválido' }); // ITAU_FH: extensão própria do Itaú Imóveis (03/11) pede a vez com a própria chave
  res.json(acquireLock(req.user!.accountId, bank));
});
// A extensão acabou de iniciar (carregou/recarregou/reiniciou): o que estava "rodando" nela se perdeu — falha na hora, com o motivo.
router.post('/release', async (req: AuthRequest, res: Response) => {
  try {
    const bank = String(req.body?.bank || '').toUpperCase();
    if (!EXT_BANK_KEYS.includes(bank)) return res.status(400).json({ error: 'banco inválido' });
    res.json({ ok: true, released: await releaseOrphans(prisma, { accountId: req.user!.accountId, bank }) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/unlock', (req: AuthRequest, res: Response) => {
  const bank = String(req.body?.bank || '').toUpperCase();
  if (!BANK_KEYS.includes(bank) && bank !== FH_ITAU_BANK) return res.status(400).json({ error: 'banco inválido' });
  releaseLock(req.user!.accountId, bank);
  res.json({ ok: true });
});

// "Avisar cliente": prévia do texto (todas as opções aprovadas, com o nome em que saiu) e envio.
router.get('/notify-client/preview', async (req: AuthRequest, res: Response) => {
  try {
    const leadId = String(req.query.leadId || '');
    const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId: req.user!.accountId }, select: { id: true } });
    if (!lead) return res.status(404).json({ error: 'Card não encontrado' });
    const out = await previewApprovalNotice(leadId);
    if (!out) return res.status(404).json({ error: 'Não há opção aprovada com valor pra avisar o cliente.' });
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao montar o aviso'); }
});
router.post('/notify-client', async (req: AuthRequest, res: Response) => {
  try {
    const out = await sendApprovalNoticeNow({ accountId: req.user!.accountId, leadId: String(req.body?.leadId || ''), userId: req.user!.id, io: io(req), sendDocs: req.body?.sendDocs !== false, moveStage: req.body?.moveStage !== false });
    if (!out.ok) return res.status(400).json({ error: out.error });
    emit(req, { leadId: String(req.body?.leadId || '') });
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao avisar o cliente'); }
});

// Botão "Avisar negativa": a negativa automática só sai com a IA do card ligada; com ela desligada a equipe manda por aqui (e o card vai pra Perdidos).
router.post('/notify-rejection', async (req: AuthRequest, res: Response) => {
  try {
    const leadId = String(req.body?.leadId || '');
    const out = await sendRejectionAndClose({ accountId: req.user!.accountId, leadId, userId: req.user!.id, io: io(req) });
    if (!out.ok) return res.status(400).json({ error: out.error });
    emit(req, { leadId });
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao avisar a negativa'); }
});

// Botão "Mandar propostas pra escolher" (Fabio 12/11): documentação completa, 2+ bancos aprovados e nenhuma ⭐ — com a IA do card desligada as propostas não vão sozinhas;
// a equipe manda por aqui (uma mensagem por proposta com o botão "Seguir com esta" e a orientação de tocar). Pode mandar de novo.
router.post('/ask-choice', async (req: AuthRequest, res: Response) => {
  try {
    const leadId = String(req.body?.leadId || '');
    const { sendProposalChoice } = require('../services/approval-notice.service') as typeof import('../services/approval-notice.service');
    const out = await sendProposalChoice({ accountId: req.user!.accountId, leadId, userId: req.user!.id, io: io(req), quem: 'equipe' });
    if (!out.ok) return res.status(400).json({ error: out.error });
    emit(req, { leadId });
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao mandar as propostas'); }
});

// Chave da análise automática (só admin liga/desliga). A extensão consulta pra não rodar sozinha em duplicidade.
router.get('/auto', async (req: AuthRequest, res: Response) => {
  try { res.json(await getAutoSetting(req.user!.accountId)); } catch (err) { fail(res, err, 'Erro ao ler a análise automática'); }
});
router.put('/auto', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só administradores ligam a análise automática' });
  try {
    if (typeof req.body?.contractingAuto === 'boolean') {
      const { setContractingAuto } = require('../services/contracting-auto.service') as typeof import('../services/contracting-auto.service');
      await setContractingAuto(req.user!.accountId, req.body.contractingAuto, req.user!.id);
      return res.json(await getAutoSetting(req.user!.accountId));
    }
  } catch (err) { return fail(res, err, 'Erro ao salvar a chave da contratação automática'); }
  try { if (typeof req.body?.pauseInterEmails === 'boolean') return res.json(await setPauseInterEmails(req.user!.accountId, req.body.pauseInterEmails, req.user!.id)); } catch (err) { return fail(res, err, 'Erro ao salvar a pausa dos e-mails do Inter'); }
  try { if (typeof req.body?.paused === 'boolean') return res.json(await setPaused(req.user!.accountId, req.body.paused, req.user!.id)); } catch (err) { return fail(res, err, 'Erro ao salvar a pausa'); }
  try { res.json(await setAutoSetting(req.user!.accountId, req.body?.enabled === true, req.user!.id)); } catch (err) { fail(res, err, 'Erro ao salvar a análise automática'); }
});

// Piloto da contratação automática num card só (Fabio 13/11: "nosso primeiro processo do Santander rodando automático") — só admin.
router.put('/auto/lead/:leadId', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só administradores ligam a contratação automática' });
  try {
    const lead = await prisma.lead.findFirst({ where: { id: req.params.leadId, accountId: req.user!.accountId }, select: { id: true } });
    if (!lead) return res.status(404).json({ error: 'Card não encontrado' });
    const { setPilotoContratacao, pilotoContratacao } = require('../services/contracting-auto.service') as typeof import('../services/contracting-auto.service');
    const u = await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } });
    await setPilotoContratacao(lead.id, req.body?.on === true, u?.name || 'equipe');
    res.json({ leadId: lead.id, on: await pilotoContratacao(lead.id) });
  } catch (err) { fail(res, err, 'Erro ao ligar a contratação automática no card'); }
});

router.get('/extensions', (req: AuthRequest, res: Response) => res.json(extensionStatus(req.user!.accountId)));
// Varre os e-mails da Creditas "descontinuada por falta de movimentação" já recebidos e marca o stand-by nos cards (Fabio 03/11).
router.post('/creditas-standby-scan', async (req: AuthRequest, res: Response) => {
  try { const { scanCreditasStandBy } = require('../services/creditas-scr.service') as typeof import('../services/creditas-scr.service'); res.json(await scanCreditasStandBy(req.user!.accountId, Number(req.body?.dias) || 30)); } catch (err) { fail(res, err, 'Erro ao varrer os e-mails da Creditas'); }
});
// Painel do topo: o que cada extensão está fazendo agora (cliente, passo, fila).
router.get('/live', async (req: AuthRequest, res: Response) => {
  try { res.json(await extensionsLive(prisma, req.user!.accountId, req.query.produto === 'fh' ? 'FH' : 'HE')); } catch (err) { fail(res, err, 'Erro ao ler as extensões'); }
});

// Dispara a análise de vários clientes em vários bancos (a extensão busca na fila).
router.post('/requests', async (req: AuthRequest, res: Response) => {
  const leadIds = Array.isArray(req.body?.leadIds) ? (req.body.leadIds as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  const banks = Array.isArray(req.body?.banks) ? (req.body.banks as unknown[]).filter((v): v is string => typeof v === 'string' && BANK_KEYS.includes(v)) : [];
  if (!leadIds.length) return res.status(400).json({ error: 'Escolha pelo menos um cliente' });
  if (!banks.length) return res.status(400).json({ error: 'Escolha pelo menos um banco' });
  try {
    const out = await createRequests(prisma, { accountId: req.user!.accountId, userId: req.user!.id, leadIds, banks, dryRun: req.body?.dryRun === true, kind: req.body?.kind === 'CHECK' ? 'CHECK' : 'RUN', force: req.body?.force === true, queueIfBusy: req.body?.force === true });
    emit(req);
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao pedir as análises'); }
});

// A extensão do banco pergunta: "tem pedido pra mim?" (ela chama a cada minuto).
router.get('/queue', async (req: AuthRequest, res: Response) => {
  const bank = String(req.query.bank || '');
  if (!EXT_BANK_KEYS.includes(bank)) return res.status(400).json({ error: 'banco inválido' });
  try {
    touchExtension(req.user!.accountId, bank, typeof req.query.extId === 'string' ? req.query.extId : null, req.user!.id);
    // A extensão diz se o portal está pedindo login (sessão vencida): `login=needed` liga o aviso na tela + push; `login=ok` desliga.
    if (req.query.login === 'needed') { setLoginNeeded(req.user!.accountId, bank, true); alertLoginNeeded(req.user!.accountId, bank); }
    else if (req.query.login === 'ok') setLoginNeeded(req.user!.accountId, bank, false);
    const caps = typeof req.query.caps === 'string' ? req.query.caps.split(',') : [];
    const items = req.query.claim === '0' ? [] : await claimQueue(prisma, { accountId: req.user!.accountId, bank, limit: Number(req.query.limit) || 3, caps });
    if (items.length) emit(req);
    // PDFs de simulação pedidos (só pra extensão que avisa saber atender: caps inclui "doc").
    const lib = await liberadoAte(prisma, req.user!.accountId);
    const docs = caps.includes('doc') && req.query.claim !== '0' && (!foraDoHorario() || lib) ? await claimSimulationDocs(prisma, { accountId: req.user!.accountId, extBank: bank, limit: 2 }) : [];
    // `liberadoAte`: a extensão também tem a trava de 07h–22h; com isto ela sabe que pode trabalhar fora do horário até essa hora.
    // Busca de propostas no portal pedida no card (Fabio 05/11) — só leitura; extensão que avisa saber atender (caps inclui "busca").
    const buscas = caps.includes('busca') && req.query.claim !== '0' ? await claimBuscas(req.user!.accountId, bank, 1) : [];
    res.json({ items, docs, buscas, liberadoAte: lib ? lib.toISOString() : null });
  } catch (err) { fail(res, err, 'Erro ao buscar a fila'); }
});

// A extensão conta o que aconteceu. `status` aceita os termos dela (enviando, enviado, aprovado…) ou os do CRM.
router.post('/report', async (req: AuthRequest, res: Response) => {
  const b = req.body || {};
  const raw = String(b.status || '');
  const status = EXTENSION_STATUS[raw.toLowerCase()] || raw.toUpperCase();
  const bank = String(b.bank || '').toUpperCase();
  if (!b.leadId || !EXT_BANK_KEYS.includes(bank) || !status) return res.status(400).json({ error: 'leadId, bank e status são obrigatórios' });
  try {
    touchExtension(req.user!.accountId, bank, null, req.user!.id);
    // Sessão do portal vencida: o pedido volta pra fila, a tela mostra "deslogada" e a equipe recebe push (nada de "Falhou").
    if (raw.toLowerCase() === 'aguardando_login') {
      await holdRunForLogin(prisma, { accountId: req.user!.accountId, requestId: b.requestId ? String(b.requestId) : undefined, leadId: String(b.leadId), bank });
      setLoginNeeded(req.user!.accountId, bank, true);
      alertLoginNeeded(req.user!.accountId, bank);
      emit(req, { leadId: String(b.leadId) });
      return res.json({ ok: true, hold: true });
    }
    renewLock(req.user!.accountId, bank);
    const row = await reportAnalysis(prisma, { accountId: req.user!.accountId, requestId: b.requestId ? String(b.requestId) : undefined, leadId: String(b.leadId), bank, status, detail: b.detail ? String(b.detail) : undefined, result: b.result && typeof b.result === 'object' ? b.result : {} });
    emit(req, { leadId: row.leadId });
    res.json({ ok: true, id: row.id, status: row.status, ...((row as any).cancelled ? { cancel: true } : {}) });
  } catch (err) { fail(res, err, 'Erro ao registrar a análise', 400); }
});

// Registrar à mão (ex.: Inter lido no portal pelo Fabio ou pela skill).
router.post('/manual', async (req: AuthRequest, res: Response) => {
  const b = req.body || {};
  const bank = String(b.bank || '').toUpperCase();
  if (!b.leadId || !BANK_KEYS.includes(bank) || !b.status) return res.status(400).json({ error: 'leadId, bank e status são obrigatórios' });
  try {
    const row = await registerManual(prisma, { accountId: req.user!.accountId, userId: req.user!.id, leadId: String(b.leadId), bank, status: String(b.status).toUpperCase(), detail: b.detail ? String(b.detail) : undefined, result: b.result && typeof b.result === 'object' ? b.result : b });
    emit(req, { leadId: row.leadId });
    res.json(row);
  } catch (err) { fail(res, err, 'Erro ao registrar', 400); }
});

// ── PDF da simulação pro cliente (com a logo A&F) ─────────────────────────────────────────────
// Pede à extensão do Credimorar que baixe o "Evolução das parcelas" original; o CRM põe a logo e manda no WhatsApp.
router.post('/simulation-docs', async (req: AuthRequest, res: Response) => {
  try {
    const leadId = String(req.body?.leadId || '');
    const institutions = parseInstitutions(req.body?.institutions ?? req.body?.institution);
    if (!leadId || !institutions.length) return res.status(400).json({ error: 'leadId e pelo menos uma instituição (SANTANDER ou INTER) são obrigatórios' });
    // `privado: true` (03/11): o PDF fica só pra equipe (status PRIVATE, baixa em /api/assistant/simulation/:id/pdf) — nunca vai ao cliente; serve pra conferir antes.
    const out = await requestSimulationDocs(prisma, { accountId: req.user!.accountId, leadId, institutions, userId: req.user!.id, source: req.body?.privado === true ? 'ASSISTANT' : 'USER', caption: typeof req.body?.caption === 'string' ? req.body.caption : undefined });
    emit(req, { leadId });
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao pedir o PDF da simulação', 400); }
});
router.get('/simulation-docs', async (req: AuthRequest, res: Response) => {
  try { res.json(await listSimulationDocs(prisma, { accountId: req.user!.accountId, leadId: String(req.query.leadId || '') })); } catch (err) { fail(res, err, 'Erro ao listar os PDFs pedidos'); }
});
// A extensão devolve o PDF ORIGINAL do portal (corpo = bytes do PDF).
router.post('/simulation-docs/:id/upload', express.raw({ type: () => true, limit: '20mb' }), async (req: AuthRequest, res: Response) => {
  try {
    const pdf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (pdf.length < 1000 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') return res.status(400).json({ error: 'o corpo não é um PDF' });
    const out = await finishSimulationDoc(prisma, { accountId: req.user!.accountId, id: req.params.id, pdf, io: io(req) });
    emit(req);
    res.status(out.ok ? 200 : 422).json(out);
  } catch (err) { fail(res, err, 'Erro ao enviar a simulação', 400); }
});
// Inter: a extensão manda os dados da proposta + o PDF "Evolução Teórica" baixado do portal (JSON, PDF em base64).
router.post('/simulation-docs/:id/inter', async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    const pdf = typeof b.pdfBase64 === 'string' ? Buffer.from(b.pdfBase64, 'base64') : Buffer.alloc(0);
    if (pdf.length < 1000 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') return res.status(400).json({ error: 'pdfBase64 não é um PDF' });
    const proposal = b.proposal && typeof b.proposal === 'object' ? b.proposal : {};
    const out = await finishInterDoc(prisma, { accountId: req.user!.accountId, id: req.params.id, proposal, pdf, io: io(req) });
    emit(req);
    res.status(out.ok ? 200 : 422).json(out);
  } catch (err) { fail(res, err, 'Erro ao montar a simulação do Inter', 400); }
});
// Creditas: a extensão manda o que leu da API do portal (resumo do prazo + tabela mês a mês).
router.post('/simulation-docs/:id/creditas', async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.summary || !Array.isArray(b.installments) || !b.input) return res.status(400).json({ error: 'summary, installments e input são obrigatórios' });
    const out = await finishCreditasDoc(prisma, { accountId: req.user!.accountId, id: req.params.id, data: { input: b.input, summary: b.summary, installments: b.installments }, io: io(req) });
    emit(req);
    res.status(out.ok ? 200 : 422).json(out);
  } catch (err) { fail(res, err, 'Erro ao montar a simulação da Creditas', 400); }
});
// Itaú (Financiamento, 03/11): a extensão manda o resumo e a tabela mês a mês que o simulador do portal Itaú Imóveis devolveu pela proposta aprovada.
router.post('/simulation-docs/:id/itau', async (req: AuthRequest, res: Response) => {
  try {
    const b = req.body || {};
    if (!b.resumo || !Array.isArray(b.parcelas)) return res.status(400).json({ error: 'resumo e parcelas são obrigatórios' });
    const out = await finishItauDoc(prisma, { accountId: req.user!.accountId, id: req.params.id, data: { resumo: b.resumo, parcelas: b.parcelas }, io: io(req) });
    emit(req);
    res.status(out.ok ? 200 : 422).json(out);
  } catch (err) { fail(res, err, 'Erro ao montar a simulação do Itaú', 400); }
});
router.post('/simulation-docs/:id/fail', async (req: AuthRequest, res: Response) => {
  try {
    await failSimulationDoc(prisma, { accountId: req.user!.accountId, id: req.params.id, reason: String(req.body?.reason || 'a extensão não conseguiu baixar o PDF') });
    emit(req);
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Erro ao registrar a falha', 400); }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const row = await updateAnalysis(prisma, { accountId: req.user!.accountId, id: req.params.id, patch: req.body || {} });
    emit(req, { leadId: row.leadId });
    res.json(row);
  } catch (err) { fail(res, err, 'Erro ao salvar', 400); }
});

// "Seguir com esta" numa opção da Creditas (Fabio 14/11): troca a opção escolhida pela da posição `i` da lista do portal; não avisa o cliente sozinho.
router.post('/:id/opcao', async (req: AuthRequest, res: Response) => {
  const i = Number((req.body || {}).i);
  if (!Number.isInteger(i) || i < 0) return res.status(400).json({ error: 'opção inválida' });
  try {
    const userName = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || undefined;
    const row = await trocarOpcaoCreditas(prisma, { accountId: req.user!.accountId, id: req.params.id, i, userName });
    emit(req, { leadId: row.leadId });
    res.json(row);
  } catch (err) { fail(res, err, 'Erro ao trocar a opção', 400); }
});

router.post('/:id/choose', async (req: AuthRequest, res: Response) => {
  try {
    const userName = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || undefined;
    const out = await chooseAnalysis(prisma, { accountId: req.user!.accountId, id: req.params.id, userName });
    emit(req);
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao escolher a proposta', 400); }
});

// ── Buscar propostas no portal do banco (Fabio 05/11: listar as aprovadas, inclusive as feitas à mão, pra escolher) ──────────────
router.post('/busca-portal', async (req: AuthRequest, res: Response) => {
  const leadId = String(req.body?.leadId || ''); const bank = String(req.body?.bank || 'INTER').toUpperCase();
  if (!leadId) return res.status(400).json({ error: 'leadId obrigatório' });
  try {
    const nome = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'equipe';
    const erro = await pedirBuscaPortal(req.user!.accountId, leadId, bank, nome);
    if (erro) return res.status(400).json({ error: erro });
    emit(req, { leadId });
    res.json({ ok: true });
  } catch (err) { fail(res, err, 'Erro ao pedir a busca no portal'); }
});
router.post('/busca-portal/:leadId/resultado', async (req: AuthRequest, res: Response) => {
  const bank = String(req.body?.bank || 'INTER').toUpperCase();
  try { await resultadoBusca(req.user!.accountId, req.params.leadId, bank, req.body || {}); emit(req, { leadId: req.params.leadId }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Erro ao gravar a busca'); }
});
router.post('/busca-portal/:leadId/escolher', async (req: AuthRequest, res: Response) => {
  const bank = String(req.body?.bank || 'INTER').toUpperCase(); const numero = String(req.body?.numero || '');
  if (!numero) return res.status(400).json({ error: 'numero obrigatório' });
  try {
    const nome = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || undefined;
    const r = await escolherDoPortal(req.user!.accountId, req.params.leadId, bank, numero, { id: req.user!.id, nome });
    if ('erro' in r) return res.status(400).json({ error: r.erro });
    emit(req, { leadId: req.params.leadId });
    res.json(r);
  } catch (err) { fail(res, err, 'Erro ao escolher a proposta'); }
});

// Botão "Encaminhar aprovação ao cliente" de cada proposta aprovada (Fabio 02/11): só os dados dela + o PDF da simulação, quando o banco tem.
router.post('/:id/forward', async (req: AuthRequest, res: Response) => {
  try {
    const leadId = String(req.body?.leadId || '');
    const out = await forwardApprovalToClient({ accountId: req.user!.accountId, leadId, analysisId: req.params.id, userId: req.user!.id, io: io(req) });
    if (!out.ok) return res.status(400).json({ error: out.error });
    emit(req, { leadId });
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao encaminhar a proposta ao cliente'); }
});

export default router;
