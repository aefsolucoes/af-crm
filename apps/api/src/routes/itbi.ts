import express, { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { previewItbi, pedirItbi, confirmarEnvioItbi, cancelarItbi, claimItbi, anexoItbi, reportItbi, guiaItbi } from '../services/itbi.service';

/** ITBI do DF pela DEITBI (Receita DF) — ver itbi.service.ts. A extensão "ITBI DF" entra com o login normal do CRM. */
const router = Router();
router.use(authMiddleware);

const io = (req: AuthRequest) => (req as any).app.get('io');
const fail = (res: Response, err: any, fallback: string, code = 500) => res.status(code).json({ error: err?.message || fallback });

// Situação do ITBI no card (barato: não lê a minuta). `elegivel` = Financiamento Habitacional em contratação.
router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    const { prisma } = require('../lib/prisma') as typeof import('../lib/prisma');
    const l = await prisma.lead.findFirst({ where: { id: String(req.query.leadId || ''), accountId: req.user!.accountId }, select: { customFields: true, pipeline: { select: { name: true, department: { select: { name: true } } } } } });
    if (!l) return res.status(404).json({ error: 'Card não encontrado' });
    const cf = (l.customFields || {}) as Record<string, any>;
    res.json({ itbi: cf._itbi || null, elegivel: /habitacional/i.test(l.pipeline?.department?.name || '') && /contrata/i.test(l.pipeline?.name || '') });
  } catch (err) { fail(res, err, 'Erro ao ler o ITBI'); }
});

// O que vai ser declarado (lê a minuta da pasta do cliente).
router.get('/preview', async (req: AuthRequest, res: Response) => {
  try { res.json(await previewItbi(req.user!.accountId, String(req.query.leadId || ''), { releitura: req.query.releitura === 'true' })); } catch (err) { fail(res, err, 'Erro ao montar o ITBI', 400); }
});

// Pede (equipe/Jarvis): a extensão calcula no portal sem enviar.
router.post('/', async (req: AuthRequest, res: Response) => {
  try { res.json({ ok: true, itbi: await pedirItbi(req.user!.accountId, String(req.body?.leadId || ''), { userId: req.user!.id, overrides: req.body?.overrides || {}, io: io(req) }) }); } catch (err) { fail(res, err, 'Erro ao pedir o ITBI', 400); }
});

// Confirma o ENVIO (gera o imposto e a guia).
router.post('/:leadId/enviar', async (req: AuthRequest, res: Response) => {
  try { res.json({ ok: true, itbi: await confirmarEnvioItbi(req.user!.accountId, req.params.leadId, { userId: req.user!.id, io: io(req) }) }); } catch (err) { fail(res, err, 'Erro ao confirmar o envio', 400); }
});

router.post('/:leadId/cancel', async (req: AuthRequest, res: Response) => {
  try { await cancelarItbi(req.user!.accountId, req.params.leadId, { io: io(req) }); res.json({ ok: true }); } catch (err) { fail(res, err, 'Erro ao cancelar', 400); }
});

// Manda de novo a(s) guia(s) ao cliente (botão do card).
router.post('/:leadId/reenviar', async (req: AuthRequest, res: Response) => {
  try {
    const { enviarGuiasAoCliente } = require('../services/itbi.service') as typeof import('../services/itbi.service');
    const { prisma } = require('../lib/prisma') as typeof import('../lib/prisma');
    await prisma.$executeRawUnsafe(`UPDATE "Lead" SET "customFields" = jsonb_set("customFields", '{_itbi,envio}', '{}'::jsonb, true) WHERE id = $1 AND "accountId" = $2 AND "customFields" ? '_itbi'`, req.params.leadId, req.user!.accountId);
    res.json({ ok: true, resultado: await enviarGuiasAoCliente(req.user!.accountId, req.params.leadId, io(req)) });
  } catch (err) { fail(res, err, 'Erro ao reenviar a guia', 400); }
});

// ── Extensão ──
router.get('/queue', async (req: AuthRequest, res: Response) => {
  try { res.json({ job: await claimItbi(req.user!.accountId) }); } catch (err) { fail(res, err, 'Erro ao buscar a fila do ITBI'); }
});

router.get('/:leadId/anexo', async (req: AuthRequest, res: Response) => {
  try {
    const a = await anexoItbi(req.user!.accountId, req.params.leadId);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(a.nome)}"`);
    res.send(a.buffer);
  } catch (err) { fail(res, err, 'Erro ao baixar o anexo', 400); }
});

router.post('/:leadId/report', async (req: AuthRequest, res: Response) => {
  try { res.json(await reportItbi(req.user!.accountId, req.params.leadId, req.body || {}, io(req))); } catch (err) { fail(res, err, 'Erro ao registrar o andamento', 400); }
});

// A guia (DAR) em PDF: corpo = bytes; dados na query (idx, guia, vencimento, valor, linhaDigitavel).
router.post('/:leadId/guia', express.raw({ type: () => true, limit: '20mb' }), async (req: AuthRequest, res: Response) => {
  try {
    const pdf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const q = req.query as Record<string, string>;
    const it = await guiaItbi(req.user!.accountId, req.params.leadId, { idx: Number(q.idx), pdf, info: { guia: q.guia, vencimento: q.vencimento, valor: q.valor, linhaDigitavel: q.linhaDigitavel }, io: io(req) });
    res.json({ ok: true, status: it.status });
  } catch (err) { fail(res, err, 'Erro ao guardar a guia', 400); }
});

export default router;
