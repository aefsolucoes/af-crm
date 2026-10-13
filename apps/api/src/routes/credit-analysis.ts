import { Router, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getScopeDepartmentIds } from '../services/department.service';
import {
  BANK_KEYS, EXTENSION_STATUS, board, createRequests, claimQueue, reportAnalysis, updateAnalysis,
  registerManual, chooseAnalysis, touchExtension, extensionStatus, leadAnalyses, getOverride, setOverrides, creditMetrics,
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

router.get('/extensions', (req: AuthRequest, res: Response) => res.json(extensionStatus(req.user!.accountId)));

// Dispara a análise de vários clientes em vários bancos (a extensão busca na fila).
router.post('/requests', async (req: AuthRequest, res: Response) => {
  const leadIds = Array.isArray(req.body?.leadIds) ? (req.body.leadIds as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  const banks = Array.isArray(req.body?.banks) ? (req.body.banks as unknown[]).filter((v): v is string => typeof v === 'string' && BANK_KEYS.includes(v)) : [];
  if (!leadIds.length) return res.status(400).json({ error: 'Escolha pelo menos um cliente' });
  if (!banks.length) return res.status(400).json({ error: 'Escolha pelo menos um banco' });
  try {
    const out = await createRequests(prisma, { accountId: req.user!.accountId, userId: req.user!.id, leadIds, banks, dryRun: req.body?.dryRun === true, kind: req.body?.kind === 'CHECK' ? 'CHECK' : 'RUN' });
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
    const items = req.query.claim === '0' ? [] : await claimQueue(prisma, { accountId: req.user!.accountId, bank, limit: Number(req.query.limit) || 3, caps: typeof req.query.caps === 'string' ? req.query.caps.split(',') : [] });
    if (items.length) emit(req);
    res.json({ items });
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
    const row = await reportAnalysis(prisma, { accountId: req.user!.accountId, requestId: b.requestId ? String(b.requestId) : undefined, leadId: String(b.leadId), bank, status, detail: b.detail ? String(b.detail) : undefined, result: b.result && typeof b.result === 'object' ? b.result : {} });
    emit(req, { leadId: row.leadId });
    res.json({ ok: true, id: row.id, status: row.status });
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
