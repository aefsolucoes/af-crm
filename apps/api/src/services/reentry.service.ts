import crypto from 'crypto';
import { prisma } from '../lib/prisma';

/**
 * Cliente REPROVADO há pouco que volta a preencher a proposta (Fabio 19/10, caso Marcos/Édson Arlindo Luiz: reprovado em 12/10, voltou em 19/10 com a proposta de novo e o CRM tratou como
 * cliente novo — confirmou "recebi sua proposta", a IA pediu escritura, e a unificação automática enterrou tudo no card Perdido).
 * Regra dele: "a IA do CRM precisa verificar isso ANTES de dar andamento" e "se aumentou o valor do crédito não adianta: se não aprovou o menor, imagina o maior".
 *
 * `reentryGate` é chamado (1) quando a proposta ia mover o card pra Pré-Análise (campaign-detection.advanceLeadOnProposalForm) e (2) antes de a análise automática começar (credit-auto.startNewLeads).
 * Acha a reprovação recente (mesmo CPF, e-mail ou telefone), compara a proposta de antes com a nova (a IA lê as duas) e decide ANDAMENTO ou SEGURAR. SEGURAR = não move, não confirma, não
 * roda os bancos: deixa nota + push pra equipe decidir e a IA da conversa recebe um bloco de contexto (`aiReentryContext`) pra não prometer análise.
 */

const WINDOW_DAYS = 30;
const PROPOSAL_MARKERS = ['Proposta preenchida no site', 'PROPOSTA RECEBIDA', 'Preenchi a proposta', 'Proposta manual'];
type Cf = Record<string, any>;

const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '');
const dia = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });

function identityOf(l: { customFields: unknown; contact?: { email?: string | null; phone?: string | null; whatsappPhone?: string | null } | null }) {
  const cf = (l.customFields || {}) as Cf;
  const cpfs = new Set([cf.cpf_1, cf.cpf_2].map(digits).filter((d) => d.length === 11));
  const emails = new Set([cf.email_1, l.contact?.email].map((e) => String(e || '').trim().toLowerCase()).filter((e) => /^\S+@\S+\.\S+$/.test(e)));
  const phones = new Set([l.contact?.whatsappPhone, l.contact?.phone, cf.telefone_1, cf.telefone_2, cf.telefone_alt].map((p) => digits(p)).filter((d) => d.length >= 8).map((d) => d.slice(-8)));
  return { cpfs, emails, phones };
}
const intersects = (a: Set<string>, b: Set<string>) => [...a].some((x) => b.has(x));
const REJECT_RX = /reprov|negad|recusad|n[aã]o aprov/i;

export interface PriorRejection { leadId: string; name: string; at: Date; reason: string; self: boolean }

/** Reprovação recente (últimos 30 dias) da MESMA pessoa: outro card ou o próprio card, se está Perdido por reprovação. */
export async function findRecentRejection(accountId: string, leadId: string): Promise<PriorRejection | null> {
  const me = await prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, name: true, status: true, lostReason: true, rejectedAt: true, stageEnteredAt: true, updatedAt: true, customFields: true, pipeline: { select: { name: true } }, contact: { select: { email: true, phone: true, whatsappPhone: true } } } });
  if (!me) return null;
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000);
  const quando = (l: { rejectedAt: Date | null; stageEnteredAt: Date | null; updatedAt: Date; pipeline?: { name: string } | null }) =>
    l.rejectedAt || (/perdid/i.test(l.pipeline?.name || '') && l.stageEnteredAt ? l.stageEnteredAt : l.updatedAt);
  // o próprio card Perdido por reprovação (cliente que preenche a proposta de novo no MESMO card)
  if (me.status === 'LOST' && (me.rejectedAt || REJECT_RX.test(me.lostReason || ''))) {
    const at = quando(me as any);
    if (at >= cutoff) return { leadId: me.id, name: me.name, at, reason: me.lostReason || 'REPROVADO', self: true };
  }
  const mine = identityOf(me);
  if (!mine.cpfs.size && !mine.emails.size && !mine.phones.size) return null;
  const outros = await prisma.lead.findMany({
    where: { accountId, id: { not: leadId }, isGroup: false, OR: [{ rejectedAt: { gte: cutoff } }, { status: 'LOST', lostReason: { contains: 'reprov', mode: 'insensitive' }, updatedAt: { gte: cutoff } }] },
    select: { id: true, name: true, lostReason: true, rejectedAt: true, stageEnteredAt: true, updatedAt: true, customFields: true, pipeline: { select: { name: true } }, contact: { select: { email: true, phone: true, whatsappPhone: true } } },
  });
  let best: PriorRejection | null = null;
  for (const o of outros) {
    const id = identityOf(o);
    if (!(intersects(mine.cpfs, id.cpfs) || intersects(mine.emails, id.emails) || intersects(mine.phones, id.phones))) continue;
    const at = quando(o as any);
    if (!best || at > best.at) best = { leadId: o.id, name: o.name, at, reason: o.lostReason || 'REPROVADO', self: false };
  }
  return best;
}

async function proposalTextBefore(leadId: string, before: Date | null): Promise<string> {
  const m = await prisma.message.findFirst({
    where: { leadId, direction: 'INBOUND', OR: PROPOSAL_MARKERS.map((x) => ({ content: { contains: x } })), ...(before ? { createdAt: { lte: before } } : {}) },
    orderBy: { createdAt: 'desc' }, select: { content: true },
  });
  return m?.content || '';
}
async function latestProposalText(leadId: string, after: Date | null): Promise<string> {
  const m = await prisma.message.findFirst({
    where: { leadId, direction: 'INBOUND', OR: PROPOSAL_MARKERS.map((x) => ({ content: { contains: x } })), ...(after ? { createdAt: { gt: after } } : {}) },
    orderBy: { createdAt: 'desc' }, select: { content: true },
  });
  return m?.content || '';
}

export interface ReentryVerdict { verdict: 'ANDAMENTO' | 'SEGURAR'; motivo: string; mudancas: string[] }

const RULES = `REGRA DO FABIO (dono do correspondente bancário): este cliente foi REPROVADO há pouco (últimos 30 dias) e voltou a preencher a proposta. Só vale dar andamento (analisar de novo nos bancos) se a proposta nova mudou algo que possa ALTERAR O RESULTADO.
- AUMENTAR o valor do crédito NÃO adianta: se o banco não aprovou o valor menor, não aprova o maior.
- NÃO adianta: mesma proposta de novo, mesmos dados, só mudar prazo, telefone, e-mail, corrigir data de nascimento, número/complemento do endereço do MESMO imóvel, ou renda só um pouco maior.
- Pode adiantar: crédito MENOR que o da proposta reprovada; OUTRO imóvel (outro endereço/CEP/cidade/tipo); valor do imóvel que agora passe a atender o MÍNIMO dos bancos (Creditas R$ 150 mil; Inter R$ 200 mil — o CRM sobe imóvel de R$ 180 mil a R$ 199.999 pro mínimo; crédito costuma ir até 58–60% do valor do imóvel) quando antes não atendia; SEGUNDO participante com CPF/renda novos; imóvel que tinha financiamento/dívida e foi quitado/regularizado; motivo da reprovação conhecido que foi corrigido.
- Na dúvida: SEGURAR (a equipe decide).`;

/** A IA lê a proposta antiga e a nova e decide. Sem chave/resposta: regra simples (SEGURAR). */
export async function decideReentry(p: { priorAt: Date; reason: string; priorText: string; newText: string; priorCard?: string; analyses?: string[] }): Promise<ReentryVerdict> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const fallback: ReentryVerdict = { verdict: 'SEGURAR', motivo: 'não consegui comparar as propostas automaticamente — a equipe decide', mudancas: [] };
  if (!apiKey) return fallback;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-5', max_tokens: 3000,
      system: `Você é a IA de um correspondente bancário (crédito com garantia de imóvel). ${RULES}\nCompare a PROPOSTA ANTERIOR (reprovada) com a PROPOSTA NOVA, campo a campo (valor do imóvel, crédito, prazo, renda, participantes/CPF, endereço/CEP/cidade do imóvel, quitação). Responda SÓ JSON: {"verdict":"ANDAMENTO|SEGURAR","motivo":"1 frase direta dizendo por quê","mudancas":["o que mudou, curto, ex.: imóvel R$ 100 mil → R$ 120 mil"]}. Liste em "mudancas" só o que MUDOU de verdade.`,
      messages: [{ role: 'user', content: `Reprovado em ${dia(p.priorAt)} (motivo registrado: ${p.reason}).${p.analyses?.length ? `\nResultados dos bancos na época: ${p.analyses.join(' | ')}` : ''}\n\nPROPOSTA ANTERIOR:\n${p.priorText.slice(0, 3000) || `(texto não encontrado) Dados do card: ${p.priorCard || '—'}`}\n\nPROPOSTA NOVA:\n${p.newText.slice(0, 3000)}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return fallback;
  const d: any = await res.json().catch(() => null);
  const raw = (d?.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return fallback;
  try {
    const j = JSON.parse(m[0]);
    return { verdict: j.verdict === 'ANDAMENTO' ? 'ANDAMENTO' : 'SEGURAR', motivo: String(j.motivo || '').slice(0, 300), mudancas: (Array.isArray(j.mudancas) ? j.mudancas : []).map((x: any) => String(x).slice(0, 120)).slice(0, 8) };
  } catch { return fallback; }
}

export interface ReentryResult { hold: boolean; verdict?: ReentryVerdict; prior?: PriorRejection }

/** Confere ANTES de dar andamento. `text` = texto da proposta que acabou de chegar (se já tiver). Idempotente por proposta (cf._reentryCheck). */
export async function reentryGate(accountId: string, leadId: string, opts: { text?: string } = {}): Promise<ReentryResult> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true, stageEnteredAt: true } });
  if (!lead) return { hold: false };
  const cf = { ...((lead.customFields || {}) as Cf) };
  const prior = await findRecentRejection(accountId, leadId);
  if (!prior) return { hold: false };

  // A proposta que estamos avaliando: o texto que chegou agora ou a mais recente depois da reprovação.
  const newText = (opts.text && opts.text.length > 250 && /cpf\s*:/i.test(opts.text) ? opts.text : '') || await latestProposalText(leadId, prior.self ? prior.at : null);
  if (!newText) return { hold: false, prior };
  const key = crypto.createHash('sha1').update(newText.slice(0, 1500)).digest('hex').slice(0, 12);
  const prev = cf._reentryCheck as { key?: string; at?: string; hold?: boolean; verdict?: ReentryVerdict } | undefined;
  if (prev?.key === key) {
    // Decisão humana vale: se a equipe moveu o card DEPOIS da verificação, libera.
    const liberado = prev.hold && lead.stageEnteredAt && prev.at && lead.stageEnteredAt > new Date(prev.at);
    return { hold: !!prev.hold && !liberado, verdict: prev.verdict, prior };
  }

  const priorText = await proposalTextBefore(prior.leadId, prior.self ? prior.at : new Date());
  const rows = await prisma.creditAnalysis.findMany({ where: { leadId: prior.leadId, dryRun: false, status: { in: ['REJECTED', 'FAILED', 'APPROVED'] } }, orderBy: { createdAt: 'desc' }, take: 6, select: { bank: true, status: true, detail: true } });
  const analyses = rows.map((r) => `${r.bank}: ${r.status}${r.detail ? ` — ${String(r.detail).replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
  const prCard = prior.self ? '' : '';
  const verdict = await decideReentry({ priorAt: prior.at, reason: prior.reason, priorText, newText, priorCard: prCard, analyses });
  const hold = verdict.verdict === 'SEGURAR';

  cf._reentryCheck = { key, at: new Date().toISOString(), hold, verdict, priorLeadId: prior.leadId, priorAt: prior.at.toISOString() };
  if (hold) cf._reentryHold = { at: new Date().toISOString(), priorAt: prior.at.toISOString(), motivo: verdict.motivo, mudancas: verdict.mudancas };
  else delete cf._reentryHold;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: cf as any } });

  const mud = verdict.mudancas.length ? verdict.mudancas.join('; ') : 'nada relevante';
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: hold
    ? `⏸️ Cliente REPROVADO em ${dia(prior.at)} voltou a preencher a proposta. O que mudou: ${mud}. NÃO dei andamento (sem Pré-Análise, sem confirmação ao cliente e sem rodar os bancos): ${verdict.motivo} Se quiser seguir mesmo assim, mova o card pra Pré-Análise.`
    : `↩️ Cliente reprovado em ${dia(prior.at)} voltou com proposta nova. O que mudou: ${mud}. Dei andamento: ${verdict.motivo}` } }).catch(() => {});
  if (hold) {
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: '⏸️ Cliente reprovado voltou', body: `${lead.name}: proposta nova sem mudança relevante — não dei andamento`, leadId }).catch(() => {});
  }
  console.log(`[Reentrada] ${lead.name}: reprovado em ${dia(prior.at)} → ${verdict.verdict} (${verdict.motivo})`);
  return { hold, verdict, prior };
}

/** Bloco pra IA da conversa: cliente reprovado voltou e a análise foi retida — não prometer nada. Vazio se não há retenção ativa. */
export async function aiReentryContext(leadId: string): Promise<string> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, stageEnteredAt: true } });
  const h = ((l?.customFields || {}) as Cf)._reentryHold as { at?: string; priorAt?: string; motivo?: string; mudancas?: string[] } | undefined;
  if (!h?.at) return '';
  if (l?.stageEnteredAt && l.stageEnteredAt > new Date(h.at)) return ''; // a equipe moveu o card depois: decisão humana
  return `CLIENTE REPROVADO QUE VOLTOU (Fabio 19/10): este cliente foi REPROVADO em ${h.priorAt ? dia(new Date(h.priorAt)) : 'poucos dias atrás'} e preencheu a proposta de novo; o CRM conferiu e NÃO deu andamento${h.motivo ? ` (${h.motivo})` : ''}${h.mudancas?.length ? `. O que mudou: ${h.mudancas.join('; ')}` : ''}. NÃO prometa pré-análise, NÃO diga "recebi sua proposta, vou analisar", NÃO peça documentos nem escritura. Explique com educação que a análise recente não foi aprovada e que a equipe vai olhar esta nova proposta e retorna; se ele contar algo que mudou de verdade (crédito menor, outro imóvel, mais um participante com renda), registre e passe pra equipe (handoff). Não ofereça "outras possibilidades".`;
}
