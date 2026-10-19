import express, { Router, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { createCertidaoRequest, listCertidoes, claimCertidao, reportCertidao, finishCertidao, cancelCertidao, markCertidaoPaid, requestCollectNow, validCertidaoSig } from '../services/certidao.service';

/** Certidão de matrícula pelo RI Digital/ONR — ver certidao.service.ts. A extensão "Certidão ONR" entra com o login normal do CRM. */
const router = Router();

const io = (req: AuthRequest) => (req as any).app.get('io');
const fail = (res: Response, err: any, fallback: string, code = 500) => res.status(code).json({ error: err?.message || fallback });

// PDF da certidão: abre com o link assinado das notas do card (sem login) ou com o login normal.
router.get('/:id/pdf', (req: AuthRequest, res: Response, next: NextFunction) => {
  if (validCertidaoSig(req.params.id, req.query.exp, req.query.sig)) return next();
  return authMiddleware(req, res, next);
}, async (req: AuthRequest, res: Response) => {
  try {
    const r = await prisma.certidaoRequest.findFirst({ where: { id: req.params.id, ...(req.user ? { accountId: req.user.accountId } : {}) }, select: { pdf: true, pdfName: true, driveUrl: true } });
    if (r?.driveUrl) return res.redirect(r.driveUrl); // o PDF mora no Drive (o CRM não guarda)
    if (!r?.pdf) return res.status(404).json({ error: 'Certidão ainda não foi emitida' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(r.pdfName || 'certidao.pdf')}"`);
    res.send(Buffer.from(r.pdf));
  } catch (err) { fail(res, err, 'Erro ao abrir a certidão'); }
});

router.use(authMiddleware);

// Pede uma certidão (equipe ou IA).
router.post('/', async (req: AuthRequest, res: Response) => {
  const b = req.body || {};
  try {
    const out = await createCertidaoRequest(prisma, { accountId: req.user!.accountId, leadId: String(b.leadId || ''), uf: b.uf, cidade: b.cidade, cartorio: b.cartorio, matricula: b.matricula, userId: req.user!.id, sendPix: b.sendPix !== false, clientIntro: typeof b.clientIntro === 'string' ? b.clientIntro : undefined });
    io(req)?.to(`account_${req.user!.accountId}`).emit('certidao_updated', { id: out.request.id, leadId: out.request.leadId });
    res.json({ ...out, request: { ...out.request, pdf: undefined } });
  } catch (err) { fail(res, err, 'Erro ao pedir a certidão', 400); }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try { res.json(await listCertidoes(prisma, { accountId: req.user!.accountId, leadId: typeof req.query.leadId === 'string' ? req.query.leadId : undefined })); } catch (err) { fail(res, err, 'Erro ao listar as certidões'); }
});

// A equipe confirma à mão que o cliente pagou o PIX (quando o comprovante não foi reconhecido sozinho).
router.post('/:id/paid', async (req: AuthRequest, res: Response) => {
  try {
    const row = await markCertidaoPaid(prisma, { accountId: req.user!.accountId, id: req.params.id, via: 'MANUAL', io: io(req) });
    if (!row) return res.status(400).json({ error: 'Esse pedido não está aguardando pagamento' });
    res.json({ ok: true, paidAt: row.paidAt });
  } catch (err) { fail(res, err, 'Erro ao confirmar o pagamento', 400); }
});

// Botão "Buscar certidão agora": manda a extensão ao portal já (dentro do horário) pra achar a certidão e guardar no Drive.
router.post('/:id/collect-now', async (req: AuthRequest, res: Response) => {
  try { res.json({ ok: true, ...(await requestCollectNow(prisma, { accountId: req.user!.accountId, id: req.params.id, io: io(req) })) }); } catch (err) { fail(res, err, 'Erro ao pedir a busca', 400); }
});

// A extensão pergunta "tem serviço pra mim?" (chama a cada minuto). Um trabalho por vez.
router.get('/queue', async (req: AuthRequest, res: Response) => {
  try { res.json({ job: await claimCertidao(prisma, { accountId: req.user!.accountId }) }); } catch (err) { fail(res, err, 'Erro ao buscar a fila de certidões'); }
});

// A extensão conta o que aconteceu (passo, pedido feito, PIX, falha).
router.post('/:id/report', async (req: AuthRequest, res: Response) => {
  try {
    const row = await reportCertidao(prisma, { accountId: req.user!.accountId, id: req.params.id, data: req.body || {}, io: io(req) });
    res.json({ ok: true, status: row.status, pixSent: !!row.pixSentAt });
  } catch (err) { fail(res, err, 'Erro ao registrar o andamento', 400); }
});

// A extensão devolve o PDF da certidão emitida (corpo = bytes do PDF).
router.post('/:id/pdf', express.raw({ type: () => true, limit: '25mb' }), async (req: AuthRequest, res: Response) => {
  try {
    const pdf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (pdf.length < 1000 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') return res.status(400).json({ error: 'o corpo não é um PDF' });
    const name = typeof req.query.name === 'string' ? req.query.name : undefined;
    const row = await finishCertidao(prisma, { accountId: req.user!.accountId, id: req.params.id, pdf, pdfName: name, io: io(req) });
    res.json({ ok: true, status: row.status });
  } catch (err) { fail(res, err, 'Erro ao guardar a certidão', 400); }
});

router.post('/:id/cancel', async (req: AuthRequest, res: Response) => {
  try { const r = await cancelCertidao(prisma, { accountId: req.user!.accountId, id: req.params.id, userId: req.user!.id }); res.json({ ok: true, status: r.status }); } catch (err) { fail(res, err, 'Erro ao cancelar', 400); }
});

export default router;
