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
// Inclui DESQUALIFICADO (idade/regra do banco, caso José Roberto 20/10): voltar com a mesma proposta também não adianta.
const REJECT_RX = /reprov|negad|recusad|n[aã]o aprov|desqualific/i;

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
    where: { accountId, id: { not: leadId }, isGroup: false, OR: [{ rejectedAt: { gte: cutoff } }, { status: 'LOST', OR: [{ lostReason: { contains: 'reprov', mode: 'insensitive' } }, { lostReason: { contains: 'desqualific', mode: 'insensitive' } }], updatedAt: { gte: cutoff } }] },
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
- Pode adiantar: crédito MENOR que o da proposta reprovada — MAS NÃO quando o motivo foi o IMÓVEL (valor abaixo do mínimo dos bancos, terreno, cessão, irregular): aí crédito menor no mesmo imóvel NÃO adianta (Fabio 03/11); OUTRO imóvel (outro endereço/CEP/cidade/tipo); valor do imóvel que agora passe a atender o MÍNIMO dos bancos (Creditas R$ 150 mil; Inter R$ 200 mil — o CRM sobe imóvel de R$ 180 mil a R$ 199.999 pro mínimo; crédito costuma ir até 58–60% do valor do imóvel) quando antes não atendia; SEGUNDO participante com CPF/renda novos; imóvel que tinha financiamento/dívida e foi quitado/regularizado; motivo da reprovação conhecido que foi corrigido.
- Se o motivo foi DESQUALIFICADO por IDADE (participante acima do limite do banco: Inter 69, Creditas 75), só adianta se a proposta nova tirou ou trocou esse participante (ou o prazo/idade deixou de ser problema); a mesma proposta de novo NÃO adianta.
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

/** Bloco pra IA da conversa: cliente reprovado voltou e a análise foi retida — não prometer nada. Vazio se não há retenção ativa.
 *  28/10 (Luciana Duarte Dias): o bloco mandava dizer "a equipe vai olhar e retorna" e a IA repetiu por 9 h que "a equipe segue revisando" e que "a Caixa também
 *  está sendo avaliada" — ninguém estava revisando nada. O motivo real (imóvel de cessão de direitos, sem matrícula) estava só nas mensagens do Fabio de 4 dias
 *  antes, fora do histórico que a IA lê. Agora o bloco leva o motivo registrado + o que a equipe escreveu ao cliente, e a IA explica por que a proposta nova
 *  não muda o resultado em vez de dizer que algo está em análise. */
export async function aiReentryContext(leadId: string): Promise<string> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true, stageEnteredAt: true } });
  const cf = (l?.customFields || {}) as Cf;
  const h = cf._reentryHold as { at?: string; priorAt?: string; motivo?: string; mudancas?: string[] } | undefined;
  if (!h?.at) return reprovadoConversandoContext(leadId).catch(() => '');
  if (l?.stageEnteredAt && l.stageEnteredAt > new Date(h.at)) return ''; // a equipe moveu o card depois: decisão humana
  const priorLeadId = String((cf._reentryCheck as { priorLeadId?: string } | undefined)?.priorLeadId || leadId);
  const priorAt = h.priorAt ? new Date(h.priorAt) : new Date(h.at);
  const prior = priorLeadId === leadId ? null : await prisma.lead.findUnique({ where: { id: priorLeadId }, select: { lostReason: true } });
  const motivoRegistrado = (prior ? prior.lostReason : (await prisma.lead.findUnique({ where: { id: leadId }, select: { lostReason: true } }))?.lostReason) || '';
  // O que alguém da equipe escreveu ao cliente perto da reprovação — costuma ser o motivo de verdade (ex.: "imóvel com cessão de direito não serve como garantia").
  const daEquipe = await prisma.message.findMany({
    where: { leadId: { in: [...new Set([priorLeadId, leadId])] }, direction: 'OUTBOUND', sentByUserId: { not: null }, createdAt: { gte: new Date(priorAt.getTime() - 10 * 86_400_000) } },
    orderBy: { createdAt: 'desc' }, take: 6, select: { content: true, createdAt: true },
  });
  const equipe = daEquipe.reverse()
    .map((m) => String(m.content || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 15 && !/^📧|^📎/.test(t))
    .map((t) => `- "${t.slice(0, 280)}"`).join('\n');
  return `CLIENTE REPROVADO QUE VOLTOU (Fabio 19/10 e 28/10): este cliente foi REPROVADO em ${dia(priorAt)}${motivoRegistrado ? ` (motivo registrado: ${motivoRegistrado.slice(0, 220)})` : ''} e preencheu a proposta de novo; o CRM conferiu e NÃO deu andamento${h.motivo ? ` (${h.motivo})` : ''}${h.mudancas?.length ? `. O que mudou: ${h.mudancas.join('; ')}` : ''}.${equipe ? `
O QUE A EQUIPE JÁ EXPLICOU A ELE (é o motivo de verdade — prevalece sobre o motivo registrado):
${equipe}` : ''}
NADA está em análise agora: nenhum banco está rodando e ninguém está "revisando" a proposta. NUNCA diga que a equipe está revisando/avaliando/olhando a proposta, nem que algum banco (Caixa, Creditas, Inter…) está sendo avaliado ou analisado — o cliente fica esperando um retorno que não vem.
O que fazer: explique com educação e de forma direta POR QUE a proposta nova não muda o resultado, usando o motivo de verdade acima (ex.: imóvel de cessão de direitos/sem matrícula registrada não serve de garantia em nenhum banco — trocar valor, prazo ou banco não resolve), e diga o que mudaria, só o que fizer sentido pro motivo (ex.: certidão de matrícula do imóvel registrada em cartório, outro imóvel com matrícula, crédito menor, mais um participante com renda). Se ele citar um banco, diga que a mesma regra vale pra esse banco quando o motivo é o imóvel. Se no histórico ainda não foi dito, pode dizer UMA vez que a equipe foi avisada da proposta nova; não repita. Se ele contar algo que mudou de verdade, registre e passe pra equipe (handoff). NÃO prometa pré-análise, NÃO diga "recebi sua proposta, vou analisar", NÃO peça a lista de documentos (fora o caminho da CAIXA abaixo). Não ofereça "outras possibilidades".
CAIXA NÃO É SAÍDA PRA REPROVADO (Fabio 01/11 — revoga o "CAIXA é o caminho que sobra" de 28/10: a documentação da CAIXA só é pedida depois de aprovar em algum banco): NÃO ofereça a CAIXA, não siga a sequência dela e não peça documento. Se o cliente pedir a CAIXA, explique com educação, sem prometer, que como os bancos não aprovaram não tem como seguir pela CAIXA agora, e diga o que precisaria mudar (só o que fizer sentido pro motivo).`;
}

/** Cliente REPROVADO que só voltou a CONVERSAR (sem proposta nova — o bloco de cima só existe quando ele preenche de novo). Fabio 03/11 (Maria Joanice: Perdida por imóvel abaixo
 *  do mínimo + crédito reprovado; a IA viu a simulação de R$ 50 mil que ela mandou e sugeriu "se quiser tentar com esse valor, é só preencher a proposta de novo", depois ofereceu
 *  montar a proposta pelos documentos e prometeu a pré-análise): "CLIENTE REPROVADA, POR QUE A IA ESTÁ DANDO IDEIA PARA A CLIENTE PARA TENTAR RODAR DE NOVO?".
 *  Vale com o próprio card Perdido por reprovação, ou com reprovação recente da mesma pessoa em outro card enquanto este ainda não passou da Prospecção/Follow Up. */
async function reprovadoConversandoContext(leadId: string): Promise<string> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { accountId: true, status: true, customFields: true, stage: { select: { name: true } } } });
  if (!l) return '';
  const prior = await findRecentRejection(l.accountId, leadId);
  if (!prior) return '';
  if (!prior.self && (l.status !== 'OPEN' || !/prospec|follow|sem retorno|caixa de entrada|^entrada/i.test(l.stage?.name || ''))) return '';
  const chk = (l.customFields as Cf | null)?._reentryCheck as { at?: string; hold?: boolean } | undefined;
  if (chk?.at && chk.hold === false && new Date(chk.at) > prior.at) return ''; // proposta nova com mudança real: o CRM deu andamento
  return `CLIENTE REPROVADO (Fabio 03/11): este cliente foi REPROVADO nos bancos em ${dia(prior.at)} (motivo registrado: ${prior.reason.slice(0, 220)}) e nada está em análise agora.
- NUNCA dê ideia de tentar de novo: não sugira outro valor de crédito (nem o de uma simulação que ele mandou), outro prazo, nova simulação, preencher a proposta de novo, mandar documento pra "seguir com a pré-análise" nem a CAIXA, e não prometa análise, resultado ou retorno. Isso vale também pra regra "NÃO CONSEGUE PREENCHER AGORA": com cliente reprovado, NÃO ofereça montar a proposta pelos documentos.
- Se ele perguntar ou pedir pra tentar de novo sem nada novo: diga com educação, em 1–2 frases, que a análise foi feita e os bancos não aprovaram, e que por enquanto não dá pra seguir. Só diga o que mudaria se fizer sentido pro motivo (motivo IMÓVEL abaixo do mínimo/irregular → só outro imóvel que atenda os bancos, ou um parente de 1º grau com imóvel assim — mudar o valor do crédito NÃO resolve).
- Se ELE trouxer um FATO NOVO (outro imóvel, outra pessoa com imóvel ou renda, a situação que barrou resolvida), aí sim converse sobre ele e mande o link da proposta pra preencher com os dados novos — o CRM confere antes de rodar. Na dúvida, "askTeam".
- Sempre que o assunto for tentar de novo, deixe claro que SEM um fato novo não dá pra rodar o crédito de novo (Fabio 03/11) — o mesmo pedido volta com o mesmo resultado.
- Mandou foto/print de simulação ou documento: não trate como proposta nova nem diga que vai analisar.`;
}

/** Imóvel de CESSÃO DE DIREITOS já identificado (Fabio 28/10: "a gente não faz de jeito nenhum" — se já apareceu na conversa, perguntar por OUTRO imóvel com
 *  matrícula). A IA lê só as últimas 12 mensagens; na Luciana a constatação do Fabio era de 4 dias antes. Procura no card (e no card reprovado de antes, se houver)
 *  mensagens que falam em cessão de direitos e leituras de documento do tipo CESSAO DE DIREITOS. Vazio se não achou. */
export async function aiCessaoContext(leadId: string): Promise<string> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (l?.customFields || {}) as Cf;
  const ids = [...new Set([leadId, String((cf._reentryCheck as { priorLeadId?: string } | undefined)?.priorLeadId || leadId)])];
  const msg = await prisma.message.findFirst({
    where: { leadId: { in: ids }, OR: [{ content: { contains: 'cessão de direito', mode: 'insensitive' } }, { content: { contains: 'cessao de direito', mode: 'insensitive' } }] },
    orderBy: { createdAt: 'desc' }, select: { content: true, createdAt: true, direction: true, sentByUserId: true },
  });
  const doc = Object.values((cf._docReview || {}) as Record<string, { tipo?: string }>).some((r) => /cess[aã]o/i.test(String(r?.tipo || '')));
  if (!msg && !doc) return '';
  const quem = !msg ? 'a leitura de um documento do imóvel' : msg.direction === 'INBOUND' ? 'o cliente' : msg.sentByUserId ? 'a equipe' : 'a conversa';
  const trecho = msg ? ` (${dia(msg.createdAt)}: "${String(msg.content || '').replace(/\s+/g, ' ').trim().slice(0, 200)}")` : '';
  return `IMÓVEL DE CESSÃO DE DIREITOS JÁ IDENTIFICADO: ${quem} apontou que o imóvel em garantia é de cessão de direitos${trecho}. Regra do Fabio (28/10): com esse imóvel a gente NÃO faz de jeito nenhum, em nenhum banco, nem na CAIXA. Siga a regra IMÓVEL DE CESSÃO DE DIREITOS: não peça documentos desse imóvel nem prometa análise; pergunte se o cliente tem OUTRO imóvel com certidão de matrícula registrada em cartório pra colocar em garantia. Se DEPOIS disso o cliente já informou outro imóvel com matrícula (outro endereço), siga com esse outro.`;
}

