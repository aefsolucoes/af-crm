import { prisma } from '../lib/prisma';

/* Restrição no nome na consulta da CAIXA (Fabio 01/11): "Sempre que fizer a consulta e mostrar que o cliente possui ocorrências, solicite ao cliente que baixe
 * o app do SERASA e do SCPC e também veja se há algum protesto junto ao https://www.pesquisaprotesto.com.br/ … caso o cliente diga que não há nenhuma
 * ocorrência no nome dele, diga que irá prosseguir com a análise e caso não tenha encaminhado a documentação, solicite."
 * Oportunidades de Negócios com "Pesquisa Cadastral: Constam Ocorrências" (todos os participantes consultados) → o CRM manda a orientação (07h–21h; conversa
 * fechada → template de atualização e a orientação sai quando ele responder) e a IA trata a resposta pelo bloco aiOcorrenciasContext ("ocorrencias_cliente":
 * sem | com). Estado em _ocorrencias; uma vez por consulta (consultadoEm). */

type Cf = Record<string, any>;
type Oc = { status: 'PENDING' | 'TEMPLATE' | 'ASKED' | 'SEM' | 'COM' | 'EQUIPE'; consultadoEm?: string; nomes?: string[]; titular?: boolean; at?: string; templateAt?: string; askedAt?: string; respondidoAt?: string };
const WAIT_MAX_MS = 48 * 3600_000;
const OCORRENCIA_RE = /constam ocorr[eê]ncias/i;
const TEMPLATE = 'atualizacao_processo_credito';

const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => { try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body, leadId }).catch(() => {}); } catch { /* aviso */ } };

async function salva(leadId: string, patch: Partial<Oc>): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const oc = { ...(((l?.customFields || {}) as Cf)._ocorrencias || {}), ...patch };
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_ocorrencias}', ${JSON.stringify(oc)}::jsonb, true) WHERE id = ${leadId}`;
}

/** Participantes com "Constam Ocorrências" na última consulta de cada um. Pura. */
export function comOcorrencia(cf: Cf): { nomes: string[]; titular: boolean } {
  const cons = (cf._caixaCadastro?.consultas || {}) as Record<string, any>;
  const ps: any[] = Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : [];
  const nomes: string[] = [];
  let titular = false;
  for (const [ordem, c] of Object.entries(cons)) {
    if (!OCORRENCIA_RE.test(String(c?.texto || ''))) continue;
    const p = ps.find((x, i) => (Number(x?.ordem) || i + 1) === Number(ordem));
    nomes.push(String(p?.nome || `${ordem}º participante`));
    if (Number(ordem) === 1) titular = true;
  }
  return { nomes, titular };
}

const primeiroNome = (s: string) => { const n = String(s || '').trim().split(/\s+/)[0] || ''; return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase(); };

/** Orientação ao cliente (fontes: app Serasa "Dívidas e pendências", app Consumidor Positivo/SCPC "Minhas dívidas negativadas", pesquisaprotesto.com.br pelo CPF). Pura. */
export function textoOrientacao(saudacao: string, oc: { nomes: string[]; titular: boolean }, quemFalaEOTitular: boolean): string {
  const proprio = oc.nomes.length === 1 && oc.titular && quemFalaEOTitular;
  const quem = proprio ? 'no seu nome' : `no nome de ${oc.nomes.map(primeiroNome).join(' e ')}`;
  const cpf = proprio ? 'o seu CPF' : `o CPF de ${oc.nomes.map(primeiroNome).join(' e de ')}`;
  return `${saudacao ? `${saudacao}, n` : 'N'}a consulta da CAIXA apareceu uma ocorrência (restrição) ${quem}. Pra seguir, confere pra mim, por favor:
1) App da *Serasa* ("Serasa: Consulta CPF e Score"): entre com ${cpf} e veja em "Dívidas e pendências";
2) App do *SCPC* (Consumidor Positivo, da Boa Vista): entre com ${cpf} e veja em "Minhas dívidas negativadas";
3) Protesto em cartório: no site https://www.pesquisaprotesto.com.br, digite ${cpf} e consulte.
Consultar o próprio CPF é gratuito. Depois me conta o que apareceu. 🙂`;
}

/** Depois de cada consulta de Oportunidades de Negócios (rota POST /caixa-cadastro/:id/consulta): todos consultados e alguém com ocorrência → orienta o cliente. */
export async function verificarOcorrencias(accountId: string, leadId: string, io?: any): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return;
  const cf = (l.customFields || {}) as Cf;
  const consultadoEm = cf._caixaCadastro?.consultadoEm as string | undefined;
  if (!consultadoEm || Date.now() - Date.parse(consultadoEm) > 3600_000) return; // só a consulta que acabou de fechar (todos os participantes)
  if ((cf._ocorrencias as Oc | undefined)?.consultadoEm === consultadoEm) return; // esta consulta já foi tratada
  const oc = comOcorrencia(cf);
  if (!oc.nomes.length) return;
  await salva(leadId, { status: 'PENDING', consultadoEm, nomes: oc.nomes, titular: oc.titular, at: new Date().toISOString(), templateAt: undefined, askedAt: undefined, respondidoAt: undefined });
  await note(leadId, `⚠️ CAIXA: constam ocorrências no nome de ${oc.nomes.join(' e ')} (Oportunidades de Negócios). Vou pedir ao cliente que confira no app da Serasa, no app do SCPC (Consumidor Positivo) e no pesquisaprotesto.com.br (Fabio 01/11).`);
  push(accountId, `⚠️ ${oc.nomes.map(primeiroNome).join(' e ')}: ocorrência no nome (CAIXA)`, 'O CRM vai pedir ao cliente que confira Serasa, SCPC e protesto.', leadId);
  await enviarOrientacao(accountId, leadId, io).catch((e) => console.error('[Ocorrências] envio:', e?.message));
}

/** Manda a orientação ao cliente (07h–21h). Conversa fechada: template de atualização; quando ele responder, a orientação sai no próximo minuto. */
export async function enviarOrientacao(accountId: string, leadId: string, io?: any): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, aiAutoReplyActive: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const oc = cf._ocorrencias as Oc | undefined;
  if (!lead || !oc || (oc.status !== 'PENDING' && oc.status !== 'TEMPLATE') || cf._autoPaused) return;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const saudacao = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || '';
  const texto = textoOrientacao(saudacao, { nomes: oc.nomes || [], titular: !!oc.titular }, !String(cf.falando_com || '').trim());
  if (!lead.aiAutoReplyActive) {
    await salva(leadId, { status: 'EQUIPE', at: new Date().toISOString() });
    await note(leadId, `⚠️ Ocorrência no nome (CAIXA) e IA do card desligada: mande você a orientação ao cliente. Texto pronto:\n“${texto}”`);
    push(accountId, `⚠️ ${lead.name}: ocorrência no nome (CAIXA)`, 'IA desligada: mande a orientação Serasa/SCPC/protesto (texto na anotação).', leadId);
    return;
  }
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  const msg = require('./message.service') as typeof import('./message.service');
  if (await whatsappWindowOpen(leadId)) {
    const env = await msg.sendOutboundWhatsApp({ accountId, leadId, content: texto, io });
    if (!env.success) return; // tenta no próximo minuto
    await salva(leadId, { status: 'ASKED', askedAt: new Date().toISOString() });
    await note(leadId, '📨 Mandei ao cliente a orientação pra conferir o nome no app da Serasa, no app do SCPC (Consumidor Positivo) e no pesquisaprotesto.com.br. A IA cuida da resposta: sem ocorrência → segue a análise; com ocorrência → pergunta pra equipe.');
    return;
  }
  if (oc.status === 'PENDING') {
    const t = await msg.sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: TEMPLATE, language: 'pt_BR', bodyParams: [saudacao || 'cliente'], previewText: `Oi ${saudacao || 'cliente'}, tudo bem? Temos uma atualização sobre o seu processo de crédito com garantia de imóvel. Responda esta mensagem para que a gente possa te passar os detalhes.`, io });
    if (!t.success) {
      await salva(leadId, { status: 'EQUIPE', at: new Date().toISOString() });
      await note(leadId, `⚠️ Ocorrência no nome (CAIXA): a conversa está fechada e o template de atualização não saiu (${t.error}). Mande você a orientação ao cliente. Texto pronto:\n“${texto}”`);
      push(accountId, `⚠️ ${lead.name}: ocorrência no nome (CAIXA)`, 'Conversa fechada e o template não saiu: mande a orientação (texto na anotação).', leadId);
      return;
    }
    await salva(leadId, { status: 'TEMPLATE', templateAt: new Date().toISOString() });
    await note(leadId, '📨 Ocorrência no nome (CAIXA): conversa fechada — mandei o template de atualização. A orientação Serasa/SCPC/protesto sai quando o cliente responder.');
    return;
  }
  if (oc.templateAt && Date.now() - Date.parse(oc.templateAt) > WAIT_MAX_MS) {
    await salva(leadId, { status: 'EQUIPE', at: new Date().toISOString() });
    await note(leadId, `⚠️ Ocorrência no nome (CAIXA): o cliente não respondeu ao template em 48 h. Fale você com ele. Texto pronto:\n“${texto}”`);
    push(accountId, `⚠️ ${lead.name}: ocorrência no nome sem resposta`, 'O cliente não respondeu em 48 h: fale com ele (texto na anotação).', leadId);
  }
}

/** Poller (1 min): orientação que ficou pra depois (fora do horário ou esperando a resposta ao template). */
export async function processOcorrencias(accountId: string, io?: any): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_ocorrencias'->>'status' IN ('PENDING', 'TEMPLATE') LIMIT 20`;
  for (const { id } of ids) await enviarOrientacao(accountId, id, io).catch((e) => console.error('[Ocorrências]', e?.message));
}

/** Bloco pro prompt da IA da conversa enquanto a orientação está em aberto. '' se não houver. */
export async function aiOcorrenciasContext(leadId: string): Promise<string> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (l?.customFields || {}) as Cf;
  const oc = cf._ocorrencias as Oc | undefined;
  if (!oc || (oc.status !== 'TEMPLATE' && oc.status !== 'ASKED')) return '';
  const nomes = (oc.nomes || []).join(' e ') || 'do cliente';
  if (oc.status === 'TEMPLATE') {
    return `--- RESTRIÇÃO NO NOME (CAIXA — orientação ainda não enviada) ---
Na consulta da CAIXA apareceu ocorrência (restrição) no nome de ${nomes}. A conversa estava fechada e o CRM chamou o cliente pelo template de atualização: assim que ele responder, o CRM manda SOZINHO, logo em seguida, a orientação (conferir no app da Serasa, no app do SCPC e no pesquisaprotesto.com.br). Agora responda só UMA frase curta de retorno (ex.: "Oi, tudo bem? Já te explico aqui embaixo."), sem falar da restrição nem dos apps.`;
  }
  const docs = cf._caixaDocsAt ? 'O card JÁ TEM a documentação da CAIXA (não peça de novo).' : 'O card ainda NÃO tem a documentação da CAIXA registrada: confira o bloco DOCUMENTOS DESTE CLIENTE (sem esse bloco = nada recebido).';
  return `--- RESTRIÇÃO NO NOME (CAIXA — orientação já enviada ao cliente; Fabio 01/11) ---
Na consulta da CAIXA apareceu ocorrência (restrição) no nome de ${nomes}. Isso VALE MAIS que o cliente ter dito antes que o nome estava limpo: nunca diga que o nome está limpo. O CRM já pediu que ele conferisse: (1) app da Serasa ("Serasa: Consulta CPF e Score") → "Dívidas e pendências"; (2) app do SCPC (Consumidor Positivo, da Boa Vista) → "Minhas dívidas negativadas"; (3) protesto em cartório no site https://www.pesquisaprotesto.com.br, digitando o CPF. Consultar o próprio CPF é gratuito. ${docs}
Quando o cliente responder:
- Disse que conferiu e NÃO há nenhuma ocorrência/restrição/dívida/protesto: diga que vamos PROSSEGUIR COM A ANÁLISE e marque "extractedFields": {"ocorrencias_cliente": "sem"}. Se a documentação ainda não chegou, peça na MESMA mensagem só o que falta: RG ou CNH, CPF, comprovante de endereço, último contracheque (ou outro comprovante de renda), certidão de estado civil e, se tiver cônjuge, RG e CPF dele.
- Disse que HÁ ocorrência/restrição/dívida/protesto (ou que está negociando/resolvendo): agradeça por conferir, não prometa nada nem diga que a análise segue, marque "extractedFields": {"ocorrencias_cliente": "com"} e use "askTeam": "Cliente confirmou restrição no nome (Serasa/SCPC/protesto): qual o próximo passo?".
- Dúvida de COMO consultar (não achou o app, quer o link, não consegue entrar): explique em 1–2 frases o passo do item que ele perguntou (nos apps: baixar, entrar ou se cadastrar com o próprio CPF e senha; no site: digitar o CPF e consultar). Não marque "ocorrencias_cliente".
- Ainda não conferiu ou vai ver depois: resposta curta, sem pressionar. Não marque "ocorrencias_cliente".
Não fale em score nem em reprovação.`;
}

/** A IA gravou "ocorrencias_cliente" (resposta à orientação): registra e avisa a equipe. */
export async function ocorrenciasRespondidas(accountId: string, leadId: string, patch: Record<string, unknown>): Promise<void> {
  const v = String(patch.ocorrencias_cliente ?? '').trim().toLowerCase();
  if (v !== 'sem' && v !== 'com') return;
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const oc = ((l?.customFields || {}) as Cf)._ocorrencias as Oc | undefined;
  if (!l || !oc || !['ASKED', 'TEMPLATE', 'EQUIPE'].includes(oc.status)) return;
  await salva(leadId, { status: v === 'sem' ? 'SEM' : 'COM', respondidoAt: new Date().toISOString() });
  if (v === 'sem') {
    await note(leadId, '✅ O cliente conferiu Serasa, SCPC e protesto e diz que NÃO há ocorrência no nome: a IA disse que a análise segue (e pediu a documentação que faltava, se faltava).');
    push(accountId, `✅ ${l.name}: cliente diz que o nome está limpo`, 'Conferiu Serasa/SCPC/protesto — a análise segue.', leadId);
  } else {
    await note(leadId, '⚠️ O cliente confirmou ocorrência no nome (Serasa/SCPC/protesto). A IA perguntou pra equipe o próximo passo (balão "Dúvidas da IA").');
    push(accountId, `⚠️ ${l.name}: cliente confirmou restrição no nome`, 'Veja o próximo passo no balão "Dúvidas da IA".', leadId);
  }
}
