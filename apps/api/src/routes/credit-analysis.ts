import express, { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getScopeDepartmentIds } from '../services/department.service';
import { previewApprovalNotice, sendApprovalNoticeNow } from '../services/approval-notice.service';
import { setLeadAutoPause } from '../services/credit-analysis.service';
import { getAutoSetting, setAutoSetting, setPaused } from '../services/credit-auto.service';
import { requestSimulationDocs, claimSimulationDocs, finishSimulationDoc, finishInterDoc, finishCreditasDoc, failSimulationDoc, listSimulationDocs, parseInstitutions } from '../services/simulation-doc.service';
import {
  BANK_KEYS, EXTENSION_STATUS, board, createRequests, claimQueue, reportAnalysis, updateAnalysis,
  registerManual, chooseAnalysis, touchExtension, extensionStatus, leadAnalyses, getOverride, setOverrides, creditMetrics, acquireLock, releaseLock, renewLock, releaseOrphans,
} from '../services/credit-analysis.service';

/** Aba "Análise de Crédito" — ver credit-analysis.service.ts. As extensões do Chrome entram com o login normal do CRM. */
const router = Router();
const prisma = new PrismaClient();
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
  if (!leadId || !BANK_KEYS.includes(bank)) return res.status(400).json({ error: 'leadId e bank são obrigatórios' });
  try {
    res.json({ data: await getOverride(prisma, { accountId: req.user!.accountId, leadId, bank }) });
  } catch (err) { fail(res, err, 'Erro ao buscar o ajuste'); }
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
  const banks = Array.isArray(b.banks) ? (b.banks as unknown[]).map((v) => String(v).toUpperCase()).filter((v) => BANK_KEYS.includes(v)) : [];
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
  if (!BANK_KEYS.includes(bank)) return res.status(400).json({ error: 'banco inválido' });
  res.json(acquireLock(req.user!.accountId, bank));
});
// A extensão acabou de iniciar (carregou/recarregou/reiniciou): o que estava "rodando" nela se perdeu — falha na hora, com o motivo.
router.post('/release', async (req: AuthRequest, res: Response) => {
  try {
    const bank = String(req.body?.bank || '').toUpperCase();
    if (!BANK_KEYS.includes(bank)) return res.status(400).json({ error: 'banco inválido' });
    res.json({ ok: true, released: await releaseOrphans(prisma, { accountId: req.user!.accountId, bank }) });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/unlock', (req: AuthRequest, res: Response) => {
  const bank = String(req.body?.bank || '').toUpperCase();
  if (!BANK_KEYS.includes(bank)) return res.status(400).json({ error: 'banco inválido' });
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

// Chave da análise automática (só admin liga/desliga). A extensão consulta pra não rodar sozinha em duplicidade.
router.get('/auto', async (req: AuthRequest, res: Response) => {
  try { res.json(await getAutoSetting(req.user!.accountId)); } catch (err) { fail(res, err, 'Erro ao ler a análise automática'); }
});
router.put('/auto', async (req: AuthRequest, res: Response) => {
  if (req.user!.role !== 'ADMIN') return res.status(403).json({ error: 'Só administradores ligam a análise automática' });
  try { if (typeof req.body?.paused === 'boolean') return res.json(await setPaused(req.user!.accountId, req.body.paused, req.user!.id)); } catch (err) { return fail(res, err, 'Erro ao salvar a pausa'); }
  try { res.json(await setAutoSetting(req.user!.accountId, req.body?.enabled === true, req.user!.id)); } catch (err) { fail(res, err, 'Erro ao salvar a análise automática'); }
});

router.get('/extensions', (req: AuthRequest, res: Response) => res.json(extensionStatus(req.user!.accountId)));

// Dispara a análise de vários clientes em vários bancos (a extensão busca na fila).
router.post('/requests', async (req: AuthRequest, res: Response) => {
  const leadIds = Array.isArray(req.body?.leadIds) ? (req.body.leadIds as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  const banks = Array.isArray(req.body?.banks) ? (req.body.banks as unknown[]).filter((v): v is string => typeof v === 'string' && BANK_KEYS.includes(v)) : [];
  if (!leadIds.length) return res.status(400).json({ error: 'Escolha pelo menos um cliente' });
  if (!banks.length) return res.status(400).json({ error: 'Escolha pelo menos um banco' });
  try {
    const out = await createRequests(prisma, { accountId: req.user!.accountId, userId: req.user!.id, leadIds, banks, dryRun: req.body?.dryRun === true, kind: req.body?.kind === 'CHECK' ? 'CHECK' : 'RUN', force: req.body?.force === true });
    emit(req);
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao pedir as análises'); }
});

// A extensão do banco pergunta: "tem pedido pra mim?" (ela chama a cada minuto).
router.get('/queue', async (req: AuthRequest, res: Response) => {
  const bank = String(req.query.bank || '');
  if (!BANK_KEYS.includes(bank)) return res.status(400).json({ error: 'banco inválido' });
  try {
    touchExtension(req.user!.accountId, bank, typeof req.query.extId === 'string' ? req.query.extId : null);
    const caps = typeof req.query.caps === 'string' ? req.query.caps.split(',') : [];
    const items = req.query.claim === '0' ? [] : await claimQueue(prisma, { accountId: req.user!.accountId, bank, limit: Number(req.query.limit) || 3, caps });
    if (items.length) emit(req);
    // PDFs de simulação pedidos (só pra extensão que avisa saber atender: caps inclui "doc").
    const docs = caps.includes('doc') && req.query.claim !== '0' ? await claimSimulationDocs(prisma, { accountId: req.user!.accountId, extBank: bank, limit: 2 }) : [];
    res.json({ items, docs });
  } catch (err) { fail(res, err, 'Erro ao buscar a fila'); }
});

// A extensão conta o que aconteceu. `status` aceita os termos dela (enviando, enviado, aprovado…) ou os do CRM.
router.post('/report', async (req: AuthRequest, res: Response) => {
  const b = req.body || {};
  const raw = String(b.status || '');
  const status = EXTENSION_STATUS[raw.toLowerCase()] || raw.toUpperCase();
  const bank = String(b.bank || '').toUpperCase();
  if (!b.leadId || !BANK_KEYS.includes(bank) || !status) return res.status(400).json({ error: 'leadId, bank e status são obrigatórios' });
  try {
    touchExtension(req.user!.accountId, bank);
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
    const out = await requestSimulationDocs(prisma, { accountId: req.user!.accountId, leadId, institutions, userId: req.user!.id, source: 'USER', caption: typeof req.body?.caption === 'string' ? req.body.caption : undefined });
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

router.post('/:id/choose', async (req: AuthRequest, res: Response) => {
  try {
    const userName = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || undefined;
    const out = await chooseAnalysis(prisma, { accountId: req.user!.accountId, id: req.params.id, userName });
    emit(req);
    res.json(out);
  } catch (err) { fail(res, err, 'Erro ao escolher a proposta', 400); }
});

export default router;
