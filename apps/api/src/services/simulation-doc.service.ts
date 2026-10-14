import { PrismaClient } from '@prisma/client';
import { sendOutboundMedia } from './message.service';
import { brandPortalPdf } from './simulation-pdf.service';

type Db = PrismaClient;
type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } };

/**
 * PDF "Evolução das parcelas" da simulação, do portal Credimorar até o WhatsApp do cliente, SEMPRE com a logo A&F:
 *   CRM cria o pedido → extensão do Credimorar baixa o PDF original do portal e devolve → CRM põe a logo
 *   (simulation-pdf.service.ts) e manda como documento (sendOutboundMedia, grátis dentro da janela de 24h).
 * Nunca vai o PDF cru do portal: se não for o modelo conhecido, o pedido falha com o motivo.
 */

// Ids das instituições no portal Credimorar (filtro "Bancos" da lista).
export const SIM_INSTITUTIONS: Record<string, { id: number; label: string }> = {
  SANTANDER: { id: 2, label: 'Santander' },
  INTER: { id: 6, label: 'Inter' },
};

const REQUESTED_TTL_MIN = 15; // ninguém pegou o pedido (extensão fechada/desatualizada)
const RUNNING_TTL_MIN = 10; // pegou e não devolveu (aba fechou, SW reiniciou)

async function expireStuck(db: Db, accountId: string) {
  const now = Date.now();
  const expire = async (where: Record<string, unknown>, detail: string) => {
    const rows = await db.simulationDocRequest.findMany({ where: { accountId, ...where } as any });
    for (const r of rows) {
      const done = await db.simulationDocRequest.updateMany({ where: { id: r.id, status: r.status }, data: { status: 'FAILED', finishedAt: new Date(), detail } });
      if (done.count) await noteFailure(db, { ...r, detail });
    }
  };
  await expire({ status: 'REQUESTED', createdAt: { lt: new Date(now - REQUESTED_TTL_MIN * 60_000) } }, 'Nenhuma extensão do Credimorar pegou o pedido (extensão fechada, desligada ou desatualizada).');
  await expire({ status: 'RUNNING', startedAt: { lt: new Date(now - RUNNING_TTL_MIN * 60_000) } }, 'A extensão pegou o pedido mas não devolveu o PDF (janela fechada ou extensão reiniciada).');
}

export function parseInstitutions(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const v of list) {
    const k = String(v || '').toUpperCase();
    const key = k === 'CREDIMORAR' ? 'SANTANDER' : k; // a extensão do Credimorar é a do Santander
    if (SIM_INSTITUTIONS[key] && !out.includes(key)) out.push(key);
  }
  return out;
}

export async function requestSimulationDocs(db: Db, p: { accountId: string; leadId: string; institutions: string[]; userId?: string; source?: 'USER' | 'AI'; caption?: string }) {
  const lead = await db.lead.findFirst({ where: { id: p.leadId, accountId: p.accountId }, select: { id: true } });
  if (!lead) throw new Error('Card não encontrado');
  await expireStuck(db, p.accountId);
  const created: Array<{ id: string; institution: string }> = [];
  const skipped: string[] = [];
  for (const inst of parseInstitutions(p.institutions)) {
    const open = await db.simulationDocRequest.findFirst({ where: { leadId: p.leadId, institution: inst, status: { in: ['REQUESTED', 'RUNNING'] } }, select: { id: true } });
    if (open) { skipped.push(inst); continue; }
    const row = await db.simulationDocRequest.create({ data: { accountId: p.accountId, leadId: p.leadId, institution: inst, source: p.source || 'USER', requestedById: p.userId || null, caption: p.caption?.trim() || null } });
    created.push({ id: row.id, institution: inst });
  }
  return { created, skipped };
}

/** A extensão pergunta "tem PDF pra baixar?". Cada pedido é entregue UMA vez (REQUESTED → RUNNING). */
export async function claimSimulationDocs(db: Db, p: { accountId: string; limit?: number }) {
  await expireStuck(db, p.accountId);
  const rows = await db.simulationDocRequest.findMany({ where: { accountId: p.accountId, status: 'REQUESTED' }, orderBy: { createdAt: 'asc' }, take: Math.min(p.limit || 2, 5) });
  const out: Array<{ id: string; leadId: string; leadName: string; institution: string; institutionId: number }> = [];
  for (const r of rows) {
    const claimed = await db.simulationDocRequest.updateMany({ where: { id: r.id, status: 'REQUESTED' }, data: { status: 'RUNNING', startedAt: new Date() } });
    if (!claimed.count) continue;
    const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
    out.push({ id: r.id, leadId: r.leadId, leadName: lead?.name || 'Sem nome', institution: r.institution, institutionId: SIM_INSTITUTIONS[r.institution]?.id ?? 0 });
  }
  return out;
}

export async function failSimulationDoc(db: Db, p: { accountId: string; id: string; reason: string }) {
  const r = await db.simulationDocRequest.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!r || r.status === 'DONE' || r.status === 'FAILED') return r;
  const updated = await db.simulationDocRequest.update({ where: { id: r.id }, data: { status: 'FAILED', finishedAt: new Date(), detail: p.reason.slice(0, 600) } });
  await noteFailure(db, updated);
  return updated;
}

/** Pedido que falhou deixa nota no card (a IA já avisou o cliente que o PDF ia sair: a equipe precisa saber que não saiu). */
async function noteFailure(db: Db, r: { leadId: string; institution: string; source: string; detail: string | null }) {
  if (r.source !== 'AI') return; // pedido de pessoa: ela vê o motivo na própria tela
  const label = SIM_INSTITUTIONS[r.institution]?.label || r.institution;
  await db.note.create({ data: { leadId: r.leadId, type: 'COMMENT', content: `⚠️ O PDF da simulação do ${label} pedido pela IA NÃO saiu: ${r.detail || 'sem detalhe'}. Mande à mão pela Inbox (anexando o PDF do portal — a logo A&F entra sozinha).` } }).catch(() => {});
}

function slug(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** A extensão devolveu o PDF original do portal: põe a logo A&F e manda pro cliente. */
export async function finishSimulationDoc(db: Db, p: { accountId: string; id: string; pdf: Buffer; io?: Io }) {
  const r = await db.simulationDocRequest.findFirst({ where: { id: p.id, accountId: p.accountId } });
  if (!r) throw new Error('Pedido não encontrado');
  if (r.status === 'DONE') return { ok: true as const, already: true, messageId: r.messageId };
  const label = SIM_INSTITUTIONS[r.institution]?.label || r.institution;
  const fail = async (reason: string) => { await failSimulationDoc(db, { accountId: p.accountId, id: r.id, reason }); return { ok: false as const, error: reason }; };

  let branded;
  try { branded = await brandPortalPdf(p.pdf); } catch (e: any) { return fail(`Não consegui pôr a logo A&F no PDF (${e?.message || 'erro'}). Não enviei.`); }
  if (!branded.recognized) return fail('O PDF baixado não está no modelo conhecido do portal (ou já veio sem a logo do portal). Não enviei, pra não sair com a marca errada — avise o suporte.');

  const lead = await db.lead.findUnique({ where: { id: r.leadId }, select: { name: true } });
  const nome = slug(lead?.name || 'Cliente');
  const fileName = `AeF_${r.institution}_${nome || 'Cliente'}.pdf`;
  const caption = r.caption || `Segue a simulação do ${label} em PDF 📄`;
  const sent = await sendOutboundMedia({ accountId: p.accountId, leadId: r.leadId, buffer: branded.pdf, fileName, mimeType: 'application/pdf', caption, userId: r.requestedById || undefined, io: p.io });
  if (!sent.success) return fail(`Baixei e marquei o PDF, mas o WhatsApp não aceitou o envio: ${sent.error}`);
  await db.simulationDocRequest.update({ where: { id: r.id }, data: { status: 'DONE', finishedAt: new Date(), messageId: sent.message?.id || null, detail: `Enviado: ${fileName}` } });
  return { ok: true as const, messageId: sent.message?.id as string | undefined };
}

export async function listSimulationDocs(db: Db, p: { accountId: string; leadId: string }) {
  await expireStuck(db, p.accountId);
  return db.simulationDocRequest.findMany({ where: { accountId: p.accountId, leadId: p.leadId }, orderBy: { createdAt: 'desc' }, take: 10 });
}
