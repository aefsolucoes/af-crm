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
router.post('/whatsapp', validate(whatsappSchema), async (req: AuthRequest, res: Response) => {
  try {
    const config = await saveWhatsAppConfig(req.user!.accountId, req.body);
    res.json({ success: true, active: config.active });
  } catch {
    res.status(500).json({ error: 'Erro ao salvar configurações' });
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

export default router;
