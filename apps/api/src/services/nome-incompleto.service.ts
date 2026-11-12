import { prisma } from '../lib/prisma';
import { sendOutboundWhatsApp } from './message.service';

/** NOME INCOMPLETO NA PROPOSTA (Fabio 12/11: "cliente com nome e sobrenome incompleto o CRM deve solicitar o nome e sobrenome certo do cliente para conseguir rodar o crédito").
 *  Caso: a proposta veio com o nome abreviado ("ENEAS NS"), a análise rodou assim mesmo e o cliente ainda respondeu "está sim" à confirmação do cadastro — banco nenhum
 *  acha a pessoa por um nome que não é o do documento.
 *  Como funciona:
 *   1) antes de começar a análise automática (Home Equity e Financiamento), o CRM vê se o nome de cada participante está completo; não estando, NÃO roda e pede o nome
 *      completo ao cliente, uma vez (IA do card ligada, 07h–21h, janela de 24 h do WhatsApp aberta). Sem dá pra perguntar: anotação + push pra equipe, e pergunta quando der;
 *   2) a IA da conversa recebe o contexto (aiNomeIncompletoContext) e grava "participante_N" com o nome completo; se o cliente afirmar que o nome do documento é aquele
 *      mesmo, grava "nome_completo_confirmado" e o CRM libera;
 *   3) nome completo no card → a análise começa sozinha na próxima rodada; se nesse meio-tempo a equipe rodou à mão com o nome incompleto, o CRM refaz em todos os bancos.
 *  Só vale pra análise que AINDA NÃO começou (sem varredura em card já rodado: não manda mensagem retroativa). 24 h sem resposta → a equipe é avisada uma vez.
 *  Estado: customFields._nomeIncompleto = { status: ASKED | AVISADO | RESOLVIDO | CONFIRMADO, at, nomes }. */

type Io = Parameters<typeof sendOutboundWhatsApp>[0]['io'];
type Cf = Record<string, any>;

const sem = (t: unknown) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const PARTICULAS = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'di', 'du', 'del', 'della', 'la', 'le', 'van', 'von', 'y']);
const AGNOMES = new Set(['jr', 'junior', 'filho', 'filha', 'neto', 'neta', 'sobrinho', 'sobrinha', 'segundo', 'terceiro', 'ii', 'iii']);

/** O nome está incompleto pra rodar crédito? Devolve o motivo ('sem sobrenome' | 'abreviado') ou null. Vazio ou sem letras = null (não é este o problema). Pura. */
export function nomeIncompleto(nome: unknown): 'sem sobrenome' | 'abreviado' | null {
  const partes = sem(nome).replace(/['’`´]/g, '').split(/\s+/).filter(Boolean);
  const tokens = partes.map((p) => ({ ponto: /\.$/.test(p), t: p.replace(/[^a-z]/g, '') })).filter((x) => x.t);
  if (!tokens.length) return null;
  const reais = tokens.filter((x) => !PARTICULAS.has(x.t) && !AGNOMES.has(x.t));
  // Abreviado: inicial solta ("ANA P SILVA"), com ponto ("JOSE C. SILVA") ou só consoantes ("ENEAS NS").
  if (reais.some((x) => (x.ponto && x.t.length <= 3) || x.t.length === 1 || !/[aeiouy]/.test(x.t))) return 'abreviado'; // ponto só em pedaço curto: "MARIA DA SILVA." não é abreviação
  if (reais.length < 2) return 'sem sobrenome';
  return null;
}

/** Participantes do card com o nome incompleto. Pura. */
export function participantesIncompletos(cf: Cf): { n: number; nome: string; motivo: string }[] {
  const out: { n: number; nome: string; motivo: string }[] = [];
  for (const n of [1, 2]) {
    const nome = String(cf[`participante_${n}`] || '').trim();
    const motivo = nomeIncompleto(nome);
    if (motivo) out.push({ n, nome, motivo });
  }
  return out;
}

/** O cliente afirmou que o nome do documento é aquele mesmo: vale enquanto os nomes do card forem os confirmados. Pura. */
function confirmadoAssim(cf: Cf, faltas: { n: number; nome: string }[]): boolean {
  const ni = cf._nomeIncompleto as { status?: string; nomes?: Record<string, string> } | undefined;
  return ni?.status === 'CONFIRMADO' && faltas.every((f) => sem(ni.nomes?.[String(f.n)]) === sem(f.nome));
}

/** Texto do pedido ao cliente. Pura. */
export function textoNomeIncompleto(faltas: { n: number; nome: string }[], primeiroNome: string | null): string {
  const oi = primeiroNome ? `${primeiroNome}, pra` : 'Pra';
  if (faltas.length === 1) {
    const de = faltas[0].n === 1 ? 'do seu nome completo' : 'do nome completo do segundo participante';
    return `${oi} rodar a sua análise de crédito eu preciso ${de}, igual está no documento (RG ou CNH). Na proposta veio "${faltas[0].nome}". Pode me mandar o nome completo, por favor?`;
  }
  return `${oi} rodar a sua análise de crédito eu preciso do nome completo de cada participante, igual está no documento (RG ou CNH). Na proposta veio:\n${faltas.map((f) => `• "${f.nome}"`).join('\n')}\nPode me mandar os nomes completos, por favor?`;
}

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* sem push */ } };
// Só a chave (jsonb_set): regravar o card inteiro apaga o que outro processo gravou no meio (corrida no customFields, 29/10).
const salva = (leadId: string, estado: Record<string, unknown>) => prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_nomeIncompleto}', ${JSON.stringify(estado)}::jsonb, true) WHERE id = ${leadId}`;

/** Chamado ANTES de começar a análise automática. true = segura (nome incompleto): pede o nome ao cliente uma vez, ou avisa a equipe quando não dá pra perguntar. */
export async function segurarPorNomeIncompleto(accountId: string, lead: { id: string; name: string }, cf: Cf, io?: Io): Promise<boolean> {
  if (String(cf.cpf_1 ?? '').replace(/\D/g, '').length !== 11) return false; // sem proposta preenchida não há o que pedir (o nome do card ainda é o do perfil do WhatsApp)
  const faltas = participantesIncompletos(cf);
  const ni = cf._nomeIncompleto as { status?: string; at?: string } | undefined;
  if (!faltas.length) {
    if (ni && (ni.status === 'ASKED' || ni.status === 'AVISADO')) {
      await salva(lead.id, { ...ni, status: 'RESOLVIDO', resolvedAt: new Date().toISOString() });
      await note(lead.id, '✅ Nome completo no card: a análise de crédito segue.');
    }
    return false;
  }
  if (confirmadoAssim(cf, faltas)) return false;
  if (ni?.status === 'ASKED') {
    // Pergunta feita: espera o cliente. 24 h sem o nome (respondeu em áudio, IA desligada, não respondeu) → a equipe é avisada UMA vez; o card segue segurado até o nome ser corrigido ou a equipe rodar à mão.
    const n = ni as { at?: string; cobradoAt?: string };
    if (!n.cobradoAt && n.at && Date.now() - new Date(n.at).getTime() > 24 * 3_600_000) {
      await salva(lead.id, { ...ni, cobradoAt: new Date().toISOString() });
      await note(lead.id, `⏰ Pedi o nome completo ao cliente há mais de 24 h e o card continua com ${faltas.map((f) => `"${f.nome}"`).join(' e ')}: a análise de crédito segue parada. Corrija o nome no card (a análise começa sozinha) ou rode à mão pela aba Análise de Crédito.`);
      push(accountId, `⏰ ${lead.name}: nome completo não chegou`, 'A análise segue parada há mais de 24 h — corrija o nome no card ou rode à mão', lead.id);
    }
    return true;
  }
  const fresh = await prisma.lead.findUnique({ where: { id: lead.id }, select: { aiAutoReplyActive: true } });
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const texto = textoNomeIncompleto(faltas, callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name));
  const quais = faltas.map((f) => `"${f.nome}" (${f.motivo})`).join(' e ');
  const nomes = Object.fromEntries(faltas.map((f) => [String(f.n), f.nome]));
  if (fresh?.aiAutoReplyActive && inNoticeWindow() && (await whatsappWindowOpen(lead.id))) {
    const env = await sendOutboundWhatsApp({ accountId, leadId: lead.id, content: texto, io: io as any });
    if (env.success) {
      await salva(lead.id, { status: 'ASKED', at: new Date().toISOString(), nomes });
      await note(lead.id, `✋ Análise de crédito NÃO rodada: nome incompleto na proposta — ${quais}. Pedi o nome completo ao cliente; quando ele mandar, o card é corrigido e a análise começa sozinha.`);
      if (ni?.status !== 'AVISADO') push(accountId, `✋ ${lead.name}: nome incompleto`, 'A análise espera o nome completo — já pedi ao cliente', lead.id);
      return true;
    }
  }
  if (ni?.status !== 'AVISADO') {
    await salva(lead.id, { status: 'AVISADO', at: new Date().toISOString(), nomes });
    await note(lead.id, `✋ Análise de crédito NÃO rodada: nome incompleto na proposta — ${quais}. Ainda não deu pra pedir ao cliente (${fresh?.aiAutoReplyActive ? 'fora do horário ou conversa fechada no WhatsApp' : 'IA desligada no card'}). Corrija o nome no card ou peça ao cliente: "${texto}"`);
    push(accountId, `✋ ${lead.name}: nome incompleto`, 'A análise não rodou: falta o nome completo do cliente', lead.id);
  }
  return true;
}

/** Bloco pro prompt da IA da conversa enquanto o nome completo não chega. '' se não houver. */
export function aiNomeIncompletoContext(cf: Cf): string {
  const ni = cf._nomeIncompleto as { status?: string } | undefined;
  if (!ni || (ni.status !== 'ASKED' && ni.status !== 'AVISADO')) return '';
  const faltas = participantesIncompletos(cf);
  if (!faltas.length) return '';
  return `--- NOME INCOMPLETO NA PROPOSTA (a análise de crédito depende disto) ---
A proposta veio com nome incompleto/abreviado: ${faltas.map((f) => `participante ${f.n} = "${f.nome}"`).join('; ')}. Sem o nome completo, igual ao do documento (RG ou CNH), os bancos não localizam a pessoa — a análise de crédito só sai certa com esse nome${ni.status === 'ASKED' ? ', e o CRM já pediu o nome completo ao cliente' : ''}.
- ${ni.status === 'ASKED' ? 'Se o cliente ainda não mandou, peça de novo de forma simples' : 'Peça ao cliente'}: o nome completo, igual está no documento. Não peça foto de documento por isso e não fale de resultado de crédito.
- Quando ele mandar o nome completo (nome e todos os sobrenomes, sem abreviação): grave em "extractedFields" o campo "participante_${faltas[0].n}"${faltas.length > 1 ? ' (e "participante_2" pro segundo)' : ''} com o nome COMPLETO, em maiúsculas, e diga em uma frase que agora a análise de crédito segue (sem prazo).
- Se ele mandar de novo abreviado ou só o primeiro nome, explique que precisa ser igual ao documento e peça outra vez.
- Só se ele AFIRMAR que no documento o nome é exatamente esse: grave "nome_completo_confirmado": "Sim".`;
}

/** A IA gravou o nome (ou a confirmação) enquanto o pedido estava aberto. true = tratou aqui. */
export async function nomeIncompletoRespondido(accountId: string, leadId: string, campos: string[]): Promise<boolean> {
  if (!campos.some((k) => k === 'participante_1' || k === 'participante_2' || k === 'nome_completo_confirmado')) return false;
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const cf = (l?.customFields || {}) as Cf;
  const ni = cf._nomeIncompleto as { status?: string; at?: string } | undefined;
  if (!l || !ni || (ni.status !== 'ASKED' && ni.status !== 'AVISADO')) return false;
  const faltas = participantesIncompletos(cf);
  const confirmou = campos.includes('nome_completo_confirmado') && /^s/i.test(String(cf.nome_completo_confirmado || ''));
  if (faltas.length && !confirmou) return false; // continua incompleto: a IA pede de novo
  const agora = new Date().toISOString();
  if (faltas.length) await salva(leadId, { ...ni, status: 'CONFIRMADO', confirmedAt: agora, nomes: Object.fromEntries(faltas.map((f) => [String(f.n), f.nome])) });
  else await salva(leadId, { ...ni, status: 'RESOLVIDO', resolvedAt: agora });
  // Só conta rodada feita DEPOIS do pedido (a equipe rodou à mão enquanto o nome não chegava): análise antiga do card não é motivo pra refazer — quem começa é a análise automática.
  const jaRodou = (await prisma.creditAnalysis.count({ where: { leadId, dryRun: false, createdAt: { gt: ni.at ? new Date(ni.at) : new Date() } } })) > 0;
  if (!jaRodou) {
    await note(leadId, faltas.length ? `✅ O cliente afirmou que o nome do documento é esse mesmo (${faltas.map((f) => `"${f.nome}"`).join(' e ')}): a análise de crédito segue.` : '✅ O cliente mandou o nome completo e o card foi corrigido: a análise de crédito começa agora.');
    return true;
  }
  if (faltas.length) { await note(leadId, `✅ O cliente afirmou que o nome do documento é esse mesmo (${faltas.map((f) => `"${f.nome}"`).join(' e ')}): nada a refazer.`); return true; }
  // A análise já tinha rodado com o nome incompleto: refaz em todos os bancos com o nome certo.
  const { createRequests, bancosDoProduto } = require('./credit-analysis.service') as typeof import('./credit-analysis.service');
  const r = await createRequests(prisma as any, { accountId, leadIds: [leadId], banks: await bancosDoProduto(prisma as any, leadId), dryRun: false, kind: 'RUN', source: 'AI', force: true, queueIfBusy: true });
  await note(leadId, `🔁 O cliente mandou o nome completo (a análise tinha rodado com o nome incompleto): o card foi corrigido e refiz a análise em ${r.created} banco(s).`);
  push(accountId, '🔁 Nome completo recebido', `${l.name}: análise refeita nos bancos com o nome certo`, leadId);
  return true;
}
