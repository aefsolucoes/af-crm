import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { certidoesPreview, pedirCertidoes, cancelarCertidao, claimCertidaoPessoal, reportCertidaoPessoal, receberArquivoCertidao } from '../services/certidoes-pessoais.service';

/** Certidões do processo (comprador, vendedor e imóvel) pela extensão "Certidões (automática)" — ver certidoes-pessoais.service.ts. */
const router = Router();
router.use(authMiddleware);

const fail = (res: Response, err: any, fallback: string, code = 400) => res.status(code).json({ error: err?.message || fallback });

// Botão do card: pessoas/imóvel já preenchidos + pedidos anteriores.
router.get('/preview', async (req: AuthRequest, res: Response) => {
  try { res.json(await certidoesPreview(req.user!.accountId, String(req.query.leadId || ''))); } catch (err) { fail(res, err, 'Erro ao montar as certidões'); }
});
router.post('/request', async (req: AuthRequest, res: Response) => {
  try { res.json(await pedirCertidoes(req.user!.accountId, String(req.body?.leadId || ''), req.user!.id, req.body || {})); } catch (err) { fail(res, err, 'Erro ao pedir as certidões'); }
});
router.post('/:leadId/:jobId/cancel', async (req: AuthRequest, res: Response) => {
  try { res.json(await cancelarCertidao(req.user!.accountId, req.params.leadId, req.params.jobId)); } catch (err) { fail(res, err, 'Erro ao cancelar'); }
});

// Extensão: pega o próximo pedido, relata o andamento e devolve o PDF (base64).
router.get('/queue', async (req: AuthRequest, res: Response) => {
  try { res.json({ job: await claimCertidaoPessoal(req.user!.accountId) }); } catch (err) { fail(res, err, 'Erro ao buscar a fila de certidões', 500); }
});
router.post('/:leadId/:jobId/report', async (req: AuthRequest, res: Response) => {
  try { res.json(await reportCertidaoPessoal(req.user!.accountId, req.params.leadId, req.params.jobId, req.body || {})); } catch (err) { fail(res, err, 'Erro ao registrar o andamento'); }
});
router.post('/:leadId/:jobId/file', async (req: AuthRequest, res: Response) => {
  try { res.json(await receberArquivoCertidao(req.user!.accountId, req.params.leadId, req.params.jobId, req.body || {})); } catch (err) { fail(res, err, 'Erro ao guardar a certidão'); }
});

export default router;
