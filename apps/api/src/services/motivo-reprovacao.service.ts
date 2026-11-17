import { prisma } from '../lib/prisma';

/* MOTIVO DA REPROVAÇÃO NO FINANCIAMENTO HABITACIONAL (Fabio 17/11, Carlos Guilherme: perguntou "Pq?" depois do aviso de não aprovado e ficou sem resposta).
 * "Sempre que reprovar um cliente de FH a IA pode consultar o cadastro dele na CAIXA para saber se tem restrição, avisa que possui restrição e informa que isso
 * pode ser um fator que implica na aprovação" + "mas isso se ele perguntar o motivo".
 * Card do FH reprovado (Perdido com rejectedAt) e o cliente pergunta o motivo → a IA responde só "vou verificar" e marca "motivo_reprovacao": "perguntou" → a consulta
 * do nome (Oportunidades de Negócios) entra na fila da extensão da CAIXA → com o resultado o CRM responde sozinho: restrição → "consta uma restrição no nome; isso
 * pode ser um fator que pesou na aprovação"; sem restrição → política interna do banco (regra de sempre). Consulta da CAIXA recente (30 dias) no card → usa ela.
 * Estado em `_motivoReprovacao`. */

type Cf = Record<string, any>;
type Mr = { status: 'CONSULTANDO' | 'RESPONDER' | 'RESPONDIDO' | 'EQUIPE'; pedidoEm: string; consultadoEm?: string; texto?: string; respondidoAt?: string; porque?: string };
const VALIDADE_MS = 30 * 86_400_000; // consulta da CAIXA mais velha que isso é refeita
const ESPERA_MAX_MS = 12 * 3600_000; // consulta que não sai nesse tempo → equipe responde

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };
async function grava(leadId: string, mr: Mr): Promise<void> {
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_motivoReprovacao}', ${JSON.stringify(mr)}::jsonb, true) WHERE id = ${leadId}`;
}

/** Card do Financiamento Habitacional reprovado pelos bancos (status Perdido + rejectedAt). Pura. */
export function ehFhReprovado(l: { status?: string | null; rejectedAt?: Date | string | null; pipeline?: { department?: { name?: string | null } | null } | null } | null | undefined): boolean {
  return !!l && l.status === 'LOST' && !!l.rejectedAt && /habitacional/i.test(l.pipeline?.department?.name || '');
}

/** Consulta do nome na CAIXA que já serve pra responder: todos os participantes consultados, fora da fila e com até 30 dias. Pura. */
export function consultaPronta(cf: Cf, agora = Date.now()): string | null {
  const c = cf._caixaCadastro as Cf | undefined;
  const em = c?.consultadoEm as string | undefined;
  if (!c || !em || c.status === 'FILA' || c.status === 'CONSULTA_PARADA') return null;
  return agora - Date.parse(em) <= VALIDADE_MS ? em : null;
}

const primeiroNome = (s: string) => { const n = String(s || '').trim().split(/\s+/)[0] || ''; return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase(); };

/** Resposta ao "por que não aprovou?" pela consulta da CAIXA. Pura. */
export function textoMotivo(saudacao: string, oc: { nomes: string[]; titular: boolean }, quemFalaEOTitular: boolean): string {
  const ini = saudacao ? `${saudacao}, c` : 'C';
  if (!oc.nomes.length) return `${ini}onferi aqui: a análise não foi aprovada por política interna dos bancos. Eles não informam o motivo detalhado.`;
  const proprio = oc.nomes.length === 1 && oc.titular && quemFalaEOTitular;
  const quem = proprio ? 'no seu nome' : `no nome de ${oc.nomes.map(primeiroNome).join(' e ')}`;
  return `${ini}onferi aqui o seu cadastro e consta uma restrição ${quem}. Isso pode ser um fator que pesou na aprovação dos bancos.`;
}

/** A IA marcou "motivo_reprovacao": "perguntou" (o cliente perguntou o motivo da reprovação). */
export async function motivoPerguntado(accountId: string, leadId: string, io?: any): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, status: true, rejectedAt: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead || !ehFhReprovado(lead)) return;
  const cf = (lead.customFields || {}) as Cf;
  const atual = cf._motivoReprovacao as Mr | undefined;
  if (atual && (atual.status === 'CONSULTANDO' || atual.status === 'RESPONDER')) return; // já em andamento
  const agora = new Date().toISOString();
  if (consultaPronta(cf)) {
    await grava(leadId, { status: 'RESPONDER', pedidoEm: agora });
    await responderMotivo(accountId, leadId, io);
    return;
  }
  if (cf._caixaCadastro?.status !== 'FILA') {
    const { pedirCadastroCaixa } = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
    const erro = await pedirCadastroCaixa(accountId, leadId, 'automático — o cliente perguntou o motivo da reprovação');
    if (erro) {
      await grava(leadId, { status: 'EQUIPE', pedidoEm: agora, porque: erro });
      await note(leadId, `⚠️ O cliente perguntou o motivo da reprovação, mas a consulta do nome na CAIXA não entrou na fila (${erro}). Responda você: com restrição no nome, diga que isso pode ter pesado na aprovação; sem, foi política interna do banco.`);
      push(accountId, `❓ ${lead.name}: perguntou o motivo da reprovação`, 'A consulta da CAIXA não saiu: responda você (detalhe na anotação).', leadId);
      return;
    }
  }
  await grava(leadId, { status: 'CONSULTANDO', pedidoEm: agora });
  await note(leadId, '🔎 O cliente perguntou o motivo da reprovação: o nome dele foi pra fila da consulta da CAIXA (Fabio 17/11). Com o resultado, o CRM responde sozinho — restrição no nome: "pode ser um fator que pesou na aprovação"; sem restrição: política interna do banco.');
}

/** Consulta da CAIXA terminou num card que não está aberto (caixa-ocorrencias.verificarOcorrencias): responde o motivo, se o cliente perguntou. */
export async function consultaTerminou(accountId: string, leadId: string, io?: any): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (l?.customFields || {}) as Cf;
  const mr = cf._motivoReprovacao as Mr | undefined;
  if (!mr || mr.status !== 'CONSULTANDO' || !consultaPronta(cf)) return;
  await grava(leadId, { ...mr, status: 'RESPONDER' });
  await responderMotivo(accountId, leadId, io);
}

/** Manda a resposta ao cliente (07h–21h, conversa aberta). IA desligada ou conversa fechada: anotação com o texto pronto + push pra equipe. */
export async function responderMotivo(accountId: string, leadId: string, io?: any): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, aiAutoReplyActive: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const mr = cf._motivoReprovacao as Mr | undefined;
  if (!lead || !mr || mr.status !== 'RESPONDER' || cf._autoPaused || cf._caixaTeste) return;
  const consultadoEm = consultaPronta(cf);
  if (!consultadoEm) return;
  const { comOcorrencia } = require('./caixa-ocorrencias.service') as typeof import('./caixa-ocorrencias.service');
  const oc = comOcorrencia(cf);
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const saudacao = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name) || '';
  const texto = textoMotivo(saudacao, oc, !String(cf.falando_com || '').trim());
  const resumo = oc.nomes.length ? `restrição no nome de ${oc.nomes.join(' e ')}` : 'sem restrição no nome';
  const praEquipe = async (porque: string) => {
    await grava(leadId, { ...mr, status: 'EQUIPE', consultadoEm, texto, porque });
    await note(leadId, `⚠️ O cliente perguntou o motivo da reprovação e ${porque}: responda você. Consulta da CAIXA: ${resumo}. Texto pronto:\n“${texto}”`);
    push(accountId, `❓ ${lead.name}: perguntou o motivo da reprovação`, `${porque.charAt(0).toUpperCase()}${porque.slice(1)}: responda você (texto na anotação).`, leadId);
  };
  if (!lead.aiAutoReplyActive) return praEquipe('a IA do card está desligada');
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return; // o poller manda às 07h
  if (!(await whatsappWindowOpen(leadId))) return praEquipe('a conversa do WhatsApp fechou (24 h)');
  const msg = require('./message.service') as typeof import('./message.service');
  const env = await msg.sendOutboundWhatsApp({ accountId, leadId, content: texto, io });
  if (!env.success) return; // tenta no próximo minuto
  await grava(leadId, { ...mr, status: 'RESPONDIDO', consultadoEm, texto, respondidoAt: new Date().toISOString() });
  await note(leadId, `📨 Respondi o motivo da reprovação pela consulta da CAIXA (${resumo}): “${texto}”`);
}

/** Poller (1 min, junto da orientação de ocorrências): resposta que ficou pra depois (fora do horário) e consulta que não saiu. */
export async function processMotivos(accountId: string, io?: any): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false
      AND "customFields"->'_motivoReprovacao'->>'status' IN ('CONSULTANDO', 'RESPONDER') LIMIT 20`;
  for (const { id } of ids) {
    try {
      const l = await prisma.lead.findUnique({ where: { id }, select: { name: true, customFields: true } });
      const cf = (l?.customFields || {}) as Cf;
      const mr = cf._motivoReprovacao as Mr;
      if (mr.status === 'RESPONDER') { await responderMotivo(accountId, id, io); continue; }
      if (consultaPronta(cf)) { await consultaTerminou(accountId, id, io); continue; }
      const parada = cf._caixaCadastro?.status === 'CONSULTA_PARADA';
      if (!parada && Date.now() - Date.parse(mr.pedidoEm) < ESPERA_MAX_MS) continue;
      const porque = parada ? 'a consulta da CAIXA não trouxe resultado' : 'a consulta da CAIXA não saiu em 12 h';
      await grava(id, { ...mr, status: 'EQUIPE', porque });
      await note(id, `⚠️ O cliente perguntou o motivo da reprovação e ${porque}: responda você. Com restrição no nome, diga que isso pode ter pesado na aprovação; sem, foi política interna do banco.`);
      push(accountId, `❓ ${l?.name || 'Cliente'}: perguntou o motivo da reprovação`, `${porque.charAt(0).toUpperCase()}${porque.slice(1)}: responda você.`, id);
    } catch (e: any) { console.error('[Motivo da reprovação]', e?.message); }
  }
}

/** Bloco do prompt da IA da conversa (card do FH reprovado). '' fora disso. */
export function aiMotivoReprovacaoBloco(cf: Cf): string {
  const mr = cf._motivoReprovacao as Mr | undefined;
  const cab = `--- MOTIVO DA REPROVAÇÃO — FINANCIAMENTO HABITACIONAL (Fabio 17/11) ---
Este card foi REPROVADO pelos bancos e o cliente já foi avisado. Este bloco só vale quando o cliente PERGUNTAR por que não foi aprovado / qual o motivo (ex.: "por quê?", "pq?", "qual o motivo?"); se ele não perguntar, ignore. Aqui ele vale MAIS que a regra "política interna do banco".`;
  if (mr?.status === 'RESPONDIDO' && mr.texto) return `${cab}
O CRM já respondeu o motivo: “${mr.texto}”. Não repita; responda só o que ele perguntar agora, sem prometer nova análise.${/restri/i.test(mr.texto) ? ' Se ele perguntar qual é a restrição ou como ver: a gente não vê o detalhe — ele consulta de graça o próprio CPF no app da Serasa, no app do SCPC (Consumidor Positivo) e no site pesquisaprotesto.com.br.' : ''}`;
  if (mr && (mr.status === 'CONSULTANDO' || mr.status === 'RESPONDER')) return `${cab}
O CRM está conferindo o cadastro dele pra responder o motivo (a resposta vai pra ele sozinha). Se ele perguntar de novo, diga só que está verificando e já retorna — sem citar motivo, CAIXA ou restrição.`;
  if (mr?.status === 'EQUIPE') return `${cab}
A equipe ficou de responder o motivo. Se ele perguntar de novo, diga só que está verificando e já retorna — sem citar motivo, CAIXA ou restrição.`;
  if (consultaPronta(cf)) {
    const { comOcorrencia } = require('./caixa-ocorrencias.service') as typeof import('./caixa-ocorrencias.service');
    const oc = comOcorrencia(cf);
    if (!oc.nomes.length) return `${cab}
Na consulta do cadastro dele na CAIXA não apareceu restrição no nome: se ele perguntar o motivo, foi política interna do banco (não cite a consulta).`;
    return `${cab}
Na consulta do cadastro na CAIXA consta restrição no nome de ${oc.nomes.join(' e ')}. Se ele perguntar o motivo: diga que, conferindo o cadastro, consta uma restrição no nome (${oc.titular && oc.nomes.length === 1 ? 'dele' : `de ${oc.nomes.map(primeiroNome).join(' e ')}`}) e que isso pode ser um fator que pesou na aprovação. Não diga que foi só isso, não cite score nem banco, não prometa nova análise nem que, limpando o nome, aprova. Se ele perguntar qual é a restrição ou como ver: a gente não vê o detalhe — ele consulta de graça o próprio CPF no app da Serasa, no app do SCPC (Consumidor Positivo) e no site pesquisaprotesto.com.br.`;
  }
  return `${cab}
Ainda não conferimos o cadastro dele na CAIXA. Se ele perguntar o motivo: responda só UMA frase curta (ex.: "Vou verificar aqui o seu cadastro e já te retorno.") — sem citar motivo, CAIXA, restrição nem política do banco — e marque "extractedFields": {"motivo_reprovacao": "perguntou"}. O CRM consulta o nome dele na CAIXA e manda a resposta sozinho.`;
}
