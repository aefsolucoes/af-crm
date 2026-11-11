import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | undefined;

/**
 * CAIXA SÓ A PEDIDO DO CLIENTE (Fabio 01/11 — substitui a pergunta "Vi que você marcou a CAIXA…" de 21/10, que saiu): "SE JÁ PASSAMOS AS APROVAÇÕES AO CLIENTE, NÃO TEM POR
 * QUE OFERECERMOS CAIXA". A documentação da CAIXA só é pedida quando algum banco aprovou, o CLIENTE pediu a CAIXA e tem nome limpo e imóvel com Habite-se — a IA da conversa
 * faz as perguntas (regra CAIXA em ai-shared.CORE_RULES) e marca "caixaRota". Aí o card vai pra etapa "Análise CAIXA" (Fabio 11/11; sem ela, Pré-Análise) do funil de Vendas do setor (HE e FH) e fica lá até o resultado da
 * CAIXA ("O CADASTRO NA CAIXA DEVE OCORRER EM PRÉ-ANÁLISE AINDA"): a conferência dos documentos da CAIXA, a ficha e o cadastro rodam nessa etapa.
 * Também param (Fabio 01/11): a documentação da CAIXA combinada antes da proposta e o reprovado que volta pela CAIXA.
 */

/** Algum banco aprovou de verdade (não simulação), ou o aviso de aprovação do Financiamento já saiu. */
export async function temAprovacao(leadId: string, cf: Record<string, any>): Promise<boolean> {
  if (cf._fhNotice?.sentAt) return true;
  return (await prisma.creditAnalysis.count({ where: { leadId, dryRun: false, source: { not: 'AI_SIM' }, status: { in: ['APPROVED', 'CONDITIONAL'] } } })) > 0;
}

/** Quem pediu a CAIXA: a IA da conversa (cliente com a IA ligada), o cliente com a IA desligada, a equipe escrevendo na conversa ou o botão "Consultar na CAIXA" do card. */
export type OrigemCaixa = 'ia' | 'cliente' | 'equipe' | 'botao';
/** Resultado SEM restrição de um pedido da CAIXA: o que vai ao cliente (status PENDING → ENVIADO, ou EQUIPE quando a IA está desligada / a conversa fechou). */
type Limpo = { consultadoEm: string; status: 'PENDING' | 'ENVIADO' | 'EQUIPE' | 'SO_NOTA'; texto: string; habite: 'TEM' | 'NAO_TEM' | null; rota: boolean; at: string; enviadoAt?: string };
/** `_caixaPedido` no card. */
type Pedido = { at: string; origem?: OrigemCaixa; por?: string; concorrente?: boolean; limpo?: Limpo };

const DOCS_CAIXA = 'RG, CPF, comprovante de endereço, último contracheque e certidão de estado civil (se tiver cônjuge, o RG e o CPF dele também)';
const POR_ORIGEM: Record<OrigemCaixa, string> = {
  ia: 'automático — o cliente pediu a CAIXA',
  cliente: 'automático — o cliente pediu a CAIXA (IA do card desligada)',
  equipe: 'automático — a equipe combinou a CAIXA na conversa',
  botao: 'botão "Consultar na CAIXA"',
};
/** Etapa "Análise CAIXA" do funil de Vendas (HE e FH, Fabio 11/11): onde o card espera documentação, cadastro e avaliação da CAIXA. */
export const ETAPA_CAIXA_RE = /^an[aá]lise\s+caixa/i;
const nota = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const avisa = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };
async function gravaPedido(leadId: string, pedido: Pedido): Promise<void> {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaPedido}', ${JSON.stringify(pedido)}::jsonb, true) WHERE id = ${leadId}`;
}
/** A equipe (conversa ou botão), o cliente que ia pela CAIXA por fora e o Financiamento Habitacional pulam a trava "documentação da CAIXA só depois de uma aprovação". */
const pedidoLiberado = (p: Pedido | undefined) => !!p && (!!p.concorrente || p.origem === 'equipe' || p.origem === 'botao');

/** CONSULTA PRIMEIRO (Fabio 11/11: "Sempre que um cliente quiser seguir pela CAIXA, ele informar ou a gente, o CRM deve fazer uma consulta para buscar ocorrências" +
 *  "Assim ele evita de encaminhar documentação à toa"; substitui a pergunta de nome limpo de 01/11): o cliente (IA ligada ou desligada), a equipe na conversa ou o botão
 *  "Consultar na CAIXA" → consulta do nome (Oportunidades de Negócios) na fila da extensão na hora, com os nomes e CPFs da proposta — COM ou SEM aprovação de outro banco.
 *  A documentação só depois do resultado: restrição → orientação Serasa/SCPC/protesto (caixa-ocorrencias); sem restrição → consultaLimpa. Uma vez por card. */
export async function pedirConsultaCaixa(accountId: string, leadId: string, opts: { concorrente?: boolean; origem?: OrigemCaixa; por?: string; io?: Io } = {}): Promise<{ ok: boolean; erro?: string; ja?: boolean }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, isGroup: true, customFields: true } });
  if (!lead) return { ok: false, erro: 'Card não encontrado' };
  if (lead.isGroup) return { ok: false, erro: 'Grupo não tem consulta da CAIXA' };
  const cf = (lead.customFields || {}) as Record<string, any>;
  const atual = cf._caixaPedido as Pedido | undefined;
  if (atual) {
    // A IA percebeu depois que o cliente ia pela CAIXA por fora: vale pro passo da documentação.
    if (opts.concorrente && !atual.concorrente) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set("customFields", '{_caixaPedido,concorrente}', 'true'::jsonb, true) WHERE id = ${leadId}`;
    return { ok: true, ja: true };
  }
  const origem: OrigemCaixa = opts.origem || 'ia';
  const pedido: Pedido = { at: new Date().toISOString(), origem, por: opts.por || POR_ORIGEM[origem], ...(opts.concorrente ? { concorrente: true } : {}) };
  // Card que já tem consulta ou cadastro da CAIXA: não pede de novo (re-enfileirar apagaria as consultas e atrapalharia um cadastro em andamento) — usa o que já existe.
  if (cf._caixaCadastro) {
    await gravaPedido(leadId, pedido);
    const c = cf._caixaCadastro as Record<string, any>;
    if (!c.consultadoEm) {
      await nota(leadId, `🏦 Pediram a CAIXA (${pedido.por}): a consulta do nome na CAIXA já está na fila — o resultado segue sozinho.`);
      return { ok: true, ja: true };
    }
    const { comOcorrencia } = require('./caixa-ocorrencias.service') as typeof import('./caixa-ocorrencias.service');
    const oc = comOcorrencia(cf);
    if (oc.nomes.length) {
      await nota(leadId, `🏦 Pediram a CAIXA (${pedido.por}): a consulta de ${new Date(c.consultadoEm).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} já mostrou ocorrência no nome de ${oc.nomes.join(' e ')}. Não pedi documento; confira a orientação Serasa/SCPC/protesto no card.`);
      return { ok: true, ja: true };
    }
    await consultaLimpa(accountId, leadId, opts.io);
    return { ok: true, ja: true };
  }
  const { pedirCadastroCaixa } = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
  const erro = await pedirCadastroCaixa(accountId, leadId, pedido.por!);
  if (erro) {
    // Sem gravar o pedido: quando a equipe acertar o card (participante/CPF), o próximo pedido tenta de novo.
    await nota(leadId, `🏦 Pediram a CAIXA (${pedido.por}), mas a consulta do nome não entrou na fila: ${erro}. Confira os participantes e o CPF no card.`);
    if (origem !== 'botao') avisa(accountId, `🏦 ${lead.name}: consulta da CAIXA não saiu`, String(erro).slice(0, 120), leadId);
    return { ok: false, erro };
  }
  await gravaPedido(leadId, pedido);
  return { ok: true };
}

/** A consulta de um PEDIDO da CAIXA fechou SEM restrição no nome (chamado por caixa-ocorrencias.verificarOcorrencias): o cliente fica sabendo e o próximo passo é o Habite-se.
 *  Habite-se já conhecido (proposta / conversa): TEM → documentação da CAIXA (com aprovação, FH, por fora ou pedido da equipe) e rota; NÃO TEM → a CAIXA não aceita.
 *  Consulta que não veio de um pedido (ex.: cadastro depois da documentação) não manda nada. */
export async function consultaLimpa(accountId: string, leadId: string, io?: Io): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  const pedido = cf._caixaPedido as Pedido | undefined;
  const consultadoEm = cf._caixaCadastro?.consultadoEm as string | undefined;
  if (!pedido || !consultadoEm || pedido.limpo?.consultadoEm === consultadoEm) return;
  const hs = require('./habite-se.service') as typeof import('./habite-se.service');
  let habite: 'TEM' | 'NAO_TEM' | null = null;
  const st = cf._habiteSe?.status;
  if (st === 'TEM' || st === 'AVERBADA') habite = 'TEM';
  else if (st === 'NAO_TEM') habite = 'NAO_TEM';
  else {
    const p = hs.habiteDaProposta(await hs.propostaDoLead(leadId).catch(() => ''));
    if (p === 'TEM' || p === 'NAO_TEM') habite = p;
  }
  const fh = /habitacional/i.test(lead.pipeline?.department?.name || '');
  const podeDocs = fh || pedidoLiberado(pedido) || (await temAprovacao(leadId, cf));
  const jaNaRota = !!cf._caixaRota;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const saud = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name) || '';
  let texto = `${saud ? `${saud}, c` : 'C'}onsultei aqui na CAIXA e não apareceu nenhuma restrição no nome.`;
  let rota = false;
  if (habite === 'NAO_TEM') texto += ' Só que a CAIXA não aceita imóvel residencial sem Habite-se, então por lá não dá pra seguir.';
  else if (habite === 'TEM' && podeDocs) { texto += ` Pra seguir pela CAIXA, ela pede a documentação antes da análise: ${DOCS_CAIXA}. O que você já mandou por aqui não precisa mandar de novo.`; rota = true; }
  else if (habite === 'TEM') texto += ' Primeiro sai o resultado dos bancos parceiros; com uma aprovação, dá pra seguir pela CAIXA também.';
  else texto += ' O imóvel tem Habite-se? A CAIXA só aceita imóvel residencial com Habite-se.';
  const limpo: Limpo = { consultadoEm, status: jaNaRota ? 'SO_NOTA' : 'PENDING', texto, habite, rota, at: new Date().toISOString() };
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set("customFields", '{_caixaPedido,limpo}', ${JSON.stringify(limpo)}::jsonb, true) WHERE id = ${leadId}`;
  await nota(leadId, `✅ CAIXA: a consulta do nome NÃO mostrou restrição (pedido: ${pedido.por || 'CAIXA'}). ${jaNaRota ? 'O card já está na rota da CAIXA (a documentação já foi pedida): nada novo vai ao cliente.' : `Vou avisar o cliente: “${texto}”`}`);
  avisa(accountId, `✅ ${lead.name}: nome sem restrição na CAIXA`, jaNaRota ? 'Card já na rota da CAIXA.' : habite ? 'O cliente vai receber o resultado.' : 'O CRM vai perguntar do Habite-se.', leadId);
  if (!jaNaRota) await enviarAvisoLimpo(accountId, leadId, io);
}

/** Manda ao cliente o resultado sem restrição (07h–21h, conversa aberta). IA desligada ou conversa fechada: nota com o texto pronto + push pra equipe. */
export async function enviarAvisoLimpo(accountId: string, leadId: string, io?: Io): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, aiAutoReplyActive: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Record<string, any>;
  const pedido = cf._caixaPedido as Pedido | undefined;
  const lp = pedido?.limpo;
  if (!lead || !pedido || !lp || lp.status !== 'PENDING' || cf._autoPaused || cf._caixaTeste) return; // _caixaTeste: modo teste (Fabio 11/11)
  const marca = (patch: Partial<Limpo>) => prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set("customFields", '{_caixaPedido,limpo}', ${JSON.stringify({ ...lp, ...patch })}::jsonb, true) WHERE id = ${leadId}`;
  const rota = async () => { if (lp.rota) await entrarRotaCaixa(accountId, leadId, 'Consulta da CAIXA sem restrição + imóvel com Habite-se', io, { concorrente: !!pedido.concorrente, liberado: true }).catch((e) => console.error('[CAIXA] rota:', e?.message)); };
  const praEquipe = async (porque: string) => {
    await marca({ status: 'EQUIPE' });
    await nota(leadId, `🏦 Consulta da CAIXA sem restrição, mas ${porque}: mande você ao cliente. Texto pronto:\n“${lp.texto}”${lp.rota ? '\nO card entrou na rota da CAIXA (etapa Análise CAIXA): a documentação da CAIXA é conferida quando chegar.' : ''}`);
    avisa(accountId, `🏦 ${lead.name}: nome sem restrição na CAIXA`, `${porque.charAt(0).toUpperCase()}${porque.slice(1)}: mande o resultado ao cliente (texto na anotação).`, leadId);
    await rota();
  };
  if (!lead.aiAutoReplyActive) return praEquipe('a IA do card está desligada');
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return; // o poller manda às 07h
  if (!(await whatsappWindowOpen(leadId))) return praEquipe('a conversa do WhatsApp está fechada (24 h)');
  const msg = require('./message.service') as typeof import('./message.service');
  const env = await msg.sendOutboundWhatsApp({ accountId, leadId, content: lp.texto, io: io as any });
  if (!env.success) return; // tenta no próximo minuto
  await marca({ status: 'ENVIADO', enviadoAt: new Date().toISOString() });
  await nota(leadId, `📨 Mandei ao cliente o resultado da consulta da CAIXA (sem restrição)${lp.habite ? '' : ' e perguntei do Habite-se'}. A IA cuida da resposta.`);
  await rota();
}

/** Poller (1 min, junto da orientação de ocorrências): resultado sem restrição que ficou pra depois (fora do horário). */
export async function processAvisosLimpos(accountId: string, io?: Io): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaPedido'->'limpo'->>'status' = 'PENDING' LIMIT 20`;
  for (const { id } of ids) await enviarAvisoLimpo(accountId, id, io).catch((e) => console.error('[CAIXA limpo]', e?.message));
}

/** Bloco do prompt da IA da conversa sobre o pedido da CAIXA (consulta em andamento ou sem restrição). '' fora disso — a restrição tem o bloco dela (caixa-ocorrencias). */
export async function aiConsultaCaixaBloco(leadId: string, cf: Record<string, any>): Promise<string> {
  const pedido = cf._caixaPedido as Pedido | undefined;
  if (!pedido || cf._caixaRota) return '';
  const lp = pedido.limpo;
  if (!lp) {
    const consultadoEm = cf._caixaCadastro?.consultadoEm as string | undefined;
    if (consultadoEm && cf._ocorrencias?.consultadoEm === consultadoEm) return ''; // restrição: vale o bloco RESTRIÇÃO NO NOME
    return `--- CONSULTA DA CAIXA EM ANDAMENTO (Fabio 11/11) ---
O cliente quer seguir pela CAIXA e o CRM está consultando o nome dele na CAIXA (leva alguns minutos). Até sair o resultado: NÃO peça documento da CAIXA e NÃO pergunte se o nome está limpo. Se ele perguntar, diga que está verificando o cadastro dele na CAIXA e já retorna — o resultado vai pra ele sozinho.`;
  }
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { pipeline: { select: { department: { select: { name: true } } } } } });
  const fh = /habitacional/i.test(lead?.pipeline?.department?.name || '');
  const podeDocs = fh || pedidoLiberado(pedido) || (await temAprovacao(leadId, cf));
  const enviado = lp.status === 'ENVIADO' ? `O CRM já mandou ao cliente: “${lp.texto}”` : lp.status === 'EQUIPE' ? 'A equipe ficou de passar esse resultado ao cliente.' : 'O CRM vai mandar esse resultado ao cliente.';
  const habite = lp.habite === 'TEM' ? 'o imóvel TEM Habite-se.' : lp.habite === 'NAO_TEM' ? 'o imóvel NÃO tem Habite-se — a CAIXA não aceita imóvel residencial sem Habite-se.' : 'ainda não sabemos — o CRM perguntou ao cliente.';
  return `--- CONSULTA DA CAIXA: SEM RESTRIÇÃO NO NOME (Fabio 11/11) ---
O cliente quer seguir pela CAIXA e a consulta do nome na CAIXA NÃO mostrou restrição. ${enviado}
Habite-se: ${habite}
Quando o cliente responder sobre o Habite-se (ou já tiver respondido na conversa):
- TEM Habite-se: ${podeDocs ? `avise que, pela CAIXA, ele precisa encaminhar a documentação ANTES da análise (${DOCS_CAIXA} — peça só o que ainda NÃO chegou; confira o bloco DOCUMENTOS DESTE CLIENTE) e marque "caixaRota": true.` : 'diga em 1 frase, sem prometer, que primeiro sai o resultado dos bancos parceiros e que, com uma aprovação, dá pra seguir pela CAIXA. NÃO peça documento ainda.'}
- NÃO tem Habite-se: explique, com clareza e sem prometer, que a CAIXA não aceita imóvel residencial sem Habite-se e siga com a aprovação que ele já tem (se tiver).
Nunca pergunte se o nome está limpo: a consulta já respondeu.`;
}

/** "caixa" que não é o banco (caixa de entrada, caixa d'água…). */
const NAO_E_BANCO_RE = /caixa\s+(de\s+entrada|postal|d[e']?\s*[aá]gua|eletr[oô]nic\w*|de\s+som|de\s+correio|de\s+papel[aã]o|acoplada|de\s+gordura|de\s+luz)|caixinhas?/gi;

/** A CAIXA combinada SEM a IA da conversa (Fabio 11/11: "ele informar ou a gente"): o cliente escreve com a IA do card desligada, ou alguém da equipe escreve na conversa.
 *  Mensagem que cita a CAIXA → uma IA barata lê as últimas mensagens e diz se o cliente quer seguir pela CAIXA → pedirConsultaCaixa. Com a IA do card ligada, quem marca é
 *  a resposta dela ("caixaPedido"). */
export async function detectarPedidoCaixa(accountId: string, leadId: string, texto: string, autor: 'cliente' | 'equipe', io?: Io): Promise<void> {
  if (!/\bcaixa\b/i.test(String(texto || '').replace(NAO_E_BANCO_RE, ' '))) return;
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId, status: 'OPEN', isGroup: false }, select: { aiAutoReplyActive: true, customFields: true } });
  if (!lead) return;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._caixaPedido || cf._autoPaused) return;
  if (autor === 'cliente' && lead.aiAutoReplyActive) return; // a IA da conversa marca
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return;
  const hist = await prisma.message.findMany({ where: { leadId, deleted: false }, orderBy: { createdAt: 'desc' }, take: 8, select: { direction: true, content: true } });
  const conversa = hist.reverse().map((m) => `${m.direction === 'INBOUND' ? 'CLIENTE' : 'ATENDENTE'}: ${String(m.content || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: 'Conversa de um correspondente bancário (crédito com garantia de imóvel / financiamento de imóvel) com um cliente. Decida se a ÚLTIMA mensagem mostra que o CLIENTE QUER SEGUIR, RODAR ou FAZER o crédito pela CAIXA Econômica Federal: o cliente pede, prefere ou diz que vai pela CAIXA, ou a atendente combina com ele que vai rodar/seguir pela CAIXA. NÃO conta: só citar a CAIXA de passagem, dizer que tem conta ou outro financiamento na CAIXA, comparar sem decidir, perguntar como funciona, a atendente dizendo que pela CAIXA não dá, ou "caixa" que não é o banco. Responda SÓ JSON: {"caixa": true} ou {"caixa": false}. Na dúvida, false.',
      messages: [{ role: 'user', content: `Últimas mensagens (a última é a que importa):\n${conversa}` }],
    }),
  }).catch(() => null);
  if (!res?.ok) return;
  const data = (await res.json().catch(() => null)) as { content?: { type: string; text?: string }[] } | null;
  const out = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text || '').join('');
  if (!/"caixa"\s*:\s*true/i.test(out)) return;
  const r = await pedirConsultaCaixa(accountId, leadId, { origem: autor, io });
  if (r.ok && !r.ja) await nota(leadId, `🏦 ${autor === 'equipe' ? 'A equipe combinou a CAIXA na conversa' : 'O cliente pediu a CAIXA (IA do card desligada)'}: a consulta do nome na CAIXA entrou na fila. A documentação só depois do resultado (Fabio 11/11).`);
}

/** O cliente pediu a CAIXA e passou nas regras dela: marca `_caixaRota` (+ `_optouCaixa`, que guarda as outras aprovações), leva o card pra etapa "Análise CAIXA" (sem ela, Pré-Análise) e agenda a
 *  conferência dos documentos que já estão na conversa. true = entrou agora. */
export async function entrarRotaCaixa(accountId: string, leadId: string, motivo: string | null, io?: Io, opts: { concorrente?: boolean; liberado?: boolean } = {}): Promise<boolean> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, name: true, customFields: true, stage: { select: { name: true } }, pipeline: { select: { departmentId: true, department: { select: { name: true } } } } } });
  if (!lead) return false;
  const cf = (lead.customFields || {}) as Record<string, any>;
  if (cf._caixaRota) return false;
  // O pedido da CAIXA guarda se o cliente ia por fora (a IA não precisa marcar de novo) e se foi a equipe que combinou (Fabio 11/11).
  opts = { ...opts, concorrente: opts.concorrente || !!(cf._caixaPedido as Pedido | undefined)?.concorrente, liberado: opts.liberado || pedidoLiberado(cf._caixaPedido) };
  // Financiamento Habitacional: taxa/parcela alta → CAIXA mesmo sem aprovação (Fabio 03/11 — regra FINANCIAMENTO HABITACIONAL × TAXA/PARCELA ALTA).
  const fh = /habitacional/i.test(lead.pipeline?.department?.name || '');
  if (!fh && !opts.concorrente && !opts.liberado && !(await temAprovacao(leadId, cf))) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: '🏦 O cliente pediu a CAIXA, mas nenhum banco aprovou ainda: pela regra (Fabio 01/11) a documentação da CAIXA só é pedida depois de alguma aprovação. O card ficou onde estava.' } }).catch(() => {});
    return false;
  }
  const agora = new Date().toISOString();
  const rota = { at: agora, motivo: motivo || null, etapaAntes: lead.stage?.name || null, ...(opts.concorrente ? { concorrente: true } : {}) };
  // Só as duas chaves (jsonb_set): regravar o card inteiro apaga o que outro processo gravou no meio (corrida no customFields, 29/10).
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaRota}', ${JSON.stringify(rota)}::jsonb, true), '{_optouCaixa}', ${JSON.stringify({ banco: 'CAIXA', at: agora })}::jsonb, true) WHERE id = ${leadId}`;
  const sales = lead.pipeline?.departmentId
    ? await prisma.pipeline.findFirst({ where: { accountId, departmentId: lead.pipeline.departmentId, name: { contains: 'Vendas', mode: 'insensitive' } }, select: { name: true, stages: { select: { id: true, name: true } } } })
    : null;
  // Etapa própria "Análise CAIXA" (Fabio 11/11: "acha que devemos criar um estágio apenas para esses clientes que estão na CAIXA?" → "Sim, cria"): o processo da
  // CAIXA é longo e, na Pré-Análise, o card caía nas rotinas dos outros bancos (rodar sozinho, retomada das 07h). Sem a etapa no funil, Pré-Análise como antes.
  const pre = sales?.stages.find((s) => ETAPA_CAIXA_RE.test(s.name)) || sales?.stages.find((s) => /^pr[eé].?an[aá]lise/i.test(s.name));
  let movido = '';
  if (pre && sales && lead.stage?.name !== pre.name) {
    const { updateLeadStage } = require('./lead.service') as typeof import('./lead.service');
    await updateLeadStage(leadId, accountId, pre.id);
    movido = `${sales.name} / ${pre.name}`;
    if (io) io.to(`lead:${leadId}`).emit('lead_moved', { leadId, stageId: pre.id });
  }
  // Documento que já está na conversa (RG, comprovante…) entra na conferência da CAIXA sem esperar arquivo novo.
  const due = new Date(Date.now() + 5 * 60_000).toISOString();
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_docsCheckDue}', ${JSON.stringify(due)}::jsonb, true) WHERE id = ${leadId}`;
  await prisma.note.create({ data: { leadId, type: movido ? 'STAGE_CHANGE' : 'COMMENT', content: `🏦 ${opts.concorrente ? 'O cliente ia seguir pela CAIXA POR FORA (proposta da CAIXA em outro lugar) — a IA disse que a A&F também faz CAIXA' : 'O cliente PEDIU a CAIXA (consulta do nome na CAIXA sem restrição, imóvel com Habite-se)'}${motivo ? ` — ${motivo}` : ''}. ${movido ? `Card foi pra "${movido}"` : `Card fica em "${lead.stage?.name || 'etapa atual'}"`} até o resultado da CAIXA. As aprovações dos outros bancos ficam GUARDADAS. A documentação da CAIXA foi pedida ao cliente; quando estiver completa, o CRM gera a ficha e a extensão faz o cadastro.` } }).catch(() => {});
  (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title: `🏦 ${lead.name}: pediu a CAIXA`, body: `Card ${movido ? `foi pra ${movido.split(' / ').pop()}` : `na ${lead.stage?.name || 'etapa atual'}`}; documentação da CAIXA pedida`, leadId }).catch(() => {});
  logActivity({ accountId, userId: null, userName: 'Assistente IA', action: 'lead_edited', leadId, leadName: lead.name, summary: `cliente pediu a CAIXA${movido ? ` — card foi pra ${movido.split(' / ').pop()}` : ''}` });
  return true;
}
