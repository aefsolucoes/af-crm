import { Router, Response, Request } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import {
  getAuthUrl, handleOAuthCallback, getGoogleStatus, disconnectGoogle,
  listFolders, setRootFolder, createFolder, isGoogleConfigured,
} from '../services/google.service';

const router = Router();

const FRONTEND_URL = process.env.PUBLIC_FRONTEND_URL || 'https://crm.aefsolucoesfinanceiras.com.br';

// ─── Callback do OAuth — PÚBLICO (é o Google que redireciona para cá) ───────
router.get('/oauth/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined; // accountId
  const error = req.query.error as string | undefined;

  if (error || !code || !state) {
    return res.send(htmlClose(`Não foi possível conectar o Google Drive${error ? ` (${error})` : ''}.`, false));
  }
  try {
    await handleOAuthCallback(code, state);
    res.send(htmlClose('Google Drive conectado com sucesso! Pode fechar esta aba.', true));
  } catch (err: any) {
    const googleErr = err?.response?.data?.error_description
      || err?.response?.data?.error
      || err?.message
      || 'erro desconhecido';
    console.error('[Google] Erro no callback:', googleErr, err?.response?.data);
    res.send(htmlClose(`Erro ao conectar: ${googleErr}`, false));
  }
});

function htmlClose(message: string, ok: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>AF CRM</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d2545;color:#fff">
<div style="text-align:center;max-width:420px;padding:24px">
  <div style="font-size:48px;margin-bottom:12px">${ok ? '✅' : '⚠️'}</div>
  <p style="font-size:16px;line-height:1.5">${message}</p>
  <p style="font-size:13px;opacity:.7;margin-top:16px">Esta janela fecha sozinha…</p>
</div>
<script>
  try { window.opener && window.opener.postMessage({ type: 'google-oauth', ok: ${ok} }, '*'); } catch(e){}
  setTimeout(function(){ try { window.close(); } catch(e){} window.location.href='${FRONTEND_URL}/configuracoes'; }, 2500);
</script></body></html>`;
}

// ─── Daqui pra baixo exige autenticação ─────────────────────────────────────
router.use(authMiddleware);

// Inicia o fluxo — retorna a URL de consentimento para o front abrir
router.get('/oauth/start', (req: AuthRequest, res: Response) => {
  if (!isGoogleConfigured()) {
    return res.status(400).json({ error: 'Integração do Google não configurada no servidor.' });
  }
  try {
    const url = getAuthUrl(req.user!.accountId);
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Erro ao gerar URL do Google' });
  }
});

router.get('/status', async (req: AuthRequest, res: Response) => {
  try {
    res.json(await getGoogleStatus(req.user!.accountId));
  } catch {
    res.status(500).json({ error: 'Erro ao buscar status do Google' });
  }
});

router.post('/disconnect', async (req: AuthRequest, res: Response) => {
  await disconnectGoogle(req.user!.accountId);
  res.json({ success: true });
});

// Lista pastas (para escolher a pasta-raiz dos clientes) — parent opcional
router.get('/folders', async (req: AuthRequest, res: Response) => {
  try {
    const parent = req.query.parent as string | undefined;
    res.json(await listFolders(req.user!.accountId, parent));
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao listar pastas' });
  }
});

// Define a pasta-raiz onde ficam as pastas dos clientes
router.post('/root-folder', async (req: AuthRequest, res: Response) => {
  const { folderId, folderName } = req.body as { folderId?: string; folderName?: string };
  if (!folderId) return res.status(400).json({ error: 'folderId é obrigatório' });
  await setRootFolder(req.user!.accountId, folderId, folderName || '');
  res.json({ success: true });
});

// Teste rápido: cria uma pasta dentro da raiz configurada
router.post('/test-folder', async (req: AuthRequest, res: Response) => {
  try {
    const { name } = req.body as { name?: string };
    const status = await getGoogleStatus(req.user!.accountId);
    if (!status.rootFolderId) return res.status(400).json({ error: 'Defina a pasta-raiz dos clientes primeiro' });
    const folder = await createFolder(req.user!.accountId, name?.trim() || 'Teste AF CRM', status.rootFolderId);
    res.json(folder);
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Erro ao criar pasta' });
  }
});

export default router;
