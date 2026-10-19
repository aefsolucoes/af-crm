import { NextFunction, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import type { AuthRequest } from '../middleware/auth';
import { logActivity } from './activity.service';

/**
 * Botão "Reverter" do card (Fabio 19/10: "preciso de um botão pra reverter qualquer alteração que tenha feito nesse card").
 *
 * Cada ação HUMANA no card (rotas de /api/leads: PUT /:id, /stage, /pipeline, /archive, /star, /custom-fields, /ai-auto-reply e o mover em massa)
 * tira uma foto dos campos do card ANTES e, uns segundos depois (pra pegar também o que a rota faz logo após responder — ex.: Perdido que leva o card
 * pro funil "Perdidos"), compara com o DEPOIS. Se algo mudou, grava um LeadChange só com os campos alterados. Reverter devolve esses campos ao "antes":
 * - campos simples (status, etapa, funil, responsável, estrela, valor…) voltam ao valor antigo;
 * - customFields: só as CHAVES que a ação mexeu (o que a IA/automação gravou em outras chaves depois fica);
 * - etiquetas: desfaz só as que a ação adicionou/removeu.
 * Mudanças feitas por IA/automação (fora dessas rotas) não entram — o botão é pra desfazer o que a equipe fez.
 */


const TRACKED = ['name', 'value', 'rejectedAt', 'status', 'lostReason', 'pipelineId', 'stageId', 'userId', 'tags', 'archived', 'starred', 'aiAutoReplyActive', 'customFields', 'contactId', 'companyId', 'stageEnteredAt'] as const;
type Tracked = (typeof TRACKED)[number];
type State = Partial<Record<Tracked, any>>;

const SELECT = Object.fromEntries(TRACKED.map((k) => [k, true])) as Record<Tracked, true>;
const DATE_FIELDS = new Set<Tracked>(['rejectedAt', 'stageEnteredAt']);
const RECORD_DELAY_MS = 3000;
const KEEP_DAYS = 45;
const LIST_DAYS = 30;

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/** Valor do campo em forma comparável/gravável em JSON (datas viram ISO). */
function plain(v: any): any {
  if (v instanceof Date) return v.toISOString();
  return v === undefined ? null : v;
}

async function snapshots(accountId: string, ids: string[]): Promise<Map<string, State>> {
  const rows = await prisma.lead.findMany({ where: { id: { in: ids }, accountId }, select: { id: true, ...SELECT } as any });
  const out = new Map<string, State>();
  for (const r of rows as any[]) {
    const st: State = {};
    for (const k of TRACKED) st[k] = plain(r[k]);
    out.set(r.id, st);
  }
  return out;
}

const same = (a: any, b: any) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Quais ids de card a requisição vai mexer (vazio = não rastrear). */
function leadIdsOf(req: AuthRequest): string[] {
  const m = /^\/([^/]+)(?:\/(stage|pipeline|archive|star|custom-fields|ai-auto-reply))?\/?$/.exec(req.path);
  if (req.method === 'POST' && req.path === '/bulk-move') {
    const ids = (req.body as any)?.leadIds;
    return Array.isArray(ids) ? ids.filter((v: unknown): v is string => typeof v === 'string' && v.length > 0).slice(0, 300) : [];
  }
  if (!m) return [];
  const [, id, suffix] = m;
  if (['bulk-move', 'merge-same-contact', 'duplicate-groups', 'find-by-phone'].includes(id)) return [];
  if (!suffix) return req.method === 'PUT' ? [id] : [];
  return req.method === 'PATCH' ? [id] : [];
}

/** Express middleware: monta antes das rotas de escrita de /api/leads. Nunca atrapalha a requisição. */
export function trackLeadChanges(req: AuthRequest, res: Response, next: NextFunction) {
  (async () => {
    try {
      if (!req.user) return;
      const ids = leadIdsOf(req);
      if (!ids.length) return;
      const accountId = req.user.accountId;
      const before = await snapshots(accountId, ids);
      if (!before.size) return;
      const touchesCustom = req.path.endsWith('/custom-fields') || (req.method === 'PUT' && (req.body as any)?.customFields !== undefined);
      const user = { id: req.user.id, name: '' };
      res.on('finish', () => {
        if (res.statusCode >= 400) return;
        setTimeout(() => {
          recordChanges(accountId, user, before, touchesCustom).catch((e) => console.error('[LeadChange] falhou ao registrar:', e?.message));
        }, RECORD_DELAY_MS);
      });
    } catch (e: any) {
      console.error('[LeadChange] falhou ao capturar o antes:', e?.message);
    }
  })().finally(() => next());
}

async function recordChanges(accountId: string, user: { id: string; name: string }, before: Map<string, State>, touchesCustom: boolean) {
  const after = await snapshots(accountId, [...before.keys()]);
  const diffs: Array<{ leadId: string; changed: Tracked[]; b: State; a: State }> = [];
  for (const [leadId, b] of before) {
    const a = after.get(leadId);
    if (!a) continue;
    const changed = TRACKED.filter((k) => !same(b[k], a[k]) && (k !== 'customFields' || touchesCustom));
    // stageEnteredAt muda sozinho junto com a etapa (trigger) — não é uma alteração à parte.
    const real = changed.filter((k) => k !== 'stageEnteredAt' || changed.length === 1);
    if (!real.length) continue;
    diffs.push({ leadId, changed: changed as Tracked[], b, a });
  }
  if (!diffs.length) return;

  const names = await lookupNames(accountId, diffs);
  const userName = user.id ? (await prisma.user.findUnique({ where: { id: user.id }, select: { name: true } }))?.name || 'Usuário' : 'Usuário';
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400_000);
  for (const d of diffs) {
    const pick = (st: State) => Object.fromEntries(d.changed.map((k) => [k, st[k] ?? null]));
    await prisma.leadChange.create({
      data: { accountId, leadId: d.leadId, userId: user.id || null, userName, label: describe(d.changed, d.b, d.a, names), before: pick(d.b) as any, after: pick(d.a) as any, changed: d.changed },
    });
    await prisma.leadChange.deleteMany({ where: { leadId: d.leadId, createdAt: { lt: cutoff } } }).catch(() => {});
  }
}

type Names = { pipelines: Map<string, string>; stages: Map<string, string>; users: Map<string, string> };

async function lookupNames(accountId: string, diffs: Array<{ b: State; a: State }>): Promise<Names> {
  const pids = new Set<string>(), sids = new Set<string>(), uids = new Set<string>();
  for (const d of diffs) for (const st of [d.b, d.a]) { if (st.pipelineId) pids.add(st.pipelineId); if (st.stageId) sids.add(st.stageId); if (st.userId) uids.add(st.userId); }
  const [pipes, stages, users] = await Promise.all([
    prisma.pipeline.findMany({ where: { id: { in: [...pids] }, accountId }, select: { id: true, name: true } }),
    prisma.stage.findMany({ where: { id: { in: [...sids] } }, select: { id: true, name: true } }),
    prisma.user.findMany({ where: { id: { in: [...uids] }, accountId }, select: { id: true, name: true } }),
  ]);
  return { pipelines: new Map(pipes.map((p) => [p.id, p.name])), stages: new Map(stages.map((s) => [s.id, s.name])), users: new Map(users.map((u) => [u.id, u.name])) };
}

function describe(changed: Tracked[], b: State, a: State, n: Names): string {
  const has = (k: Tracked) => changed.includes(k);
  const parts: string[] = [];
  const place = (st: State) => `${n.pipelines.get(st.pipelineId) || '?'} → ${n.stages.get(st.stageId) || '?'}`;
  if (has('status')) {
    if (a.status === 'LOST') parts.push(has('rejectedAt') && a.rejectedAt ? 'marcou como Reprovado' : 'marcou como Perdido');
    else if (a.status === 'WON') parts.push('marcou como Ganho');
    else parts.push('reabriu o card');
  }
  if (has('pipelineId') || has('stageId')) {
    parts.push(has('pipelineId') ? `moveu de ${place(b)} para ${place(a)}` : `moveu da etapa ${n.stages.get(b.stageId) || '?'} para ${n.stages.get(a.stageId) || '?'}`);
  }
  if (has('userId')) parts.push(`mudou o responsável de ${n.users.get(b.userId) || '—'} para ${n.users.get(a.userId) || '—'}`);
  if (has('archived')) parts.push(a.archived ? 'arquivou o card' : 'restaurou o card');
  if (has('starred') && !has('status')) parts.push(a.starred ? 'marcou a estrela' : 'tirou a estrela');
  if (has('aiAutoReplyActive')) parts.push(a.aiAutoReplyActive ? 'ligou a IA' : 'desligou a IA');
  if (has('value')) parts.push('mudou o valor da venda');
  if (has('name')) parts.push('mudou o nome');
  if (has('tags')) parts.push('mudou as etiquetas');
  if (has('customFields')) {
    const keys = changedKeys(b.customFields, a.customFields);
    parts.push(keys.length && keys.length <= 3 ? `editou ${keys.join(', ')}` : 'editou campos do card');
  }
  if (has('contactId') || has('companyId')) parts.push('mudou o contato/empresa');
  if (!parts.length) parts.push('alterou o card');
  return parts.slice(0, 3).join(' · ');
}

function changedKeys(b: any, a: any): string[] {
  const bo = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
  const ao = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(bo), ...Object.keys(ao)])].filter((k) => !same(bo[k], ao[k]));
}

// ─── Leitura ────────────────────────────────────────────────────────────────

export async function listLeadChanges(accountId: string, leadId: string) {
  const since = new Date(Date.now() - LIST_DAYS * 86400_000);
  return prisma.leadChange.findMany({
    where: { accountId, leadId, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, label: true, userName: true, createdAt: true, revertedAt: true, revertedByName: true },
  });
}

// ─── Reverter ───────────────────────────────────────────────────────────────

/** Desfaz a alteração `changeId` E as mais novas ainda não desfeitas (volta ao card como estava antes dela). */
export async function revertLeadChange(params: { accountId: string; leadId: string; changeId: string; userId: string; io?: Io }) {
  const { accountId, leadId, changeId, userId, io } = params;
  const target = await prisma.leadChange.findFirst({ where: { id: changeId, leadId, accountId } });
  if (!target) throw new Error('Alteração não encontrada.');
  if (target.revertedAt) throw new Error('Essa alteração já foi desfeita.');
  const stack = await prisma.leadChange.findMany({ where: { leadId, accountId, revertedAt: null, createdAt: { gte: target.createdAt } }, orderBy: { createdAt: 'desc' } });

  const current = (await snapshots(accountId, [leadId])).get(leadId);
  if (!current) throw new Error('Card não encontrado.');
  const work: State = JSON.parse(JSON.stringify(current));

  for (const ch of stack) {
    const b = (ch.before || {}) as State, a = (ch.after || {}) as State;
    for (const f of ch.changed as Tracked[]) {
      if (f === 'customFields') {
        const cur = { ...((work.customFields && typeof work.customFields === 'object' ? work.customFields : {}) as Record<string, unknown>) };
        const bo = (b.customFields && typeof b.customFields === 'object' ? b.customFields : {}) as Record<string, unknown>;
        for (const k of changedKeys(b.customFields, a.customFields)) { if (k in bo) cur[k] = bo[k]; else delete cur[k]; }
        work.customFields = cur;
      } else if (f === 'tags') {
        const bt = new Set<string>(b.tags || []), at = new Set<string>(a.tags || []);
        const added = [...at].filter((t) => !bt.has(t)), removed = [...bt].filter((t) => !at.has(t));
        const next = ((work.tags || []) as string[]).filter((t) => !added.includes(t));
        for (const t of removed) if (!next.includes(t)) next.push(t);
        work.tags = next;
      } else {
        work[f] = b[f] ?? null;
      }
    }
  }

  // Confere que o lugar anterior ainda existe antes de mexer em qualquer coisa.
  if (!same(work.pipelineId, current.pipelineId) || !same(work.stageId, current.stageId)) {
    const stage = await prisma.stage.findFirst({ where: { id: work.stageId, pipelineId: work.pipelineId, pipeline: { accountId } }, select: { id: true } });
    if (!stage) throw new Error('A etapa/funil anterior não existe mais — não deu pra reverter essa alteração.');
  }
  if (!same(work.userId, current.userId) && work.userId) {
    if (!(await prisma.user.findFirst({ where: { id: work.userId, accountId }, select: { id: true } }))) throw new Error('O responsável anterior não existe mais — não deu pra reverter.');
  }

  const revertedFields = TRACKED.filter((k) => !same(work[k], current[k]));
  const data: Record<string, any> = {};
  for (const k of revertedFields) {
    if (k === 'value' || k === 'stageEnteredAt') continue; // segundo passo (os gatilhos do banco mexem nesses dois)
    data[k] = DATE_FIELDS.has(k) ? (work[k] ? new Date(work[k]) : null) : work[k];
    if (k === 'customFields' && data[k] === null) data[k] = undefined;
  }
  const userName = (await prisma.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name || 'Usuário';

  if (Object.keys(data).length) await prisma.lead.update({ where: { id: leadId }, data: data as any });
  // Os gatilhos do banco recalculam "valor da venda" (quando o crédito muda) e "entrou na etapa" (quando a etapa muda): reaplica o que o card tinha.
  const fix: Record<string, any> = {};
  if ('value' in work && !same(work.value, current.value)) fix.value = work.value;
  if (stack.some((c) => (c.changed as string[]).includes('stageId')) && work.stageEnteredAt) fix.stageEnteredAt = new Date(work.stageEnteredAt);
  if (Object.keys(fix).length) await prisma.lead.update({ where: { id: leadId }, data: fix as any });

  await prisma.leadChange.updateMany({ where: { id: { in: stack.map((s) => s.id) } }, data: { revertedAt: new Date(), revertedByName: userName } });

  // Ganho gera sugestão de comissão: se foi esta alteração, a sugestão ainda pendente sai junto.
  if (stack.some((c) => ((c.before as any)?.status !== 'WON') && ((c.after as any)?.status === 'WON'))) {
    await prisma.commissionSuggestion.deleteMany({ where: { leadId, accountId, status: 'PENDING', createdAt: { gte: target.createdAt } } }).catch(() => {});
  }

  const labels = [...stack].reverse().map((s) => s.label).join(' | ');
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, include: { stage: { select: { name: true } }, pipeline: { select: { name: true, departmentId: true } } } });
  const onde = lead ? `${lead.pipeline?.name || '?'} → ${lead.stage?.name || '?'}` : '?';
  await prisma.note.create({ data: { leadId, userId, type: 'DATA_EDIT', content: `↩️ Alteração desfeita por ${userName}: ${labels}. Card voltou para "${onde}" (${lead?.status === 'LOST' ? 'Perdido' : lead?.status === 'WON' ? 'Ganho' : 'Aberto'}).` } }).catch(() => {});
  logActivity({ accountId, userId, userName, action: 'lead_reverted', leadId, leadName: lead?.name, summary: `desfez: ${labels}` });

  if (lead) {
    io?.to(`account_${accountId}`).emit('lead_moved', { lead });
    if (revertedFields.includes('starred')) io?.to(`account_${accountId}`).emit('lead_starred', { leadId, starred: !!lead.starred });
  }
  return { revertedFields, labels, count: stack.length, lead };
}
