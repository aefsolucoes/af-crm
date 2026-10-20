import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { vistoriaPreview, solicitarVistoria, laudoPreview, requestLaudo, claimLaudo, reportLaudo } from '../services/vistoria-inter.service';

/** Botão "Solicitar vistoria" do card — ver vistoria-inter.service.ts. */
const router = Router();
router.use(authMiddleware);

const fail = (res: Response, err: any, fallback: string, code = 400) => res.status(code).json({ error: err?.message || fallback });

// Monta o e-mail pra revisar (não envia nada).
router.get('/preview', async (req: AuthRequest, res: Response) => {
  try { res.json(await vistoriaPreview(req.user!.accountId, String(req.query.leadId || ''))); } catch (err) { fail(res, err, 'Erro ao montar o e-mail da vistoria'); }
});

// Envia ao Inter (só quando alguém clica em "Enviar ao Inter").
router.post('/request', async (req: AuthRequest, res: Response) => {
  const b = req.body || {};
  try {
    res.json(await solicitarVistoria({
      accountId: req.user!.accountId, userId: req.user!.id, leadId: String(b.leadId || ''), to: String(b.to || ''), cc: typeof b.cc === 'string' ? b.cc : '',
      subject: String(b.subject || ''), body: String(b.body || ''), replyToId: b.replyToId ? String(b.replyToId) : null, attachDriveFileIds: Array.isArray(b.attachDriveFileIds) ? b.attachDriveFileIds.map(String) : [],
      io: (req as any).app.get('io'),
    }));
  } catch (err) { fail(res, err, 'Erro ao solicitar a vistoria'); }
});

// ── Laudo digital do Inter (apartamento) — a extensão "Vistoria Inter" preenche e para antes de enviar ──
router.get('/laudo/preview', async (req: AuthRequest, res: Response) => {
  try { res.json(await laudoPreview(req.user!.accountId, String(req.query.leadId || ''))); } catch (err) { fail(res, err, 'Erro ao montar o laudo'); }
});
router.post('/laudo/request', async (req: AuthRequest, res: Response) => {
  try { res.json(await requestLaudo(req.user!.accountId, String(req.body?.leadId || ''), req.user!.id)); } catch (err) { fail(res, err, 'Erro ao pedir o preenchimento do laudo'); }
});
router.get('/laudo/queue', async (req: AuthRequest, res: Response) => {
  try { res.json({ job: await claimLaudo(req.user!.accountId) }); } catch (err) { fail(res, err, 'Erro ao buscar a fila do laudo', 500); }
});
router.post('/laudo/:leadId/report', async (req: AuthRequest, res: Response) => {
  try { res.json(await reportLaudo(req.user!.accountId, req.params.leadId, req.body || {})); } catch (err) { fail(res, err, 'Erro ao registrar o laudo'); }
});

export default router;
