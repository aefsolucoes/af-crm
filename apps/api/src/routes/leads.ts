import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { getLeads, getLeadById, createLead, updateLead, updateLeadStage, deleteLead } from '../services/lead.service';

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

const createLeadSchema = z.object({
  name: z.string().min(1),
  value: z.number().optional(),
  pipelineId: z.string(),
  stageId: z.string(),
  userId: z.string(),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.any()).optional(),
});

const updateLeadSchema = createLeadSchema.partial().extend({
  status: z.enum(['OPEN', 'WON', 'LOST']).optional(),
  isGroup: z.boolean().optional(),
});
const stageSchema = z.object({ stageId: z.string() });

/** Cria nota de auditoria de forma silenciosa (não lança erro) */
async function auditNote(leadId: string, userId: string | undefined, content: string, type: 'STAGE_CHANGE' | 'DATA_EDIT' = 'DATA_EDIT') {
  try {
    await prisma.note.create({ data: { leadId, content, type, userId } });
  } catch { /* silencioso */ }
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const archived = req.query.archived === 'true';
    const leads = await getLeads(req.user!.accountId, req.query.pipelineId as string, req.query.stageId as string, archived);
    res.json(leads);
  } catch (err: unknown) {
    res.status(500).json({ error: 'Erro ao buscar leads' });
  }
});

// ─── GET /api/leads/duplicate-groups ──────────────────────────────────────────
// Agrupa TODOS os leads duplicados da conta (mesmo telefone ou mesmo nome).
// Registrado ANTES de '/:id' para não ser capturado como um id.
router.get('/duplicate-groups', async (req: AuthRequest, res: Response) => {
  try {
    const leads = await prisma.lead.findMany({
      where: { accountId: req.user!.accountId, archived: false },
      include: {
        contact: true,
        stage: { include: { pipeline: true } },
        _count: { select: { messages: true } },
      },
    });

    const norm = (l: (typeof leads)[0]) => {
      const cf = (l.customFields || {}) as Record<string, string>;
      const phone = (cf.telefone_1 || l.contact?.phone || l.contact?.whatsappPhone || '').replace(/\D/g, '');
      const name = (cf.participante_1 || l.name || '').toLowerCase().trim();
      return { phone, name };
    };

    // Chave de agrupamento: últimos 8 dígitos do telefone; senão o nome (se tiver >3 letras)
    const groupsMap = new Map<string, typeof leads>();
    for (const l of leads) {
      const { phone, name } = norm(l);
      let key = '';
      if (phone && phone.length >= 8) key = 'p:' + phone.slice(-8);
      else if (name && name.replace(/[^a-z0-9]/g, '').length > 3) key = 'n:' + name;
      else continue; // sem telefone nem nome útil → não agrupa
      const arr = groupsMap.get(key) || [];
      arr.push(l);
      groupsMap.set(key, arr);
    }

    const groups = [...groupsMap.values()]
      .filter((arr) => arr.length > 1)
      .map((arr) => {
        // Melhor candidato a manter: mais mensagens → mais dados → mais antigo
        const scored = arr
          .map((l) => {
            const cf = (l.customFields || {}) as Record<string, string>;
            const dataScore = Object.values(cf).filter((v) => String(v || '').trim()).length + (l.value ? 2 : 0);
            return { l, msgs: l._count.messages, dataScore };
          })
          .sort((a, b) =>
            b.msgs - a.msgs ||
            b.dataScore - a.dataScore ||
            a.l.createdAt.getTime() - b.l.createdAt.getTime(),
          );
        return {
          leads: scored.map(({ l, msgs }) => {
            const cf = (l.customFields || {}) as Record<string, string>;
            return {
              id: l.id,
              name: cf.participante_1 || l.name,
              phone: cf.telefone_1 || l.contact?.phone || null,
              pipeline: l.stage?.pipeline?.name || null,
              stage: l.stage?.name || null,
              value: l.value,
              messages: msgs,
              isGroup: l.isGroup,
              createdAt: l.createdAt,
            };
          }),
        };
      })
      // grupos de conversa (@g.us) não entram na deduplicação
      .filter((g) => !g.leads.every((l) => l.isGroup))
      .sort((a, b) => b.leads.length - a.leads.length);

    res.json({ groups, total: groups.length });
  } catch (err) {
    console.error('[DuplicateGroups]', err);
    res.status(500).json({ error: 'Erro ao buscar duplicados' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const lead = await getLeadById(req.params.id, req.user!.accountId);
    if (!lead) { res.status(404).json({ error: 'Lead não encontrado' }); return; }
    res.json(lead);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar lead' });
  }
});

router.post('/', validate(createLeadSchema), async (req: AuthRequest, res: Response) => {
  try {
    const lead = await createLead({ ...req.body, accountId: req.user!.accountId });
    res.status(201).json(lead);
  } catch {
    res.status(500).json({ error: 'Erro ao criar lead' });
  }
});

router.put('/:id', validate(updateLeadSchema), async (req: AuthRequest, res: Response) => {
  try {
    // Captura estado anterior para auditoria
    const before = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { name: true } },
        stage: true,
      },
    });

    const lead = await updateLead(req.params.id, req.user!.accountId, req.body);
    res.json(lead);

    // Auditoria assíncrona
    try {
      const userName = req.user!.id
        ? (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'Usuário'
        : 'Usuário';

      if (req.body.status && before?.status !== req.body.status) {
        const statusLabels: Record<string, string> = { WON: 'Ganho', LOST: 'Perdido', OPEN: 'Aberto' };
        await auditNote(req.params.id, req.user!.id,
          `Status alterado para "${statusLabels[req.body.status] || req.body.status}" por ${userName}`);

        // ── Auto-migração: lead marcado como Ganho → funil "Concluído" ──
        if (req.body.status === 'WON') {
          const concluido = await prisma.pipeline.findFirst({
            where: { accountId: req.user!.accountId, name: 'Concluído' },
            include: { stages: { orderBy: { order: 'asc' } } },
          });
          const targetStage = concluido?.stages[0];
          if (concluido && targetStage) {
            const movedLead = await prisma.lead.update({
              where: { id: req.params.id },
              data: {
                pipelineId: concluido.id,
                stageId: targetStage.id,
                notes: {
                  create: {
                    content: `Lead migrado automaticamente para o funil "Concluído" ao ser marcado como Ganho — por ${userName}.`,
                    type: 'STAGE_CHANGE',
                    userId: req.user!.id,
                  },
                },
              },
            });
            const io = (req as any).app.get('io');
            if (io) io.to(`account_${req.user!.accountId}`).emit('lead_moved', { lead: movedLead });
            console.log(`[Auto-migração] Lead "${movedLead.name}" marcado como Ganho → funil Concluído`);
          }
        }
      }
      if (req.body.userId && before?.userId !== req.body.userId) {
        const newUser = await prisma.user.findUnique({ where: { id: req.body.userId }, select: { name: true } });
        await auditNote(req.params.id, req.user!.id,
          `Responsável alterado de "${before?.user?.name || '—'}" para "${newUser?.name || '—'}" por ${userName}`);
      }
    } catch { /* silencioso */ }
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar lead' });
  }
});

router.patch('/:id/stage', validate(stageSchema), async (req: AuthRequest, res: Response) => {
  try {
    // Captura estágio anterior para auditoria
    const before = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: { stage: true },
    });

    const lead = await updateLeadStage(req.params.id, req.user!.accountId, req.body.stageId);
    res.json(lead);

    // ── Auditoria de mudança de estágio ──────────────────────────────────────
    try {
      const newStage = await prisma.stage.findUnique({ where: { id: req.body.stageId }, include: { pipeline: true } });
      const userName = req.user!.id
        ? (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'Usuário'
        : 'Usuário';

      if (before?.stage?.name !== newStage?.name) {
        await auditNote(req.params.id, req.user!.id,
          `Estágio: "${before?.stage?.name || '—'}" → "${newStage?.name || '—'}" — por ${userName}`,
          'STAGE_CHANGE');
      }

      // ── Auto-migração: se movido para "Fechado" no pipeline "Vendas" ────────
      if (newStage?.name === 'Fechado' && newStage.pipeline.name === 'Vendas') {
        const emContratacao = await prisma.pipeline.findFirst({
          where: { accountId: req.user!.accountId, name: 'Em contratação' },
          include: { stages: { orderBy: { order: 'asc' } } },
        });
        const targetStage = emContratacao?.stages.find(s => s.name === 'Documentação Recebida') || emContratacao?.stages[0];
        if (emContratacao && targetStage) {
          const movedLead = await prisma.lead.update({
            where: { id: req.params.id },
            data: {
              pipelineId: emContratacao.id,
              stageId: targetStage.id,
              notes: {
                create: {
                  content: `Lead migrado automaticamente para o funil "Em contratação" (${targetStage.name}) ao ser fechado em Vendas.`,
                  type: 'STAGE_CHANGE',
                  userId: req.user!.id,
                },
              },
            },
          });
          const io = (req as any).app.get('io');
          if (io) io.to(`account_${req.user!.accountId}`).emit('lead_moved', { lead: movedLead });
          console.log(`[Auto-migração] Lead "${movedLead.name}" movido → Em contratação (${targetStage.name})`);
        }
      }
    } catch (migErr) {
      console.error('[Auditoria/Auto-migração] Erro:', migErr);
    }
  } catch {
    res.status(500).json({ error: 'Erro ao mover lead' });
  }
});

// PATCH /api/leads/:id/pipeline — mover lead para outro pipeline
router.patch('/:id/pipeline', async (req: AuthRequest, res: Response) => {
  try {
    const { pipelineId, stageId } = req.body as { pipelineId: string; stageId?: string };
    if (!pipelineId) return res.status(400).json({ error: 'pipelineId obrigatório' });

    const before = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: { pipeline: true, stage: true },
    });

    let targetStageId = stageId;
    if (!targetStageId) {
      const pipeline = await prisma.pipeline.findUnique({
        where: { id: pipelineId },
        include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
      });
      if (!pipeline || !pipeline.stages[0]) {
        return res.status(404).json({ error: 'Pipeline ou estágio não encontrado' });
      }
      targetStageId = pipeline.stages[0].id;
    }

    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { pipelineId, stageId: targetStageId },
    });
    res.json(lead);

    // Auditoria
    try {
      const newPipeline = await prisma.pipeline.findUnique({ where: { id: pipelineId } });
      const newStage = await prisma.stage.findUnique({ where: { id: targetStageId! } });
      const userName = req.user!.id
        ? (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'Usuário'
        : 'Usuário';
      await auditNote(req.params.id, req.user!.id,
        `Movido do funil "${before?.pipeline?.name || '—'}" para "${newPipeline?.name || '—'}" (${newStage?.name || '—'}) por ${userName}`,
        'STAGE_CHANGE');
    } catch { /* silencioso */ }
  } catch {
    res.status(500).json({ error: 'Erro ao mover lead para outro pipeline' });
  }
});

// PATCH /api/leads/:id/archive — arquivar ou desarquivar
router.patch('/:id/archive', async (req: AuthRequest, res: Response) => {
  try {
    const { archived } = req.body as { archived: boolean };
    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { archived: archived ?? true },
    });
    res.json(lead);

    // Auditoria
    try {
      const userName = req.user!.id
        ? (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'Usuário'
        : 'Usuário';
      await auditNote(req.params.id, req.user!.id,
        archived ? `Lead arquivado por ${userName}` : `Lead restaurado por ${userName}`);
    } catch { /* silencioso */ }
  } catch {
    res.status(500).json({ error: 'Erro ao arquivar lead' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await deleteLead(req.params.id, req.user!.accountId);
    res.status(204).end();
  } catch {
    res.status(500).json({ error: 'Erro ao excluir lead' });
  }
});

// ─── GET /api/leads/:id/duplicates ────────────────────────────────────────────
// Busca possíveis leads duplicados com base em nome e telefone
router.get('/:id/duplicates', async (req: AuthRequest, res: Response) => {
  try {
    const lead = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: { contact: true },
    });
    if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });

    const cf = (lead.customFields || {}) as Record<string, string>;
    const phone1 = cf.telefone_1?.replace(/\D/g, '') || lead.contact?.phone?.replace(/\D/g, '') || '';
    const name1  = (cf.participante_1 || lead.name || '').toLowerCase().trim();

    // Busca todos os outros leads da conta
    const allLeads = await prisma.lead.findMany({
      where: { accountId: req.user!.accountId, id: { not: lead.id }, archived: false },
      include: { contact: true, stage: { include: { pipeline: true } }, user: { select: { name: true } } },
    });

    const candidates: { lead: typeof allLeads[0]; score: number; reasons: string[] }[] = [];

    for (const other of allLeads) {
      const ocf = (other.customFields || {}) as Record<string, string>;
      const otherPhone = ocf.telefone_1?.replace(/\D/g, '') || other.contact?.phone?.replace(/\D/g, '') || '';
      const otherName  = (ocf.participante_1 || other.name || '').toLowerCase().trim();

      const reasons: string[] = [];
      let score = 0;

      // Mesmo telefone (últimos 8 dígitos)
      if (phone1 && otherPhone && phone1.slice(-8) === otherPhone.slice(-8)) {
        score += 80;
        reasons.push('Mesmo telefone');
      }

      // Nome igual ou muito similar
      if (name1 && otherName) {
        if (name1 === otherName) {
          score += 60;
          reasons.push('Nome idêntico');
        } else {
          // Verifica se primeiro nome coincide
          const firstName1 = name1.split(' ')[0];
          const firstNameO = otherName.split(' ')[0];
          if (firstName1.length > 3 && firstName1 === firstNameO) {
            score += 30;
            reasons.push('Mesmo primeiro nome');
          }
        }
      }

      if (score >= 30) {
        candidates.push({ lead: other, score, reasons });
      }
    }

    // Ordena por score decrescente, limita a 5
    const duplicates = candidates
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(c => ({
        id: c.lead.id,
        name: c.lead.name,
        stage: c.lead.stage?.name,
        pipeline: c.lead.stage?.pipeline?.name,
        user: c.lead.user?.name,
        createdAt: c.lead.createdAt,
        customFields: c.lead.customFields,
        score: c.score,
        reasons: c.reasons,
      }));

    res.json({ duplicates });
  } catch (err) {
    console.error('[Duplicates]', err);
    res.status(500).json({ error: 'Erro ao buscar duplicatas' });
  }
});

// ─── POST /api/leads/:id/merge ─────────────────────────────────────────────────
// Une o lead duplicado (sourceId) neste lead (keepId = :id)
// Migra: mensagens, tarefas, notas. Exclui o sourceId.
router.post('/:id/merge', async (req: AuthRequest, res: Response) => {
  try {
    const keepId   = req.params.id;
    const { sourceId } = req.body as { sourceId: string };
    if (!sourceId) return res.status(400).json({ error: 'sourceId obrigatório' });

    const [keep, source] = await Promise.all([
      prisma.lead.findUnique({ where: { id: keepId, accountId: req.user!.accountId } }),
      prisma.lead.findUnique({ where: { id: sourceId, accountId: req.user!.accountId } }),
    ]);
    if (!keep || !source) return res.status(404).json({ error: 'Lead não encontrado' });

    // Merge customFields (keep tem prioridade)
    const mergedCF = {
      ...((source.customFields as any) || {}),
      ...((keep.customFields as any) || {}),
    };

    // Merge value (maior vence)
    const mergedValue = Math.max(keep.value || 0, source.value || 0) || undefined;

    await prisma.$transaction([
      // Move mensagens
      prisma.message.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      // Move tarefas
      prisma.task.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      // Move notas
      prisma.note.updateMany({ where: { leadId: sourceId }, data: { leadId: keepId } }),
      // Atualiza lead principal com campos mesclados
      prisma.lead.update({
        where: { id: keepId },
        data: { customFields: mergedCF as any, value: mergedValue },
      }),
      // Adiciona nota de auditoria
      prisma.note.create({
        data: {
          leadId: keepId,
          content: `Lead unificado com "${source.name}" (ID: ${sourceId}). Mensagens, tarefas e notas foram migradas.`,
          type: 'DATA_EDIT',
          userId: req.user!.id,
        },
      }),
      // Deleta lead duplicado
      prisma.lead.delete({ where: { id: sourceId } }),
    ]);

    const updated = await prisma.lead.findUnique({ where: { id: keepId } });
    res.json({ success: true, lead: updated });
  } catch (err) {
    console.error('[Merge]', err);
    res.status(500).json({ error: 'Erro ao unificar leads' });
  }
});

// PATCH /api/leads/:id/custom-fields
router.patch('/:id/custom-fields', async (req: AuthRequest, res: Response) => {
  try {
    const { customFields } = req.body;
    const lead = await updateLead(req.params.id, req.user!.accountId, { customFields } as any);
    res.json(lead);
  } catch {
    res.status(500).json({ error: 'Erro ao salvar campos' });
  }
});

export default router;
