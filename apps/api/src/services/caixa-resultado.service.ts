import { prisma } from '../lib/prisma';

/* Resultado da Avaliação de Risco da CAIXA. A tela do envio só dá o número da proposta (Fabio 01/11: "O RESULTADO NÃO SAI NESSA TELA, PRECISA CONSULTAR
 * DEPOIS" e "PARA CONSULTAR O RESULTADO, PRECISA VOLTAR NO MENU E IR EM FORMULÁRIOS ENVIADOS"): Consulta de Formulários Enviados → Buscar por CPF →
 * Consultar. A extensão Cadastro Caixa consulta pelo CPF do tomador e devolve a tela. 1ª fase: só sob pedido, e a tela vira nota pra mapear onde fica o
 * resultado. Fica em _caixaResultado, fora de _caixaCadastro (a fila do cadastro regrava aquela chave inteira). */

type Cf = Record<string, any>;
const LEASE_MS = 10 * 60_000;

async function salvar(leadId: string, mut: (r: Cf) => void): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const r: Cf = { ...(((l?.customFields || {}) as Cf)._caixaResultado || {}) };
  mut(r);
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaResultado}', ${JSON.stringify(r)}::jsonb, true) WHERE id = ${leadId}`;
}

/** Tomador da avaliação = 1º participante da ficha de cadastro. */
function tomador(cf: Cf): { nome: string; cpf: string } | null {
  // O tomador da avaliação é quem tem a MAIOR renda (Fabio 02/11) — o mesmo critério do envio (participantesDaAvaliacao), não o 1º da ficha.
  const cc = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
  const t = cc.participantesDaAvaliacao(cc.participantesDa(cf)).tomador;
  if (t) return { nome: String(t.nome || ''), cpf: String(t.cpf || '').replace(/\D/g, '') };
  const ps: any[] = Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : [];
  const p = ps.find((x, i) => (Number(x?.ordem) || i + 1) === 1);
  return p ? { nome: String(p.nome || ''), cpf: String(p.cpf || '').replace(/\D/g, '') } : null;
}

/** Botão/pedido "consultar o resultado": só pra avaliação já ENVIADA à CAIXA. Erro em texto quando não dá. */
export async function pedirConsultaResultado(accountId: string, leadId: string, por: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  if (!/^ENVIADA/i.test(String(cf._caixaCadastro?.avaliacao?.status || ''))) return 'A Avaliação de Risco deste card ainda não foi enviada à CAIXA';
  if (tomador(cf)?.cpf.length !== 11) return 'Sem o CPF do tomador na ficha de cadastro';
  await salvar(leadId, (r) => { r.status = 'FILA'; r.pedidoEm = new Date().toISOString(); r.por = por; r.tentativas = 0; delete r.inicio; });
  return null;
}

/** Próxima consulta de resultado pra extensão (a fila da CAIXA chama quando não há consulta/cadastro/avaliação). FILA, ou RODANDO largada há mais de 10 min
 *  (até 3 tentativas). */
export async function proximaConsultaResultado(accountId: string) {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaResultado'->>'status' IN ('FILA', 'RODANDO')
    ORDER BY "customFields"->'_caixaResultado'->>'pedidoEm' ASC LIMIT 10`;
  for (const { id } of ids) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { name: true, customFields: true } });
    const cf = (l?.customFields || {}) as Cf;
    const r = cf._caixaResultado || {};
    if (r.status === 'RODANDO' && !(r.inicio && Date.now() - Date.parse(r.inicio) > LEASE_MS && (r.tentativas || 0) < 3)) continue;
    const t = tomador(cf);
    if (!t || t.cpf.length !== 11) continue;
    await salvar(id, (x) => { x.status = 'RODANDO'; x.inicio = new Date().toISOString(); x.tentativas = (x.tentativas || 0) + 1; });
    return { tipo: 'consultarAvaliacao', leadId: id, leadName: l!.name, ordem: 1, nome: t.nome, cpf: t.cpf, produto: String(cf._caixaCadastro?.avaliacao?.produto || '') }; // produto: a extensão lê a linha dele (uma avaliação lista vários produtos)
  }
  return null;
}

/** Tela da Consulta de Formulários Enviados que a extensão devolveu: guarda, anota no card e avisa por push. */
export async function gravarConsultaResultado(accountId: string, leadId: string, r: { status: string; texto: string }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!l) return;
  await salvar(leadId, (x) => { x.status = r.status; x.fim = new Date().toISOString(); x.ultimaTela = String(r.texto || '').slice(0, 3000); });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Resultado da Avaliação de Risco CAIXA (Formulários Enviados): ${r.status}\n\n${String(r.texto || '').slice(0, 3500)}` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  // "2ª autorização do PV" (Fabio 01/11): o cliente rodou crédito mais de uma vez, com correspondentes diferentes — o colaborador pede a autorização à agência.
  if (PV_RE.test(`${r.status}\n${r.texto}`)) {
    // 1ª ou 2ª autorização, com o motivo da CAIXA ("Grupo Fam. Alt.", "Renda Alterada" — Fabio 02/11: a renda/o grupo familiar mudou desde a avaliação em outro correspondente).
    const motivoPv = ((/([^\n]*autoriza[cç][aã]o do PV[^\n]*)/i.exec(`${r.status}\n${r.texto}`) || [])[1] || '').replace(/^.*?(RESULTADO:[^—]*—\s*)/, '').trim();
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ A CAIXA pede AUTORIZAÇÃO DO PV (agência)${motivoPv ? ` — "${motivoPv}"` : ''}: o cliente já rodou crédito em outro correspondente e os dados mudaram desde então (renda/grupo familiar) — não é nome sujo. Solicite a autorização à agência para seguir com a avaliação. O CRM avisa o cliente sozinho.` } }).catch(() => {});
    sendPushToAccount(accountId, { title: `⚠️ ${l.name}: pedir autorização à agência (PV)`, body: (motivoPv || 'A CAIXA pede a autorização do PV').slice(0, 120), leadId }).catch(() => {});
    // Aviso ao cliente (Fabio 01/11: "Sim, mandar sozinho"), uma vez por proposta.
    const proposta = (/C[oó]digo Proposta\s*\t?\s*(\d{5,})/i.exec(r.texto) || /Proposta\s+(\d{5,})/i.exec(r.texto) || [])[1] || '?';
    const atual = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields as Cf | null)?._caixaResultado?.pvAviso;
    if (atual?.proposta !== proposta) {
      await salvar(leadId, (x) => { x.pvAviso = { status: 'PENDING', proposta, at: new Date().toISOString() }; });
      await avisarPvCliente(accountId, leadId).catch((e) => console.error('[CAIXA PV] aviso ao cliente:', e?.message));
    }
    return;
  }
  sendPushToAccount(accountId, { title: `🏦 ${l.name}: resultado da avaliação CAIXA`, body: r.status.slice(0, 120), leadId }).catch(() => {});
}

// ─── 2ª autorização do PV → aviso ao cliente (Fabio 01/11, Jézer: "o dele não foi reprovado por nome sujo, foi apenas uma alteração no cadastro. Precisa
// perguntar a ele se ele encaminhou essa documentação a outro correspondente — essa informação é apenas informativa para nós — explica a ele também que o
// cadastro dele bloqueou porque ele rodou em outro correspondente e isso impacta na aprovação e pode acabar bloqueando o cadastro dele na CAIXA"; depois
// "Sim, mandar sozinho"). 07h–21h; conversa fechada → template de atualização e o texto sai quando ele responder (poller); 48 h sem resposta → equipe.
const PV_RE = /autoriza[cç][aã]o do PV/i;
const PV_TEMPLATE = 'atualizacao_processo_credito';

export function textoPv(saudacao: string): string {
  return `Oi${saudacao ? ` ${saudacao}` : ''}, tudo bem? Uma atualização sobre a CAIXA: o seu cadastro lá ficou bloqueado porque consta que o seu crédito também foi rodado por outro correspondente. Isso impacta na aprovação e pode acabar bloqueando o seu cadastro na CAIXA. Só pra nossa informação: você chegou a encaminhar a sua documentação pra outro correspondente?`;
}

export async function avisarPvCliente(accountId: string, leadId: string, io?: any): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const pv = cf._caixaResultado?.pvAviso as { status?: string; templateAt?: string } | undefined;
  if (!lead || !pv || (pv.status !== 'PENDING' && pv.status !== 'TEMPLATE') || cf._autoPaused) return;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const saudacao = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || '';
  const texto = textoPv(saudacao);
  const nota = (content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  const msg = require('./message.service') as typeof import('./message.service');
  if (await whatsappWindowOpen(leadId)) {
    const env = await msg.sendOutboundWhatsApp({ accountId, leadId, content: texto, io });
    if (!env.success) return; // tenta no próximo minuto
    await salvar(leadId, (x) => { x.pvAviso = { ...(x.pvAviso || {}), status: 'ENVIADO', enviadoAt: new Date().toISOString() }; });
    await nota('📨 Avisei o cliente que o cadastro na CAIXA bloqueou porque o crédito também foi rodado por outro correspondente (impacta a aprovação e pode bloquear o cadastro) e perguntei, só pra nossa informação, se ele encaminhou a documentação a outro correspondente.');
    return;
  }
  if (pv.status === 'PENDING') {
    const t = await msg.sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: PV_TEMPLATE, language: 'pt_BR', bodyParams: [saudacao || 'cliente'], previewText: `Oi ${saudacao || 'cliente'}, tudo bem? Temos uma atualização sobre o seu processo de crédito com garantia de imóvel. Responda esta mensagem para que a gente possa te passar os detalhes.`, io });
    if (!t.success) {
      await salvar(leadId, (x) => { x.pvAviso = { ...(x.pvAviso || {}), status: 'FALHOU' }; });
      await nota(`⚠️ Autorização do PV: a conversa está fechada e o template de atualização não saiu (${t.error}). Avise você o cliente. Texto pronto:\n“${texto}”`);
      sendPushToAccount(accountId, { title: `⚠️ ${lead.name}: avisar o cliente (PV)`, body: 'Conversa fechada e o template não saiu: texto pronto na anotação.', leadId }).catch(() => {});
      return;
    }
    await salvar(leadId, (x) => { x.pvAviso = { ...(x.pvAviso || {}), status: 'TEMPLATE', templateAt: new Date().toISOString() }; });
    await nota('📨 Autorização do PV: conversa fechada — mandei o template de atualização. O aviso ao cliente sai quando ele responder.');
    return;
  }
  if (pv.templateAt && Date.now() - Date.parse(pv.templateAt) > 48 * 3600_000) {
    await salvar(leadId, (x) => { x.pvAviso = { ...(x.pvAviso || {}), status: 'FALHOU' }; });
    await nota(`⚠️ Autorização do PV: o cliente não respondeu ao template em 48 h. Avise você. Texto pronto:\n“${texto}”`);
    sendPushToAccount(accountId, { title: `⚠️ ${lead.name}: avisar o cliente (PV)`, body: 'Sem resposta em 48 h: texto pronto na anotação.', leadId }).catch(() => {});
  }
}

/** Poller (vai junto do das ocorrências, a cada minuto): aviso de PV que ficou pra depois. */
export async function processPvAvisos(accountId: string, io?: any): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaResultado'->'pvAviso'->>'status' IN ('PENDING', 'TEMPLATE') LIMIT 20`;
  for (const { id } of ids) await avisarPvCliente(accountId, id, io).catch((e) => console.error('[CAIXA PV]', e?.message));
}

/** A equipe põe o aviso do PV no fluxo automático (Fabio 01/11, Jézer: a mensagem manual falhou com a conversa fechada) — template agora, texto quando
 *  ele responder. Devolve o erro, ou null. */
export async function pedirAvisoPv(accountId: string, leadId: string, io?: any): Promise<string | null> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!lead) return 'Lead não encontrado';
  const cr = ((lead.customFields || {}) as Cf)._caixaResultado || {};
  if (!PV_RE.test(`${cr.status || ''}\n${cr.ultimaTela || ''}`)) return 'O último resultado da CAIXA não pede a autorização do PV';
  if (['ENVIADO', 'TEMPLATE'].includes(cr.pvAviso?.status)) return `O aviso já está ${cr.pvAviso.status === 'ENVIADO' ? 'enviado' : 'esperando a resposta do template'}`;
  const proposta = (/C[oó]digo Proposta\s*\t?\s*(\d{5,})/i.exec(cr.ultimaTela || '') || [])[1] || cr.pvAviso?.proposta || '?';
  await salvar(leadId, (x) => { x.pvAviso = { status: 'PENDING', proposta, at: new Date().toISOString() }; });
  await avisarPvCliente(accountId, leadId, io);
  return null;
}

/** Bloco pra IA da conversa enquanto o aviso do PV está em aberto (3 dias depois do envio). '' se não houver. Pura. */
export function aiPvContext(cf: Cf): string {
  const pv = cf._caixaResultado?.pvAviso as { status?: string; enviadoAt?: string } | undefined;
  if (pv?.status === 'TEMPLATE') {
    return `--- CADASTRO DA CAIXA BLOQUEADO (aviso ainda não enviado) ---
A conversa estava fechada e o CRM chamou o cliente pelo template de atualização: assim que ele responder, o CRM manda SOZINHO, logo em seguida, a atualização sobre a CAIXA. Agora responda só UMA frase curta de retorno (ex.: "Oi, tudo bem? Já te explico aqui embaixo."), sem falar da CAIXA.`;
  }
  if (pv?.status !== 'ENVIADO' || !pv.enviadoAt || Date.now() - Date.parse(pv.enviadoAt) > 3 * 86_400_000) return '';
  return `--- CADASTRO DA CAIXA BLOQUEADO (aviso enviado ao cliente; Fabio 01/11) ---
O CRM avisou o cliente que o cadastro na CAIXA ficou bloqueado porque o crédito também foi rodado por outro correspondente (a CAIXA pede a autorização da agência), que isso impacta na aprovação e pode bloquear o cadastro, e perguntou — só pra nossa informação — se ele encaminhou a documentação a outro correspondente. NÃO é restrição no nome nem reprovação: nunca diga isso.
Quando ele responder a essa pergunta: agradeça em 1 frase e diga que a equipe está cuidando da autorização junto à CAIXA. Não prometa prazo nem aprovação, não peça documento por isso e não critique o outro correspondente.`;
}
