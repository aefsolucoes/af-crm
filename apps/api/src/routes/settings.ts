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
    // Salva o WABA ID — reaproveitado depois para listar/criar templates, sem
    // precisar digitar de novo.
    await prisma.whatsAppConfig.update({ where: { accountId: req.user!.accountId }, data: { wabaId } }).catch(() => {});
    return res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Falha ao inscrever o app na WABA' });
  }
});

// ─── Templates do WhatsApp (Meta) ────────────────────────────────────────────
// Templates precisam ser aprovados pela Meta antes de poder enviar mensagem
// fora da janela de 24h de atendimento. Usam o mesmo WABA ID salvo acima.

/** Nome técnico do template exigido pela Meta: minúsculo, só letras/números/_. */
function slugifyTemplateName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 512);
  return slug || 'template';
}

const templateSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.enum(['MARKETING', 'UTILITY', 'AUTHENTICATION']),
  language: z.string().min(2).default('pt_BR'),
  // Obrigatório para MARKETING/UTILITY; ignorado em AUTHENTICATION (a Meta
  // gera o texto do código sozinha — não aceita corpo customizado).
  body: z.string().max(1024).optional(),
  footer: z.string().max(60).optional(),
  // Só usado em AUTHENTICATION: minutos até o código expirar (padrão 10).
  codeExpirationMinutes: z.number().int().min(1).max(90).optional(),
});

// GET /api/settings/whatsapp/templates — lista os templates da conta (com status de aprovação)
router.get('/whatsapp/templates', async (req: AuthRequest, res: Response) => {
  try {
    const config = await getWhatsAppConfig(req.user!.accountId);
    if (!config?.accessToken) return res.status(400).json({ error: 'Configure o Access Token primeiro (aba API Oficial).' });
    if (!config.wabaId) return res.status(400).json({ error: 'Informe o WABA ID em "Ativar recebimento" primeiro.' });

    const r = await fetch(
      `https://graph.facebook.com/v20.0/${config.wabaId}/message_templates?fields=name,status,category,language,components,rejected_reason&limit=100`,
      { headers: { Authorization: `Bearer ${config.accessToken}` } },
    );
    const j = await r.json() as any;
    if (!r.ok || j.error) {
      const code = j.error?.code ?? r.status;
      const msg  = j.error?.error_user_msg || j.error?.message || 'Erro desconhecido';
      return res.status(400).json({ error: `${msg} (código: ${code})` });
    }
    res.json({ templates: j.data || [] });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar templates' });
  }
});

// POST /api/settings/whatsapp/templates — envia um novo template para aprovação da Meta
router.post('/whatsapp/templates', validate(templateSchema), async (req: AuthRequest, res: Response) => {
  try {
    const config = await getWhatsAppConfig(req.user!.accountId);
    if (!config?.accessToken) return res.status(400).json({ error: 'Configure o Access Token primeiro (aba API Oficial).' });
    if (!config.wabaId) return res.status(400).json({ error: 'Informe o WABA ID em "Ativar recebimento" primeiro.' });

    const { name, category, language, body, footer, codeExpirationMinutes } = req.body as {
      name: string; category: string; language: string; body?: string; footer?: string; codeExpirationMinutes?: number;
    };

    let components: Record<string, unknown>[];
    if (category === 'AUTHENTICATION') {
      // Autenticação: a Meta gera o texto do código sozinha — o componente
      // BODY não pode ter "text" (é rejeitado com código 100). Só dá pra
      // configurar a recomendação de segurança, a expiração do código e o
      // botão de copiar código.
      components = [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: codeExpirationMinutes ?? 10 },
        { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }] },
      ];
    } else {
      if (!body?.trim()) return res.status(400).json({ error: 'Corpo da mensagem é obrigatório para esta categoria.' });
      components = [{ type: 'BODY', text: body.trim() }];
      if (footer?.trim()) components.push({ type: 'FOOTER', text: footer.trim() });
    }

    const r = await fetch(`https://graph.facebook.com/v20.0/${config.wabaId}/message_templates`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: slugifyTemplateName(name), category, language, components }),
    });
    const j = await r.json() as any;
    if (!r.ok || j.error) {
      const code = j.error?.code ?? r.status;
      const msg  = j.error?.error_user_msg || j.error?.message || 'Erro desconhecido';
      return res.status(400).json({ error: `${msg} (código: ${code})` });
    }
    res.status(201).json(j);
  } catch {
    res.status(500).json({ error: 'Erro ao enviar template para aprovação' });
  }
});

// ─── Meta Lead Ads Settings ──────────────────────────────────────────────────
// Canal desativado a pedido do usuário (2026-08-10) — a tela de configuração
// foi removida e estas rotas agora só respondem 403, como trava extra (o
// webhook em webhooks.ts já é um no-op). Lógica original preservada no
// histórico do git — buscar o commit anterior a esta mudança se precisar
// reativar um dia.

router.get('/meta-leads', async (_req: AuthRequest, res: Response) => {
  res.status(403).json({ error: 'Meta Lead Ads foi desativado' });
});

router.post('/meta-leads', async (_req: AuthRequest, res: Response) => {
  res.status(403).json({ error: 'Meta Lead Ads foi desativado' });
});

router.get('/meta-leads/forms', async (_req: AuthRequest, res: Response) => {
  res.status(403).json({ error: 'Meta Lead Ads foi desativado' });
});

router.get('/meta-leads/forms/:formId/fields', async (_req: AuthRequest, res: Response) => {
  res.status(403).json({ error: 'Meta Lead Ads foi desativado' });
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
