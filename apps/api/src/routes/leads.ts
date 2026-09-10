import { Router, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { loadPerms } from '../middleware/permission';
import { validate } from '../middleware/validate';
import { getLeads, getLeadById, createLead, updateLead, updateLeadStage, deleteLead, mergeLeadsBySameContact } from '../services/lead.service';
import { getScopeDepartmentIds, getOrCreateInboxPipeline } from '../services/department.service';
import { normalizeBrazilianWhatsAppPhone } from '../services/whatsapp.service';
import { checkHasWhatsApp } from '../services/baileys.service';
import { normalizeClientName } from '../lib/text';
import { runAutomations } from '../services/automation.service';
import { logActivity } from '../services/activity.service';

/** Formata um telefone BR (com DDI 55) pra exibição — mesma regra usada em
 *  baileys.service.ts, duplicada aqui de propósito (função pura pequena,
 *  não vale importar de um serviço de canal pra uma rota de leads). */
function formatPhoneDisplay(e164Digits: string): string {
  const d = e164Digits.startsWith('55') ? e164Digits.slice(2) : e164Digits;
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `+${e164Digits}`;
}

const router = Router();
const prisma = new PrismaClient();
router.use(authMiddleware);

// Leitura (GET) fica aberta — a Inbox e outras telas dependem dos dados do lead.
// Qualquer escrita no funil (criar/editar/mover/arquivar/excluir/merge) exige a
// permissão "gerenciar cards".
router.use(async (req: AuthRequest, res: Response, next) => {
  if (req.method === 'GET') return next();
  try {
    const perms = await loadPerms(req);
    if (!perms.funnel_manage) return res.status(403).json({ error: 'Você não tem permissão para editar cards do funil.' });
    next();
  } catch {
    res.status(500).json({ error: 'Erro ao verificar permissão' });
  }
});

const MONTH_NAMES_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

/** Nome do mês atual no fuso de Brasília, independente do fuso do servidor. */
function currentMonthNamePT(): string {
  const idx = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', month: 'numeric' }).format(new Date()), 10) - 1;
  return MONTH_NAMES_PT[idx];
}

/** Converte um valor de campo do cadastro (customFields) para número. Aceita
 *  tanto o formato "puro" já normalizado pelo front ("500000") quanto, por
 *  segurança, um formato BR digitado direto ("500.000,00"). */
function parseFieldNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  const cleaned = s.replace(/[^\d,.-]/g, '');
  if (cleaned.includes(',') && cleaned.includes('.')) {
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.')) || 0;
  }
  if (cleaned.includes(',')) return parseFloat(cleaned.replace(',', '.')) || 0;
  return parseFloat(cleaned) || 0;
}

/** Fila de criação por (conta+nome+setor) — o "achar ou criar" abaixo não é
 *  atômico: dois PUTs marcando leads como Ganho/Perdido quase juntos podiam
 *  criar dois funis "Concluído"/"Perdidos" duplicados — mesma classe de
 *  corrida já corrigida em createFolder (google.service.ts) e
 *  getOrCreateInboxPipeline (department.service.ts). */
const namedPipelineLocks = new Map<string, Promise<unknown>>();

/** Funil com um estágio por mês do ano (pra saber quantos entraram em cada
 *  mês) — usado tanto por "Concluído" (leads Ganho) quanto "Perdidos" (leads
 *  Perdido). Cria sozinho na primeira vez que precisar, sem exigir
 *  configuração manual antes. Um por departamento — cada setor tem o seu. */
async function getOrCreateNamedPipeline(
  accountId: string,
  name: string,
  departmentId: string | null | undefined,
  stageColor: string,
  /** Etapas do funil na criação. Sem isso, cria um estágio por mês (uso de
   *  "Concluído"/"Perdidos"). Com isso, cria exatamente essas (ex.: as 7 de
   *  "Em contratação"). Ignorado se o funil já existir. */
  stageDefs?: { name: string; order: number; color: string }[],
) {
  const key = `${accountId}::${name}::${departmentId ?? ''}`;
  const run = async () => {
    const existing = await prisma.pipeline.findFirst({
      where: { accountId, name, departmentId: departmentId ?? null },
      include: { stages: { orderBy: { order: 'asc' } } },
      orderBy: { id: 'asc' },
    });
    if (existing) return existing;

    const created = await prisma.pipeline.create({
      data: {
        name,
        accountId,
        departmentId: departmentId ?? null,
        stages: {
          create: stageDefs
            ? stageDefs.map((s) => ({ name: s.name, order: s.order, color: s.color }))
            : MONTH_NAMES_PT.map((n, i) => ({ name: n, order: i + 1, color: stageColor })),
        },
      },
      include: { stages: { orderBy: { order: 'asc' } } },
    });

    // Auto-cura da corrida entre PROCESSOS (a trava por chave acima só vale
    // dentro de um processo; num redeploy do Railway dois processos podem
    // criar o mesmo funil ao mesmo tempo — foi o que gerou dois "Perdidos"
    // no Home Equity). Se sobrou mais de um com esse nome/setor, fica com o
    // de id mais antigo e apaga os outros que estiverem VAZIOS.
    const all = await prisma.pipeline.findMany({
      where: { accountId, name, departmentId: departmentId ?? null },
      include: { _count: { select: { leads: true } } },
      orderBy: { id: 'asc' },
    });
    if (all.length > 1) {
      const keep = all[0];
      for (const extra of all.slice(1)) {
        if (extra._count.leads === 0) {
          await prisma.stage.deleteMany({ where: { pipelineId: extra.id } }).catch(() => {});
          await prisma.pipeline.delete({ where: { id: extra.id } }).catch(() => {});
        }
      }
      if (keep.id !== created.id) {
        return prisma.pipeline.findUniqueOrThrow({ where: { id: keep.id }, include: { stages: { orderBy: { order: 'asc' } } } });
      }
    }
    return created;
  };
  const previous = namedPipelineLocks.get(key) || Promise.resolve();
  const result = previous.then(run);
  // guarda uma cópia que nunca rejeita — senão uma falha travaria a fila pra
  // sempre esperando uma promise rejeitada que ninguém mais trata.
  namedPipelineLocks.set(key, result.catch(() => undefined));
  return result as ReturnType<typeof run>;
}

async function getOrCreateConcluidoPipeline(accountId: string, departmentId?: string | null) {
  return getOrCreateNamedPipeline(accountId, 'Concluído', departmentId, '#10b981');
}

/** Funil "Perdidos" — pra onde vão os leads marcados como Perdido, do mesmo
 *  jeito que "Concluído" já faz com Ganho (usuário pediu: card sumia dentro
 *  do funil ativo, só com uma etiqueta, difícil de achar depois). */
async function getOrCreatePerdidosPipeline(accountId: string, departmentId?: string | null) {
  return getOrCreateNamedPipeline(accountId, 'Perdidos', departmentId, '#ef4444');
}

/** Etapas do funil de contratação (mesmas do "Em contratação" criado em
 *  POST /api/pipelines/setup) — usadas pra criar o "Em contratação Home
 *  Equity" quando ainda não existe. */
const CONTRACTING_STAGES = [
  { name: 'Documentação Recebida', order: 1, color: '#3b82f6' },
  { name: 'Crédito em Análise',    order: 2, color: '#f59e0b' },
  { name: 'Crédito Aprovado',      order: 3, color: '#10b981' },
  { name: 'Vistoria do Imóvel',    order: 4, color: '#8b5cf6' },
  { name: 'Análise Jurídica',      order: 5, color: '#f97316' },
  { name: 'Registro em Cartório',  order: 6, color: '#ef4444' },
  { name: 'Pagamento ao Vendedor', order: 7, color: '#059669' },
];

/** Funil "Em contratação" de um setor — cria com as 7 etapas padrão se faltar.
 *  Financiamento Habitacional usa o "Em contratação" que já existe; Home Equity
 *  ganha o seu ("Em contratação Home Equity"). */
async function getOrCreateContractingPipeline(accountId: string, name: string, departmentId?: string | null) {
  return getOrCreateNamedPipeline(accountId, name, departmentId, '#3b82f6', CONTRACTING_STAGES);
}

const createLeadSchema = z.object({
  name: z.string().min(1),
  value: z.number().optional(),
  // Sem funil/etapa definidos, o lead cai na Caixa de Entrada global (resolvido
  // no handler do POST). O +Novo Lead sempre manda os dois; isso cobre chamadas
  // de API e cenários futuros de intake automático.
  pipelineId: z.string().optional(),
  stageId: z.string().optional(),
  userId: z.string(),
  contactId: z.string().optional(),
  companyId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  customFields: z.record(z.any()).optional(),
});

const updateLeadSchema = createLeadSchema.partial().extend({
  status: z.enum(['OPEN', 'WON', 'LOST']).optional(),
  lostReason: z.string().max(500).nullable().optional(),
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
    const isAdmin = req.user!.role === 'ADMIN';
    const archived = req.query.archived === 'true';
    const scopeDepartmentIds = await getScopeDepartmentIds(req.user!.accountId, req.user!.id, req.user!.role);
    const leads = await getLeads(req.user!.accountId, req.query.pipelineId as string, req.query.stageId as string, archived, isAdmin, scopeDepartmentIds);
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
      const phoneRaw = (cf.telefone_1 || l.contact?.phone || l.contact?.whatsappPhone || '').replace(/\D/g, '');
      const phone = phoneRaw.length >= 8 ? phoneRaw.slice(-8) : '';
      const nameRaw = (cf.participante_1 || l.name || '').toLowerCase().trim();
      const name = nameRaw.replace(/[^a-z0-9]/g, '').length > 3 ? nameRaw : '';
      return { phone, name };
    };

    // União por telefone OU nome (union-find). Assim o mesmo cliente que tem um
    // lead com telefone e outro só com @lid (mesmo nome) cai no MESMO grupo.
    const parent = new Map<number, number>();
    const find = (x: number): number => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      let c = x;
      while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; }
      return r;
    };
    const union = (a: number, b: number) => { parent.set(find(a), find(b)); };

    leads.forEach((_, i) => parent.set(i, i));
    const byPhone = new Map<string, number>();
    const byName = new Map<string, number>();
    leads.forEach((l, i) => {
      const { phone, name } = norm(l);
      if (phone) {
        if (byPhone.has(phone)) union(i, byPhone.get(phone)!); else byPhone.set(phone, i);
      }
      if (name) {
        if (byName.has(name)) union(i, byName.get(name)!); else byName.set(name, i);
      }
    });

    const groupsMap = new Map<number, typeof leads>();
    leads.forEach((l, i) => {
      const { phone, name } = norm(l);
      if (!phone && !name) return; // sem telefone nem nome útil → não agrupa
      const root = find(i);
      const arr = groupsMap.get(root) || [];
      arr.push(l);
      groupsMap.set(root, arr);
    });

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

// ─── GET /api/leads/find-by-phone ──────────────────────────────────────────
// Acha o lead mais recente com esse telefone (últimos 8 dígitos) — usado pelo
// "+Novo Lead" pra avisar ANTES de criar duplicado (achado real: cadastro
// manual não checava telefone repetido, ao contrário das mensagens
// automáticas de WhatsApp, que já reaproveitam o lead existente). Registrado
// ANTES de '/:id' para não ser capturado como um id.
router.get('/find-by-phone', async (req: AuthRequest, res: Response) => {
  try {
    const raw = String(req.query.phone || '').replace(/\D/g, '');
    if (raw.length < 8) return res.json(null);
    const last8 = raw.slice(-8);

    const leads = await prisma.lead.findMany({
      where: { accountId: req.user!.accountId, archived: false },
      include: { contact: true, stage: { include: { pipeline: true } } },
      orderBy: { updatedAt: 'desc' },
      take: 500, // conta grande — evita varrer a tabela inteira; telefone repetido tende a ser recente
    });

    const match = leads.find((l) => {
      const cf = (l.customFields || {}) as Record<string, string>;
      const phone = (cf.telefone_1 || l.contact?.phone || l.contact?.whatsappPhone || '').replace(/\D/g, '');
      return phone.length >= 8 && phone.slice(-8) === last8;
    });

    if (!match) return res.json(null);
    res.json({
      id: match.id,
      name: match.name,
      pipelineName: match.stage?.pipeline?.name || '',
      stageName: match.stage?.name || '',
    });
  } catch {
    res.status(500).json({ error: 'Erro ao buscar por telefone' });
  }
});

// ─── POST /api/leads/bulk-move ────────────────────────────────────────────
// Move VÁRIOS leads de uma vez pra outro funil/estágio (seleção em massa no
// Kanban). Registrado ANTES de '/:id' pra não ser capturado como id.
router.post('/bulk-move', async (req: AuthRequest, res: Response) => {
  try {
    const { leadIds, pipelineId, stageId } = req.body as { leadIds?: unknown; pipelineId?: string; stageId?: string };
    const ids = Array.isArray(leadIds) ? leadIds.filter((v): v is string => typeof v === 'string' && v.length > 0) : [];
    if (!ids.length) return res.status(400).json({ error: 'Nenhum lead selecionado' });
    if (!pipelineId) return res.status(400).json({ error: 'pipelineId obrigatório' });

    const accountId = req.user!.accountId;
    const pipeline = await prisma.pipeline.findFirst({
      where: { id: pipelineId, accountId },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    if (!pipeline || !pipeline.stages.length) return res.status(404).json({ error: 'Funil ou estágio não encontrado' });

    // Estágio pedido tem que ser DESSE funil; sem pedir, cai no primeiro.
    const targetStage = stageId
      ? pipeline.stages.find((s) => s.id === stageId)
      : pipeline.stages[0];
    if (!targetStage) return res.status(400).json({ error: 'Estágio não pertence ao funil escolhido' });

    // Só mexe nos leads que são REALMENTE da conta (ignora id inválido/de outra conta em silêncio).
    const owned = await prisma.lead.findMany({ where: { id: { in: ids }, accountId }, select: { id: true } });
    const ownedIds = owned.map((l) => l.id);
    if (!ownedIds.length) return res.status(404).json({ error: 'Nenhum lead válido para mover' });

    const result = await prisma.lead.updateMany({
      where: { id: { in: ownedIds } },
      data: { pipelineId: pipeline.id, stageId: targetStage.id },
    });

    // Auditoria + automação por lead, em segundo plano (não segura a resposta).
    (async () => {
      const userName = (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'Usuário';
      const io = (req as any).app.get('io');
      for (const id of ownedIds) {
        await auditNote(id, req.user!.id, `Movido em massa para o funil "${pipeline.name}" (${targetStage.name}) por ${userName}`, 'STAGE_CHANGE');
        runAutomations({ accountId, trigger: 'STAGE_CHANGE', leadId: id, io, context: { newStageId: targetStage.id } }).catch(() => {});
      }
      logActivity({
        accountId, userId: req.user!.id, userName,
        action: 'leads_bulk_moved',
        summary: `moveu ${ownedIds.length} lead(s) para "${pipeline.name}" (${targetStage.name})`,
      });
    })().catch(() => {});

    res.json({ moved: result.count, pipelineName: pipeline.name, stageName: targetStage.name });
  } catch {
    res.status(500).json({ error: 'Erro ao mover os leads' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const lead = await getLeadById(req.params.id, req.user!.accountId);
    if (!lead) { res.status(404).json({ error: 'Lead não encontrado' }); return; }
    // Não-admin não abre card de OUTRO departamento mesmo sabendo o id de cor.
    const scopeDepartmentIds = await getScopeDepartmentIds(req.user!.accountId, req.user!.id, req.user!.role);
    const leadDeptId = (lead as any).pipeline?.departmentId as string | null | undefined;
    if (scopeDepartmentIds.length && leadDeptId && !scopeDepartmentIds.includes(leadDeptId)) {
      res.status(404).json({ error: 'Lead não encontrado' });
      return;
    }
    res.json(lead);
  } catch {
    res.status(500).json({ error: 'Erro ao buscar lead' });
  }
});

router.post('/', validate(createLeadSchema), async (req: AuthRequest, res: Response) => {
  try {
    const body = { ...req.body };
    // Sem funil/etapa: cai na Caixa de Entrada global (mesma central do
    // WhatsApp e da importação).
    if (!body.pipelineId || !body.stageId) {
      const inbox = await getOrCreateInboxPipeline(req.user!.accountId);
      body.pipelineId = inbox.id;
      body.stageId = inbox.stages[0]?.id;
      if (!body.stageId) return res.status(500).json({ error: 'Caixa de Entrada sem etapa de destino' });
    }
    const lead = await createLead({ ...body, accountId: req.user!.accountId });
    res.status(201).json(lead);
    runAutomations({ accountId: req.user!.accountId, trigger: 'NEW_LEAD', leadId: lead.id, io: (req as any).app.get('io') }).catch(() => {});
    logActivity({
      accountId: req.user!.accountId, userId: req.user!.id,
      action: 'lead_created', leadId: lead.id, leadName: lead.name,
      summary: 'criou o lead',
    });
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
        pipeline: { select: { departmentId: true } },
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
        logActivity({
          accountId: req.user!.accountId, userId: req.user!.id, userName,
          action: 'lead_status_changed', leadId: req.params.id, leadName: lead.name,
          summary: `marcou como "${statusLabels[req.body.status] || req.body.status}"`,
        });

        // ── Auto-migração: lead marcado como Ganho → funil "Concluído" (mês atual) ──
        if (req.body.status === 'WON') {
          const concluido = await getOrCreateConcluidoPipeline(req.user!.accountId, before?.pipeline?.departmentId ?? null);
          const mesAtual = currentMonthNamePT();
          const targetStage = concluido.stages.find((s) => s.name === mesAtual) || concluido.stages[0];
          if (targetStage) {
            const movedLead = await prisma.lead.update({
              where: { id: req.params.id },
              data: {
                pipelineId: concluido.id,
                stageId: targetStage.id,
                notes: {
                  create: {
                    content: `Lead migrado automaticamente para o funil "Concluído" (${targetStage.name}) ao ser marcado como Ganho — por ${userName}.`,
                    type: 'STAGE_CHANGE',
                    userId: req.user!.id,
                  },
                },
              },
            });
            const io = (req as any).app.get('io');
            if (io) io.to(`account_${req.user!.accountId}`).emit('lead_moved', { lead: movedLead });
            console.log(`[Auto-migração] Lead "${movedLead.name}" marcado como Ganho → funil Concluído (${targetStage.name})`);
          }

          // ── Sugestão de comissão: 1% do valor de crédito, para revisar no Financeiro ──
          try {
            const cf = (before?.customFields as Record<string, unknown>) || {};
            const baseAmount = parseFieldNumber(cf.valor_credito);
            if (baseAmount > 0) {
              const already = await prisma.commissionSuggestion.findFirst({
                where: { leadId: req.params.id, status: { in: ['PENDING', 'CONFIRMED'] } },
              });
              if (!already) {
                await prisma.commissionSuggestion.create({
                  data: {
                    accountId: req.user!.accountId,
                    leadId: req.params.id,
                    baseAmount,
                    suggestedAmount: Math.round(baseAmount * 0.01 * 100) / 100,
                  },
                });
                console.log(`[Comissão] Sugestão criada para lead ${req.params.id}: 1% de ${baseAmount}`);
              }
            }
          } catch (err) {
            console.error('[Comissão] Falha ao criar sugestão:', (err as any)?.message);
          }
        }

        // ── Auto-migração: lead marcado como Perdido → funil "Perdidos" (mês atual) ──
        // Antes o card só ganhava uma etiqueta e continuava perdido de vista no
        // funil ativo — usuário pediu pra sumir de lá, igual já acontece com Ganho.
        if (req.body.status === 'LOST') {
          const perdidos = await getOrCreatePerdidosPipeline(req.user!.accountId, before?.pipeline?.departmentId ?? null);
          const mesAtual = currentMonthNamePT();
          const targetStage = perdidos.stages.find((s) => s.name === mesAtual) || perdidos.stages[0];
          if (targetStage) {
            const motivo = typeof req.body.lostReason === 'string' ? req.body.lostReason.trim() : '';
            const movedLead = await prisma.lead.update({
              where: { id: req.params.id },
              data: {
                pipelineId: perdidos.id,
                stageId: targetStage.id,
                notes: {
                  create: {
                    content: motivo
                      ? `Lead migrado automaticamente para o funil "Perdidos" (${targetStage.name}) ao ser marcado como Perdido — por ${userName}. Motivo: ${motivo}`
                      : `Lead migrado automaticamente para o funil "Perdidos" (${targetStage.name}) ao ser marcado como Perdido — por ${userName}.`,
                    type: 'STAGE_CHANGE',
                    userId: req.user!.id,
                  },
                },
              },
            });
            const io = (req as any).app.get('io');
            if (io) io.to(`account_${req.user!.accountId}`).emit('lead_moved', { lead: movedLead });
            console.log(`[Auto-migração] Lead "${movedLead.name}" marcado como Perdido → funil Perdidos (${targetStage.name})`);
          }
        }
      }
      if (req.body.userId && before?.userId !== req.body.userId) {
        const newUser = await prisma.user.findUnique({ where: { id: req.body.userId }, select: { name: true } });
        await auditNote(req.params.id, req.user!.id,
          `Responsável alterado de "${before?.user?.name || '—'}" para "${newUser?.name || '—'}" por ${userName}`);
        logActivity({
          accountId: req.user!.accountId, userId: req.user!.id, userName,
          action: 'lead_edited', leadId: req.params.id, leadName: lead.name,
          summary: `passou o card para ${newUser?.name || 'outro responsável'}`,
        });
      } else if (!req.body.status && (req.body.name !== undefined || req.body.value !== undefined || req.body.customFields !== undefined || req.body.contactId !== undefined || req.body.companyId !== undefined || req.body.tags !== undefined)) {
        // Edição comum do card (nome/valor/campos/tags) — um registro só, sem
        // detalhar cada campo (o histórico fino já vive nas notas do lead).
        logActivity({
          accountId: req.user!.accountId, userId: req.user!.id, userName,
          action: 'lead_edited', leadId: req.params.id, leadName: lead.name,
          summary: 'editou o card',
        });
      }

      // Gatilho de automação "tag adicionada" — não existe endpoint atômico
      // de "adicionar 1 tag" (o PUT recebe o array inteiro), então detecta
      // por diff. `tags` é opcional no schema — sem esse guard, um PUT que
      // não mexe em tags compararia com `undefined` e disparava à toa.
      if (req.body.tags !== undefined) {
        const beforeTags = new Set(before?.tags || []);
        const addedTags = (lead.tags || []).filter((t) => !beforeTags.has(t));
        const io = (req as any).app.get('io');
        for (const tag of addedTags) {
          runAutomations({ accountId: req.user!.accountId, trigger: 'TAG_ADDED', leadId: req.params.id, io, context: { addedTag: tag } }).catch(() => {});
        }
      }
    } catch { /* silencioso */ }
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar lead' });
  }
});

router.patch('/:id/stage', validate(stageSchema), async (req: AuthRequest, res: Response) => {
  try {
    // Captura estágio anterior para auditoria + setor do número de WhatsApp
    // (2º sinal pra saber de que setor é o lead quando o funil não tem setor).
    const before = await prisma.lead.findUnique({
      where: { id: req.params.id },
      include: {
        stage: true,
        whatsappNumber: { select: { department: { select: { id: true, name: true } } } },
      },
    });

    const lead = await updateLeadStage(req.params.id, req.user!.accountId, req.body.stageId);
    res.json(lead);

    // ── Auditoria de mudança de estágio ──────────────────────────────────────
    try {
      const newStage = await prisma.stage.findUnique({
        where: { id: req.body.stageId },
        include: { pipeline: { include: { department: { select: { id: true, name: true } } } } },
      });
      const userName = req.user!.id
        ? (await prisma.user.findUnique({ where: { id: req.user!.id }, select: { name: true } }))?.name || 'Usuário'
        : 'Usuário';

      if (before?.stage?.name !== newStage?.name) {
        await auditNote(req.params.id, req.user!.id,
          `Estágio: "${before?.stage?.name || '—'}" → "${newStage?.name || '—'}" — por ${userName}`,
          'STAGE_CHANGE');
        runAutomations({ accountId: req.user!.accountId, trigger: 'STAGE_CHANGE', leadId: req.params.id, io: (req as any).app.get('io'), context: { newStageId: req.body.stageId } }).catch(() => {});
        logActivity({
          accountId: req.user!.accountId, userId: req.user!.id, userName,
          action: 'lead_stage_changed', leadId: req.params.id, leadName: lead.name,
          summary: `moveu de "${before?.stage?.name || '—'}" para "${newStage?.name || '—'}"`,
        });
      }

      // ── Auto-migração ao entrar na etapa "Fechado" ─────────────────────────
      // Financiamento Habitacional: "Fechado" no funil "Vendas" → "Em contratação"
      //   (funil que já existe; não cria).
      // Home Equity: "Fechado" no funil do setor → "Em contratação Home Equity"
      //   (cria com as 7 etapas padrão se ainda não existir).
      // Nos dois casos, avisa o time do setor com um popup (evento
      // "contracting_lead") — o cliente chegou pra contratação.
      if (newStage?.name === 'Fechado') {
        const srcPipe = newStage.pipeline;
        // Setor do lead: 1º o do funil; se o funil não tiver setor, o do número
        // de WhatsApp da conversa. (O funil de vendas do Home Equity se chama
        // "Vendas" também — então NÃO dá pra decidir só pelo nome do funil, tem
        // que olhar o setor primeiro; senão o lead do Home Equity ia parar no
        // "Em contratação" do Financiamento.)
        const deptName = srcPipe.department?.name || before?.whatsappNumber?.department?.name || null;
        const deptId = srcPipe.departmentId || before?.whatsappNumber?.department?.id || null;
        let emContratacao: Awaited<ReturnType<typeof getOrCreateContractingPipeline>> | null = null;
        let recipientDeptId: string | null = null;

        if (deptName === 'Home Equity') {
          emContratacao = await getOrCreateContractingPipeline(req.user!.accountId, 'Em contratação Home Equity', deptId);
          recipientDeptId = deptId;
        } else if (srcPipe.name === 'Vendas' || deptName === 'Financiamento Habitacional') {
          emContratacao = await prisma.pipeline.findFirst({
            where: { accountId: req.user!.accountId, name: 'Em contratação' },
            include: { stages: { orderBy: { order: 'asc' } } },
          });
          recipientDeptId = deptId
            ?? (await prisma.department.findFirst({ where: { accountId: req.user!.accountId, name: 'Financiamento Habitacional' }, select: { id: true } }))?.id
            ?? null;
        }

        const targetStage = emContratacao?.stages.find(s => s.name === 'Documentação Recebida') || emContratacao?.stages[0];
        if (emContratacao && targetStage) {
          const movedLead = await prisma.lead.update({
            where: { id: req.params.id },
            data: {
              pipelineId: emContratacao.id,
              stageId: targetStage.id,
              notes: {
                create: {
                  content: `Lead migrado automaticamente para o funil "${emContratacao.name}" (${targetStage.name}) ao ser fechado em ${srcPipe.name}.`,
                  type: 'STAGE_CHANGE',
                  userId: req.user!.id,
                },
              },
            },
          });
          const io = (req as any).app.get('io');
          if (io) io.to(`account_${req.user!.accountId}`).emit('lead_moved', { lead: movedLead });
          console.log(`[Auto-migração] Lead "${movedLead.name}" movido → ${emContratacao.name} (${targetStage.name})`);

          // Popup pro time do setor: chegou cliente pra contratação. Sem
          // ninguém do setor (setor não resolvido, ou nenhum usuário marcado
          // nele), cai pros ADMIN — o aviso nunca some no vazio.
          if (io) {
            let recipients = recipientDeptId
              ? await prisma.user.findMany({ where: { accountId: req.user!.accountId, departmentIds: { has: recipientDeptId } }, select: { id: true } })
              : [];
            if (recipients.length === 0) {
              recipients = await prisma.user.findMany({ where: { accountId: req.user!.accountId, role: 'ADMIN' }, select: { id: true } });
            }
            for (const u of recipients) {
              io.to(`user_${u.id}`).emit('contracting_lead', {
                leadId: movedLead.id,
                leadName: movedLead.name,
                pipelineName: emContratacao.name,
              });
            }
          }
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
      runAutomations({ accountId: req.user!.accountId, trigger: 'STAGE_CHANGE', leadId: req.params.id, io: (req as any).app.get('io'), context: { newStageId: targetStageId } }).catch(() => {});
      logActivity({
        accountId: req.user!.accountId, userId: req.user!.id, userName,
        action: 'lead_pipeline_changed', leadId: req.params.id, leadName: lead.name,
        summary: `moveu do funil "${before?.pipeline?.name || '—'}" para "${newPipeline?.name || '—'}" (${newStage?.name || '—'})`,
      });
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

// Liga/desliga o assistente de IA respondendo esse cliente SOZINHO no
// WhatsApp (sem revisão humana) — botão na Inbox. Ver ai-auto-reply.service.ts.
router.patch('/:id/ai-auto-reply', async (req: AuthRequest, res: Response) => {
  try {
    const { active } = req.body as { active: boolean };
    const lead = await prisma.lead.update({
      where: { id: req.params.id },
      data: { aiAutoReplyActive: active === true },
      select: { id: true, aiAutoReplyActive: true },
    });
    req.app.get('io')?.to(`lead:${lead.id}`).emit('lead_ai_toggled', { leadId: lead.id, active: lead.aiAutoReplyActive });
    res.json(lead);
  } catch {
    res.status(500).json({ error: 'Erro ao atualizar o assistente de IA' });
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

// POST /api/leads/merge-same-contact — correção pontual do incidente de
// conversas separadas por número: junta de volta os cards do mesmo contato.
router.post('/merge-same-contact', async (req: AuthRequest, res: Response) => {
  try {
    const result = await mergeLeadsBySameContact(req.user!.accountId);
    res.json(result);
  } catch (err) {
    console.error('[Merge automático]', err);
    res.status(500).json({ error: 'Erro ao unificar cards duplicados' });
  }
});

// PATCH /api/leads/:id/custom-fields
router.patch('/:id/custom-fields', async (req: AuthRequest, res: Response) => {
  try {
    const { customFields } = req.body;
    const lead = await updateLead(req.params.id, req.user!.accountId, { customFields } as any);

    // O nome que aparece na conversa/Inbox é o do CONTATO. Como o "Participante 1"
    // é o nome da pessoa, mantemos o contato em sincronia: renomear o Participante 1
    // renomeia o contato (e atualiza a lista de conversas ao vivo).
    const p1 = customFields?.participante_1;
    if (typeof p1 === 'string' && p1.trim() && lead.contactId) {
      await prisma.contact.update({ where: { id: lead.contactId }, data: { name: normalizeClientName(p1) } }).catch(() => {});
      const io = req.app.get('io');
      io?.to(`account_${req.user!.accountId}`).emit('new_conversation', { leadId: lead.id });
    }

    // O "Telefone" do card (telefone_1) é só um campo de exibição — quem
    // manda de verdade pela API Oficial olha Contact.phone, que pode ficar
    // vazio pra sempre num lead que só chegou via @lid (Baileys), ou o lead
    // nem ter um Contact vinculado (mais grave, já aconteceu com lead de
    // fluxo manual/importação). Preenche/cria os dois casos aqui — o campo
    // Telefone do card É onde se cadastra o telefone de verdade, não só
    // exibição. Nunca sobrescreve um Contact.phone real já confirmado.
    const tel1 = customFields?.telefone_1;
    let hasWhatsApp: boolean | null = null;
    if (typeof tel1 === 'string') {
      const digits = tel1.replace(/\D/g, '');
      if (digits.length >= 10) {
        // Mesma normalização do envio (inclui o 9º dígito quando falta) —
        // sem isso, o mesmo número gravado sem o 9 aqui e com o 9 em outro
        // lugar vira contato duplicado pro sistema (já aconteceu).
        const e164 = normalizeBrazilianWhatsAppPhone(digits);
        if (lead.contactId) {
          const contact = await prisma.contact.findUnique({ where: { id: lead.contactId }, select: { phone: true } });
          if (!contact?.phone?.trim()) {
            await prisma.contact.update({ where: { id: lead.contactId }, data: { phone: `+${e164}` } }).catch(() => {});
          }
        } else {
          const contact = await prisma.contact.create({ data: { accountId: lead.accountId, name: normalizeClientName(lead.name), phone: `+${e164}` } });
          await prisma.lead.update({ where: { id: lead.id }, data: { contactId: contact.id } }).catch(() => {});
        }
        hasWhatsApp = await checkHasWhatsApp(req.user!.accountId, e164);
      }
    }

    // "Valor da venda" (aba Principal, é o Lead.value de verdade — aparece
    // no topo do card e alimenta os relatórios) precisa ficar em sincronia
    // com "Valor do crédito" (aba Financiamento, um campo customizado
    // comum). O widget da aba Principal já grava os dois juntos quando
    // editado por ALI — mas editando "Valor do crédito" direto na aba
    // Financiamento (o formulário genérico de campos), só esse PATCH aqui
    // rodava, sem nunca atualizar Lead.value — o card ficava com "0"/vazio
    // mesmo com o crédito preenchido. Sincroniza aqui, na escrita, pra
    // valer não importa qual tela mandou o campo.
    let updatedLead = lead;
    const creditoRaw = customFields?.valor_credito;
    if (creditoRaw !== undefined && creditoRaw !== null && String(creditoRaw).trim() !== '') {
      const creditoNum = Number(creditoRaw);
      if (!Number.isNaN(creditoNum) && creditoNum !== lead.value) {
        updatedLead = await prisma.lead.update({ where: { id: lead.id }, data: { value: creditoNum } });
      }
    }

    res.json({ ...updatedLead, hasWhatsApp });
  } catch (err) {
    console.error('[Leads] Erro ao salvar campos:', err);
    res.status(500).json({ error: 'Erro ao salvar campos' });
  }
});

// PATCH /api/leads/:id/phone — recuperação rápida do erro "sem telefone de
// verdade cadastrado" (contato só tem @lid — API Oficial não consegue
// enviar). Usada pelo botão inline que aparece na Inbox quando um envio
// falha por isso: em vez de mandar o colaborador caçar o campo certo na
// aba Dados, resolve na hora e o envio é retentado em seguida. Diferente
// do PATCH /:id/custom-fields (que só sincroniza se Contact.phone ainda
// estiver vazio), aqui é uma correção explícita do usuário — sempre
// sobrescreve. Lê o customFields atual e faz merge (nunca substitui
// tudo), pra não apagar os outros campos do card.
router.patch('/:id/phone', async (req: AuthRequest, res: Response) => {
  try {
    const { phone } = req.body as { phone?: string };
    const rawDigits = String(phone || '').replace(/\D/g, '');
    if (rawDigits.length < 10) {
      res.status(400).json({ error: 'Telefone inválido — informe DDD + número' });
      return;
    }
    const lead = await prisma.lead.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId } });
    if (!lead) {
      res.status(404).json({ error: 'Lead não encontrado' });
      return;
    }
    // Mesma normalização usada no envio (inclui o 9º dígito quando falta) —
    // sem isso, o mesmo número gravado de formas diferentes vira contato
    // duplicado (já aconteceu).
    const e164 = normalizeBrazilianWhatsAppPhone(rawDigits);
    const telDisplay = formatPhoneDisplay(e164);
    const cf = { ...((lead.customFields as any) || {}), telefone_1: telDisplay };

    let updatedLead;
    if (lead.contactId) {
      [updatedLead] = await prisma.$transaction([
        prisma.lead.update({ where: { id: lead.id }, data: { customFields: cf } }),
        prisma.contact.update({ where: { id: lead.contactId }, data: { phone: `+${e164}` } }),
      ]);
    } else {
      // Lead sem contato vinculado nenhum (mais grave que "sem telefone" —
      // já aconteceu com lead vindo de fluxo manual/importação): cria o
      // Contact na hora em vez de travar pedindo pra arrumar por fora.
      const contact = await prisma.contact.create({ data: { accountId: lead.accountId, name: lead.name, phone: `+${e164}` } });
      updatedLead = await prisma.lead.update({ where: { id: lead.id }, data: { customFields: cf, contactId: contact.id } });
    }

    // Confere se o número tem WhatsApp de verdade (só dá pra saber com algum
    // QR conectado — null = indeterminado, não é erro).
    const hasWhatsApp = await checkHasWhatsApp(req.user!.accountId, e164);
    res.json({ ...updatedLead, hasWhatsApp });
  } catch (err) {
    console.error('[Leads] Erro ao salvar telefone:', err);
    res.status(500).json({ error: 'Erro ao salvar o telefone' });
  }
});

// GET /api/leads/:id/whatsapp-status — checa se o telefone JÁ cadastrado no
// contato tem WhatsApp de verdade (mesma checagem de /phone, sob demanda —
// pro indicador no card sem precisar reenviar o telefone).
router.get('/:id/whatsapp-status', async (req: AuthRequest, res: Response) => {
  try {
    const lead = await prisma.lead.findFirst({ where: { id: req.params.id, accountId: req.user!.accountId }, include: { contact: true } });
    if (!lead) { res.status(404).json({ error: 'Lead não encontrado' }); return; }
    const phone = lead.contact?.phone;
    if (!phone || phone.includes('@')) { res.json({ hasWhatsApp: null }); return; }
    const hasWhatsApp = await checkHasWhatsApp(req.user!.accountId, phone);
    res.json({ hasWhatsApp });
  } catch (err) {
    console.error('[Leads] Erro ao checar WhatsApp:', err);
    res.status(500).json({ error: 'Erro ao checar WhatsApp' });
  }
});

export default router;
