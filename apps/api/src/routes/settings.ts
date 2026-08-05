import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { getWhatsAppConfig, saveWhatsAppConfig } from '../services/whatsapp.service';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

const whatsappSchema = z.object({
  phoneNumberId: z.string().min(1),
  accessToken: z.string().min(1),
  verifyToken: z.string().min(6),
  active: z.boolean(),
});

// GET /api/settings/whatsapp
router.get('/whatsapp', async (req: AuthRequest, res: Response) => {
  try {
    const config = await getWhatsAppConfig(req.user!.accountId);
    if (!config) return res.json(null);

    // Mask token for security
    res.json({
      phoneNumberId: config.phoneNumberId,
      accessToken: config.accessToken.slice(0, 8) + '••••••••••••••••',
      verifyToken: config.verifyToken,
      active: config.active,
      webhookUrl: `${process.env.PUBLIC_API_URL || 'https://af-crm-production.up.railway.app'}/api/webhooks/whatsapp`,
    });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar configurações' });
  }
});

// POST /api/settings/whatsapp
router.post('/whatsapp', async (req: AuthRequest, res: Response) => {
  try {
    const { phoneNumberId, accessToken, verifyToken, active } = req.body;

    if (!phoneNumberId || !verifyToken || verifyToken.length < 6) {
      return res.status(400).json({ error: 'phoneNumberId e verifyToken são obrigatórios (min 6 chars)' });
    }

    const existing = await getWhatsAppConfig(req.user!.accountId);

    // If accessToken contains mask chars (••), keep the existing token
    const finalToken = (accessToken && !accessToken.includes('•'))
      ? accessToken
      : (existing?.accessToken ?? accessToken ?? '');

    if (!finalToken) {
      return res.status(400).json({ error: 'accessToken é obrigatório na primeira configuração' });
    }

    const config = await saveWhatsAppConfig(req.user!.accountId, {
      phoneNumberId,
      accessToken: finalToken,
      verifyToken,
      active: active === true || active === 'true',
    });

    const webhookUrl = `${process.env.PUBLIC_API_URL || 'https://af-crm-production.up.railway.app'}/api/webhooks/whatsapp`;
    res.json({ success: true, active: config.active, webhookUrl });
  } catch (err) {
    console.error('[Settings] Erro ao salvar WhatsApp config:', err);
    res.status(500).json({ error: 'Erro ao salvar configurações' });
  }
});

// GET /api/settings/whatsapp/test — testa se o token + phoneNumberId estão corretos
router.get('/whatsapp/test', async (req: AuthRequest, res: Response) => {
  try {
    const config = await getWhatsAppConfig(req.user!.accountId);
    if (!config) return res.status(400).json({ ok: false, error: 'WhatsApp não configurado' });
    if (!config.active) return res.status(400).json({ ok: false, error: 'WhatsApp inativo nas configurações' });

    // Chama a API da Meta para verificar o phoneNumberId (endpoint de perfil do número)
    const testRes = await fetch(
      `https://graph.facebook.com/v19.0/${config.phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${config.accessToken}` } }
    );
    const testJson = await testRes.json() as any;

    if (!testRes.ok || testJson.error) {
      const code = testJson.error?.code ?? testRes.status;
      const msg  = testJson.error?.message ?? 'Erro desconhecido';
      return res.json({ ok: false, error: `${msg} (código: ${code})`, code });
    }

    return res.json({
      ok: true,
      phoneNumber: testJson.display_phone_number,
      name: testJson.verified_name,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Falha na conexão com a API da Meta' });
  }
});

// POST /api/settings/whatsapp/register — registra (ativa) o número na Cloud API com o PIN
router.post('/whatsapp/register', async (req: AuthRequest, res: Response) => {
  try {
    const { pin } = req.body as { pin?: string };
    if (!pin || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({ ok: false, error: 'Informe o PIN de 6 dígitos (verificação em duas etapas).' });
    }
    const config = await getWhatsAppConfig(req.user!.accountId);
    if (!config?.phoneNumberId || !config.accessToken) {
      return res.status(400).json({ ok: false, error: 'Configure o Phone Number ID e o Access Token primeiro (e salve).' });
    }
    // Ativa o número na Cloud API. Tira do "Offline" e coloca "Online".
    const r = await fetch(`https://graph.facebook.com/v20.0/${config.phoneNumberId}/register`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    const j = await r.json() as any;
    if (!r.ok || j.error) {
      const code = j.error?.code ?? r.status;
      const msg  = j.error?.error_user_msg || j.error?.message || 'Erro desconhecido';
      return res.json({ ok: false, error: `${msg} (código: ${code})`, code });
    }
    return res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Falha ao ativar o número na Meta' });
  }
});

// POST /api/settings/whatsapp/request-code — envia código de verificação (SMS/voz)
router.post('/whatsapp/request-code', async (req: AuthRequest, res: Response) => {
  try {
    const method = (req.body?.method === 'VOICE' ? 'VOICE' : 'SMS');
    const config = await getWhatsAppConfig(req.user!.accountId);
    if (!config?.phoneNumberId || !config.accessToken) {
      return res.status(400).json({ ok: false, error: 'Configure o Phone Number ID e o Access Token primeiro (e salve).' });
    }
    const r = await fetch(`https://graph.facebook.com/v20.0/${config.phoneNumberId}/request_code`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code_method: method, language: 'pt_BR' }).toString(),
    });
    const j = await r.json() as any;
    if (!r.ok || j.error) {
      const code = j.error?.code ?? r.status;
      const msg  = j.error?.error_user_msg || j.error?.message || 'Erro desconhecido';
      return res.json({ ok: false, error: `${msg} (código: ${code})`, code });
    }
    return res.json({ ok: true, method });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Falha ao enviar o código de verificação' });
  }
});

// POST /api/settings/whatsapp/verify-code — verifica o código e ativa (registra) com o PIN
router.post('/whatsapp/verify-code', async (req: AuthRequest, res: Response) => {
  try {
    const { code, pin } = req.body as { code?: string; pin?: string };
    if (!code || !/^\d{4,8}$/.test(code)) {
      return res.status(400).json({ ok: false, error: 'Informe o código recebido por SMS/ligação.' });
    }
    if (!pin || !/^\d{6}$/.test(pin)) {
      return res.status(400).json({ ok: false, error: 'Informe um PIN novo de 6 dígitos.' });
    }
    const config = await getWhatsAppConfig(req.user!.accountId);
    if (!config?.phoneNumberId || !config.accessToken) {
      return res.status(400).json({ ok: false, error: 'Configure o Phone Number ID e o Access Token primeiro (e salve).' });
    }
    const auth = { Authorization: `Bearer ${config.accessToken}` };
    // 1) Verifica o código de posse do número
    const vr = await fetch(`https://graph.facebook.com/v20.0/${config.phoneNumberId}/verify_code`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code }).toString(),
    });
    const vj = await vr.json() as any;
    if (!vr.ok || vj.error) {
      const c = vj.error?.code ?? vr.status;
      const m = vj.error?.error_user_msg || vj.error?.message || 'Erro ao verificar o código';
      return res.json({ ok: false, error: `${m} (código: ${c})`, code: c });
    }
    // 2) Registra (ativa) definindo o PIN
    const rr = await fetch(`https://graph.facebook.com/v20.0/${config.phoneNumberId}/register`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
    });
    const rj = await rr.json() as any;
    if (!rr.ok || rj.error) {
      const c = rj.error?.code ?? rr.status;
      const m = rj.error?.error_user_msg || rj.error?.message || 'Erro ao ativar';
      return res.json({ ok: false, error: `Código verificado, mas falhou ao ativar: ${m} (código: ${c})`, code: c, verified: true });
    }
    return res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Falha ao verificar/ativar o número' });
  }
});

// POST /api/settings/whatsapp/subscribe-waba — inscreve o app na conta (WABA)
// para RECEBER as mensagens no webhook. Sem isso, o webhook nunca é chamado.
router.post('/whatsapp/subscribe-waba', async (req: AuthRequest, res: Response) => {
  try {
    const { wabaId } = req.body as { wabaId?: string };
    if (!wabaId || !/^\d{6,}$/.test(wabaId)) {
      return res.status(400).json({ ok: false, error: 'Informe o ID da conta do WhatsApp Business (WABA).' });
    }
    const config = await getWhatsAppConfig(req.user!.accountId);
    if (!config?.accessToken) {
      return res.status(400).json({ ok: false, error: 'Salve o Access Token primeiro.' });
    }
    const r = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    const j = await r.json() as any;
    if (!r.ok || j.error) {
      const code = j.error?.code ?? r.status;
      const msg  = j.error?.error_user_msg || j.error?.message || 'Erro desconhecido';
      return res.json({ ok: false, error: `${msg} (código: ${code})`, code });
    }
    return res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Falha ao inscrever o app na WABA' });
  }
});

// ─── Meta Lead Ads Settings ──────────────────────────────────────────────────

const metaLeadsSchema = z.object({
  verifyToken: z.string().min(6),
  pageAccessToken: z.string().min(1),
  defaultStageId: z.string().optional().nullable(),
  defaultUserId: z.string().optional().nullable(),
  active: z.boolean(),
});

// GET /api/settings/meta-leads
router.get('/meta-leads', async (req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.metaLeadsConfig.findUnique({
      where: { accountId: req.user!.accountId },
    });

    const BASE = process.env.PUBLIC_API_URL || 'https://af-crm-production.up.railway.app';

    if (!config) {
      return res.json({
        verifyToken: 'af_meta_verify',
        pageAccessToken: '',
        defaultStageId: null,
        defaultUserId: null,
        active: false,
        webhookUrl: `${BASE}/api/webhooks/meta-leads`,
        isNew: true,
      });
    }

    res.json({
      verifyToken: config.verifyToken,
      pageAccessToken: config.pageAccessToken
        ? config.pageAccessToken.slice(0, 8) + '••••••••••••••••'
        : '',
      defaultStageId: config.defaultStageId,
      defaultUserId: config.defaultUserId,
      active: config.active,
      fieldMappings: config.fieldMappings || [],
      webhookUrl: `${BASE}/api/webhooks/meta-leads`,
      isNew: false,
    });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar configurações Meta Leads' });
  }
});

// POST /api/settings/meta-leads
router.post('/meta-leads', async (req: AuthRequest, res: Response) => {
  try {
    const { verifyToken, pageAccessToken, defaultStageId, defaultUserId, active } = req.body;
    if (!verifyToken || verifyToken.length < 6) {
      return res.status(400).json({ error: 'verifyToken precisa ter no mínimo 6 caracteres' });
    }

    const existing = await prisma.metaLeadsConfig.findUnique({
      where: { accountId: req.user!.accountId },
    });

    // Keep existing token if not provided (masked)
    const finalToken = (pageAccessToken && !pageAccessToken.includes('•'))
      ? pageAccessToken
      : (existing?.pageAccessToken ?? '');

    const fieldMappings = Array.isArray(req.body.fieldMappings) ? req.body.fieldMappings : [];

    const config = await prisma.metaLeadsConfig.upsert({
      where: { accountId: req.user!.accountId },
      update: {
        verifyToken,
        pageAccessToken: finalToken,
        defaultStageId: defaultStageId || null,
        defaultUserId: defaultUserId || null,
        active,
        fieldMappings,
      },
      create: {
        accountId: req.user!.accountId,
        verifyToken,
        pageAccessToken: finalToken,
        defaultStageId: defaultStageId || null,
        defaultUserId: defaultUserId || null,
        active,
        fieldMappings,
      },
    });

    res.json({ success: true, active: config.active });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar configurações Meta Leads' });
  }
});

// ─── Meta Lead Ads — buscar formulários e campos via Graph API ───────────────

// GET /api/settings/meta-leads/forms
router.get('/meta-leads/forms', async (req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.metaLeadsConfig.findUnique({
      where: { accountId: req.user!.accountId },
    });

    if (!config?.pageAccessToken) {
      return res.status(400).json({ error: 'Configure o Page Access Token primeiro' });
    }

    const token = config.pageAccessToken;

    // Busca páginas que o token tem acesso
    const pagesResp = await fetch(
      `https://graph.facebook.com/v19.0/me/accounts?fields=id,name,access_token&access_token=${token}`
    );
    const pagesData = await pagesResp.json() as {
      data?: { id: string; name: string; access_token: string }[];
      error?: { message: string };
    };

    if (pagesData.error) {
      return res.status(400).json({ error: `Erro Meta API: ${pagesData.error.message}` });
    }

    const pages = pagesData.data || [];
    const allForms: { id: string; name: string; status: string; pageId: string; pageName: string }[] = [];

    for (const page of pages) {
      const pageToken = page.access_token || token;
      const formsResp = await fetch(
        `https://graph.facebook.com/v19.0/${page.id}/leadgen_forms?fields=id,name,status&access_token=${pageToken}`
      );
      const formsData = await formsResp.json() as {
        data?: { id: string; name: string; status: string }[];
      };

      for (const form of formsData.data || []) {
        allForms.push({
          id: form.id,
          name: form.name,
          status: form.status,
          pageId: page.id,
          pageName: page.name,
        });
      }
    }

    res.json({ forms: allForms, pages: pages.map(p => ({ id: p.id, name: p.name })) });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar formulários Meta' });
  }
});

// GET /api/settings/meta-leads/forms/:formId/fields
router.get('/meta-leads/forms/:formId/fields', async (req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.metaLeadsConfig.findUnique({
      where: { accountId: req.user!.accountId },
    });

    if (!config?.pageAccessToken) {
      return res.status(400).json({ error: 'Configure o Page Access Token primeiro' });
    }

    const resp = await fetch(
      `https://graph.facebook.com/v19.0/${req.params.formId}?fields=name,questions&access_token=${config.pageAccessToken}`
    );
    const data = await resp.json() as {
      name?: string;
      questions?: { type: string; key: string; label?: string }[];
      error?: { message: string };
    };

    if (data.error) {
      return res.status(400).json({ error: `Erro Meta API: ${data.error.message}` });
    }

    const fields = (data.questions || []).map(q => ({
      key: q.key,
      label: q.label || q.type,
      type: q.type,
    }));

    res.json({ formName: data.name, fields });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar campos do formulário' });
  }
});

// ─── Agente IA interno (prompt do assistente de colaboradores) ──────────────

const DEFAULT_AGENT_PROMPT = `Você é o assistente interno de suporte do AF CRM, usado pelos funcionários da A&F Soluções Financeiras.
Seu papel é tirar dúvidas dos funcionários sobre como usar o sistema e sobre o processo de vendas/atendimento da empresa: funil de vendas, inbox unificada (WhatsApp), cadastro de leads e contatos, tarefas, SalesBot (automação de mensagens), templates e relatórios.
Você também pode, quando um colaborador pedir explicitamente, ler o histórico de conversa de um lead no WhatsApp e enviar uma mensagem ao cliente em nome do colaborador — seja para um lead já cadastrado (pelo nome) ou para um número de telefone fornecido na hora (nesse caso o contato/lead é criado automaticamente). Nunca envie uma mensagem sem que o colaborador tenha pedido isso na conversa atual. Depois de enviar, confirme ao colaborador exatamente o que foi enviado e para quem.
Responda em português, de forma curta, direta e prática, como se estivesse explicando para um colega de trabalho. Se a dúvida não tiver relação com o CRM ou o processo da empresa, explique educadamente que você só pode ajudar com isso.`;

// GET /api/settings/agent
router.get('/agent', async (req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.agentConfig.findUnique({
      where: { accountId: req.user!.accountId },
    });
    res.json({ systemPrompt: config?.systemPrompt ?? DEFAULT_AGENT_PROMPT });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar configuração do agente' });
  }
});

// PUT /api/settings/agent
router.put('/agent', async (req: AuthRequest, res: Response) => {
  try {
    const { systemPrompt } = req.body as { systemPrompt?: string };
    if (!systemPrompt || !systemPrompt.trim()) {
      return res.status(400).json({ error: 'systemPrompt é obrigatório' });
    }

    const config = await prisma.agentConfig.upsert({
      where: { accountId: req.user!.accountId },
      update: { systemPrompt: systemPrompt.trim() },
      create: { accountId: req.user!.accountId, systemPrompt: systemPrompt.trim() },
    });

    res.json({ systemPrompt: config.systemPrompt });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar configuração do agente' });
  }
});

export default router;
