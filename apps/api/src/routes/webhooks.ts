import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { processIncomingWhatsApp } from '../services/whatsapp.service';

const router = Router();
const prisma = new PrismaClient();

// ─── Meta Lead Ads ────────────────────────────────────────────────────────────

// GET /api/webhooks/meta-leads — Verificação do webhook pela Meta
router.get('/meta-leads', async (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const config = await prisma.metaLeadsConfig.findFirst({
    where: { verifyToken: token as string },
  });

  if (mode === 'subscribe' && config) {
    console.log('[Meta Leads] Webhook verificado!');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

// POST /api/webhooks/meta-leads — Recebe novo lead de formulário
router.post('/meta-leads', async (req: Request, res: Response) => {
  // Meta exige resposta 200 imediata
  res.status(200).end();

  try {
    const body = req.body;
    if (body?.object !== 'page') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'leadgen') continue;

        const { leadgen_id } = change.value;
        console.log('[Meta Leads] Novo lead recebido:', leadgen_id);

        // Busca config ativa
        const config = await prisma.metaLeadsConfig.findFirst({
          where: { active: true },
        });
        if (!config || !config.pageAccessToken) {
          console.warn('[Meta Leads] Nenhuma configuração ativa encontrada');
          continue;
        }

        // Busca dados do lead via Graph API
        const resp = await fetch(
          `https://graph.facebook.com/v19.0/${leadgen_id}?fields=field_data,created_time,ad_id,form_id&access_token=${config.pageAccessToken}`
        );
        if (!resp.ok) {
          console.error('[Meta Leads] Erro ao buscar lead da API:', await resp.text());
          continue;
        }
        const leadData = await resp.json() as { field_data?: { name: string; values: string[] }[]; created_time?: string };

        // Converte field_data em objeto chave→valor (campo Meta → valor)
        const metaFields: Record<string, string> = {};
        for (const f of leadData.field_data || []) {
          metaFields[f.name] = f.values?.[0] ?? '';
        }

        // Aplica mapeamentos configurados: campo Meta → campo CRM
        type FieldMapping = { metaField: string; crmField: string };
        const mappings = (config.fieldMappings as FieldMapping[]) || [];
        const customFields: Record<string, string> = {};

        // 1) Copia todos os campos Meta como estão (fallback)
        Object.assign(customFields, metaFields);

        // 2) Aplica mapeamentos manuais (sobrescreve se houver)
        for (const m of mappings) {
          if (m.metaField && m.crmField && metaFields[m.metaField] !== undefined) {
            customFields[m.crmField] = metaFields[m.metaField];
          }
        }

        // Nome: usa campo mapeado para participante_1, senão tenta nomes padrão
        const name =
          customFields['participante_1'] ||
          metaFields['full_name'] || metaFields['nome'] || metaFields['name'] ||
          [metaFields['first_name'], metaFields['last_name']].filter(Boolean).join(' ') ||
          'Lead Meta Ads';

        // Telefone e e-mail: usa mapeamento ou campos padrão
        const phone =
          customFields['telefone'] ||
          metaFields['phone_number'] || metaFields['phone'] || metaFields['telefone'] || '';
        const email =
          customFields['email_1'] || customFields['email'] ||
          metaFields['email'] || metaFields['e-mail'] || '';

        // Resolve estágio padrão
        let stageId = config.defaultStageId;
        let userId = config.defaultUserId;

        if (!stageId) {
          const pipeline = await prisma.pipeline.findFirst({
            where: { accountId: config.accountId },
            include: { stages: { orderBy: { order: 'asc' } } },
          });
          stageId = pipeline?.stages[0]?.id ?? null;
        }

        if (!userId) {
          const user = await prisma.user.findFirst({
            where: { accountId: config.accountId },
            orderBy: { createdAt: 'asc' },
          });
          userId = user?.id ?? null;
        }

        if (!stageId || !userId) {
          console.error('[Meta Leads] Sem estágio ou usuário padrão configurado');
          continue;
        }

        const stage = await prisma.stage.findUnique({ where: { id: stageId } });
        if (!stage) continue;

        // Cria contato
        const contact = await prisma.contact.create({
          data: {
            name,
            phone: phone || undefined,
            email: email || undefined,
            accountId: config.accountId,
          },
        });

        // Monta nota com todos os campos do formulário
        const formFields = Object.entries(metaFields)
          .map(([k, v]) => `• ${k}: ${v}`)
          .join('\n');

        // Cria lead
        const lead = await prisma.lead.create({
          data: {
            name,
            contactId: contact.id,
            stageId,
            pipelineId: stage.pipelineId,
            userId,
            accountId: config.accountId,
            tags: ['Meta Ads'],
            customFields: customFields as any,
            notes: {
              create: {
                content: `Lead gerado automaticamente via formulário Meta Ads.\n\nCampos preenchidos:\n${formFields}`,
                type: 'COMMENT',
              },
            },
          },
        });

        console.log(`[Meta Leads] Lead criado: ${lead.id} — ${name}`);

        // Notifica via Socket.io
        const io = (req as any).app.get('io');
        if (io) io.to(`account_${config.accountId}`).emit('new_lead', { lead });
      }
    }
  } catch (err) {
    console.error('[Meta Leads] Erro ao processar webhook:', err);
  }
});

// WhatsApp Cloud API webhook — verification
router.get('/whatsapp', async (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Find account config that matches this verify token
  const config = await prisma.whatsAppConfig.findFirst({
    where: { verifyToken: token as string },
  });

  if (mode === 'subscribe' && config) {
    console.log('[WhatsApp] Webhook verificado!');
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

// WhatsApp Cloud API webhook — receive messages
router.post('/whatsapp', async (req: Request, res: Response) => {
  // Always respond 200 immediately (Meta requires it)
  res.status(200).end();

  try {
    const body = req.body;
    if (body?.object !== 'whatsapp_business_account') return;

    // Find which account this phone belongs to
    const phoneNumberId = body?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id;
    const config = await prisma.whatsAppConfig.findFirst({
      where: { phoneNumberId },
    });

    if (!config) {
      console.warn('[WhatsApp] Nenhuma conta encontrada para phoneNumberId:', phoneNumberId);
      return;
    }

    const io = (req as any).app.get('io');
    await processIncomingWhatsApp(body, config.accountId, io);
  } catch (err) {
    console.error('[WhatsApp] Webhook POST error:', err);
  }
});

// Instagram Graph API webhook
router.get('/instagram', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.INSTAGRAM_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.status(403).end();
  }
});

router.post('/instagram', (req: Request, res: Response) => {
  console.log('[Instagram webhook]', JSON.stringify(req.body, null, 2));
  res.status(200).end();
});

// Telegram Bot webhook
router.post('/telegram', (req: Request, res: Response) => {
  console.log('[Telegram webhook]', JSON.stringify(req.body, null, 2));
  res.status(200).end();
});

export default router;
