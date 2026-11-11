import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { vistoriaPreview, solicitarVistoria, laudoPreview, claimLaudo, reportLaudo, seguirPreview, requestSeguir, claimSeguir, reportSeguir } from '../services/vistoria-inter.service';
import { santanderPreview, executarVistoriaSantander } from '../services/vistoria-santander.service';
import { vistoriaCreditasStatus, vistoriaCreditasPreview, solicitarVistoriaCreditas, pedirContatoVistoria } from '../services/vistoria-creditas.service';
import { pedirLaudoPeloBotao } from '../services/laudo-ask.service';
import { itauVistoriaStatus, itauVistoriaPreview, requestItauVistoria, claimItauVistoria, reportItauVistoria } from '../services/vistoria-itau.service';

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

// ── Vistoria da Creditas (Fabio 03/11): e-mail ao Jonatas com nome/telefone do cliente + certidão de ônus e capa do IPTU. Monta pra revisar; só envia no clique. ──
router.get('/creditas/status', async (req: AuthRequest, res: Response) => {
  try { res.json(await vistoriaCreditasStatus(req.user!.accountId, String(req.query.leadId || ''))); } catch (err) { fail(res, err, 'Erro ao ler a vistoria da Creditas'); }
});
router.get('/creditas/preview', async (req: AuthRequest, res: Response) => {
  try { res.json(await vistoriaCreditasPreview(req.user!.accountId, String(req.query.leadId || ''))); } catch (err) { fail(res, err, 'Erro ao montar o e-mail da vistoria da Creditas'); }
});
// "Contato vistoria" vazio no clique (Fabio 03/11): pergunta ao cliente quem acompanha a vistoria (mensagem; conversa fechada = template antes).
router.post('/creditas/ask-contato', async (req: AuthRequest, res: Response) => {
  try { res.json({ asked: await pedirContatoVistoria(req.user!.accountId, String(req.body?.leadId || ''), req.user!.id, (req as any).app.get('io')) }); } catch (err) { fail(res, err, 'Erro ao perguntar o contato da vistoria'); }
});
router.post('/creditas/request', async (req: AuthRequest, res: Response) => {
  const b = req.body || {};
  try {
    res.json(await solicitarVistoriaCreditas({
      accountId: req.user!.accountId, userId: req.user!.id, leadId: String(b.leadId || ''), to: String(b.to || ''), cc: typeof b.cc === 'string' ? b.cc : '',
      subject: String(b.subject || ''), body: String(b.body || ''), replyToId: b.replyToId ? String(b.replyToId) : null, attachDriveFileIds: Array.isArray(b.attachDriveFileIds) ? b.attachDriveFileIds.map(String) : [],
      io: (req as any).app.get('io'),
    }));
  } catch (err) { fail(res, err, 'Erro ao solicitar a vistoria à Creditas'); }
});

// ── Laudo digital do Inter (apartamento) — a extensão "Vistoria Inter" preenche e para antes de enviar ──
router.get('/laudo/preview', async (req: AuthRequest, res: Response) => {
  try { res.json(await laudoPreview(req.user!.accountId, String(req.query.leadId || ''))); } catch (err) { fail(res, err, 'Erro ao montar o laudo'); }
});
router.post('/laudo/request', async (req: AuthRequest, res: Response) => {
  // Botão "Preencher laudo" (Fabio 03/11): completa o card (ano de construção pela matrícula) e, se faltar dado do cliente, pergunta a ele (template se a conversa estiver fechada).
  try { res.json(await pedirLaudoPeloBotao(req.user!.accountId, String(req.body?.leadId || ''), req.user!.id, (req as any).app.get('io'))); } catch (err) { fail(res, err, 'Erro ao pedir o preenchimento do laudo'); }
});
router.get('/laudo/queue', async (req: AuthRequest, res: Response) => {
  try { res.json({ job: await claimLaudo(req.user!.accountId) }); } catch (err) { fail(res, err, 'Erro ao buscar a fila do laudo', 500); }
});
router.post('/laudo/:leadId/report', async (req: AuthRequest, res: Response) => {
  try { res.json(await reportLaudo(req.user!.accountId, req.params.leadId, req.body || {})); } catch (err) { fail(res, err, 'Erro ao registrar o laudo'); }
});

// ── "Seguir com proposta" no portal do Inter — a extensão "Vistoria Inter" abre a proposta, clica em "Seguir com proposta" e PARA no aviso de confirmação (a equipe dá o último clique) ──
router.get('/seguir/preview', async (req: AuthRequest, res: Response) => {
  try { res.json(await seguirPreview(req.user!.accountId, String(req.query.leadId || ''))); } catch (err) { fail(res, err, 'Erro ao ler a proposta'); }
});
router.post('/seguir/request', async (req: AuthRequest, res: Response) => {
  try { res.json(await requestSeguir(req.user!.accountId, String(req.body?.leadId || ''), req.user!.id, req.body?.confirm === true)); } catch (err) { fail(res, err, 'Erro ao pedir a abertura da proposta'); }
});
router.get('/seguir/queue', async (req: AuthRequest, res: Response) => {
  try { res.json({ job: await claimSeguir(req.user!.accountId) }); } catch (err) { fail(res, err, 'Erro ao buscar a fila', 500); }
});
router.post('/seguir/:leadId/report', async (req: AuthRequest, res: Response) => {
  try { res.json(await reportSeguir(req.user!.accountId, req.params.leadId, req.body || {})); } catch (err) { fail(res, err, 'Erro ao registrar'); }
});

// ── Vistoria do Santander (e-mail à Letícia) — botão do card; ver vistoria-santander.service.ts ──
router.get('/santander/preview', async (req: AuthRequest, res: Response) => {
  try { res.json(await santanderPreview(req.user!.accountId, String(req.query.leadId || ''))); } catch (err) { fail(res, err, 'Erro ao ler a vistoria do Santander'); }
});
router.post('/santander/run', async (req: AuthRequest, res: Response) => {
  try { res.json(await executarVistoriaSantander(req.user!.accountId, String(req.body?.leadId || ''), (req as any).app.get('io'))); } catch (err) { fail(res, err, 'Erro ao avançar a vistoria do Santander'); }
});

// ── Vistoria do Itaú (Fabio 11/11) — a extensão "Financiamento Itaú" preenche os formulários digitais da proposta; ver vistoria-itau.service.ts ──
router.get('/itau/status', async (req: AuthRequest, res: Response) => {
  try { res.json(await itauVistoriaStatus(req.user!.accountId, String(req.query.leadId || ''))); } catch (err) { fail(res, err, 'Erro ao ler a vistoria do Itaú'); }
});
router.get('/itau/preview', async (req: AuthRequest, res: Response) => {
  try { res.json(await itauVistoriaPreview(req.user!.accountId, String(req.query.leadId || ''))); } catch (err) { fail(res, err, 'Erro ao montar os formulários do Itaú'); }
});
router.post('/itau/request', async (req: AuthRequest, res: Response) => {
  try { res.json(await requestItauVistoria(req.user!.accountId, String(req.body?.leadId || ''), req.user!.id)); } catch (err) { fail(res, err, 'Erro ao pedir os formulários do Itaú'); }
});
router.get('/itau/queue', async (req: AuthRequest, res: Response) => {
  try { res.json({ job: await claimItauVistoria(req.user!.accountId) }); } catch (err) { fail(res, err, 'Erro ao buscar a fila do Itaú', 500); }
});
router.post('/itau/:leadId/report', async (req: AuthRequest, res: Response) => {
  try { res.json(await reportItauVistoria(req.user!.accountId, req.params.leadId, req.body || {}, (req as any).app.get('io'))); } catch (err) { fail(res, err, 'Erro ao registrar os formulários do Itaú'); }
});

// ── Questionário da contratação do Inter (vistoria concluída) — ver inter-questionario.service.ts ──
router.get('/inter-questionario', async (req: AuthRequest, res: Response) => {
  try { const { questionarioPreview } = require('../services/inter-questionario.service') as typeof import('../services/inter-questionario.service'); res.json(await questionarioPreview(req.user!.accountId, String(req.query.leadId || ''))); } catch (err) { fail(res, err, 'Erro ao ler o questionário'); }
});
// Começa à mão (e-mail que chegou antes do fluxo existir). jaPerguntadoEm = a pergunta já foi feita ao cliente nessa hora (só lê as respostas).
router.post('/inter-questionario/start', async (req: AuthRequest, res: Response) => {
  try { const { iniciarManual } = require('../services/inter-questionario.service') as typeof import('../services/inter-questionario.service'); res.json(await iniciarManual(req.user!.accountId, String(req.body?.leadId || ''), (req as any).app.get('io'), req.body?.jaPerguntadoEm ? String(req.body.jaPerguntadoEm) : undefined)); } catch (err) { fail(res, err, 'Erro ao começar o questionário'); }
});
router.post('/inter-questionario/send', async (req: AuthRequest, res: Response) => {
  try { const { enviarEmailQuestionario } = require('../services/inter-questionario.service') as typeof import('../services/inter-questionario.service'); const out = await enviarEmailQuestionario(req.user!.accountId, String(req.body?.leadId || ''), (req as any).app.get('io')); if (!out.ok) return res.status(400).json({ error: out.erro }); res.json(out); } catch (err) { fail(res, err, 'Erro ao responder o Inter'); }
});

export default router;
