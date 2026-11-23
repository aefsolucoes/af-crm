/* ── DESBLOQUEIO DO CADASTRO CAIXA — cliente atendido por OUTRO convênio (Fabio 18/11, Lucas Henrique: "precisamos cancelar e refazer pelo nosso convênio;
 * para isso o cliente encaminha um código token para conseguirmos cancelar e liberar o cadastro para nós").
 * No Caixa Aqui: Cadastro de Clientes → CPF → Consultar → aviso "Este cliente já está sendo atendido por outro convênio. Deseja cancelar avaliações de risco ou
 * propostas válidas a pedido do cliente?" → SIM → "Cancelamento de Avaliações e Propostas via Token" (celular cadastrado, só os 4 últimos dígitos) → "Enviar Token"
 * → o cliente recebe o token por SMS, repassa pra gente e ele é digitado na tela seguinte → o cadastro é liberado.
 * Trabalho da extensão "Cadastro CAIXA" pela mesma fila (`tipo: 'desbloquear'`); estado em `_caixaDesbloqueio` (fora do _caixaCadastro, que a fila regrava). */
import { prisma } from '../lib/prisma';
import { participantesDa } from './caixa-cadastro.service';

type Cf = Record<string, any>;
const LEASE_MS = 10 * 60_000;
const mascaraCpf = (s: string) => String(s || '').replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, '[CPF]').replace(/\b\d{11}\b/g, '[CPF]');

async function salvarDesbloqueio(leadId: string, mut: (d: Cf) => void): Promise<Cf> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const d: Cf = { ...(((l?.customFields || {}) as Cf)._caixaDesbloqueio || {}) };
  mut(d);
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaDesbloqueio}', ${JSON.stringify(d)}::jsonb, true) WHERE id = ${leadId}`;
  return d;
}

/** Final do celular do card (4 dígitos) — a tela do token da CAIXA mostra só "Celular (XX) - xxxxx - 8584"; com mais de um número, a extensão marca o que bate. */
function finaisDoCard(cf: Cf, phones: (string | null | undefined)[]): string[] {
  const nums = [...phones, cf.telefone_1, cf.telefone, cf.celular_1].map((x) => String(x || '').replace(/\D/g, '')).filter((x) => x.length >= 8);
  return [...new Set(nums.map((x) => x.slice(-4)))];
}

/** Pede à extensão o caminho do desbloqueio. modo `ver`: para no aviso do outro convênio; `ate` (padrão): responde SIM, marca o celular na tela do token e para;
 *  `enviar`: clica "Enviar Token" (o SMS da CAIXA sai pro cliente) — só depois de o cliente concordar em seguir com a gente. */
export async function pedirDesbloqueio(accountId: string, leadId: string, por: string, opts: { modo?: 'ver' | 'ate' | 'enviar'; seNaoEnviado?: boolean; perguntar?: boolean } = {}): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { id: true, customFields: true } });
  if (!l) return 'Card não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const p1 = participantesDa(cf).find((x) => x.ordem === 1);
  if (!p1 || String(p1.cpf || '').length !== 11) return 'O card não tem o CPF do 1º participante';
  const atual = cf._caixaDesbloqueio as Cf | undefined;
  if (atual?.status === 'RODANDO' && atual.inicio && Date.now() - Date.parse(atual.inicio) < LEASE_MS) return 'A extensão já está no desbloqueio deste cliente';
  // Pedido da IA (o cliente disse "sim"): código enviado há menos de 30 min não é reenviado — o anterior ainda vale.
  if (opts.seNaoEnviado && (atual?.enviadoEm && Date.now() - Date.parse(atual.enviadoEm) < 30 * 60_000 || (atual?.modo === 'enviar' && /^(FILA|RODANDO)$/.test(String(atual.status || ''))))) return 'O código já foi pedido há pouco';
  const modo = opts.modo === 'ver' || opts.modo === 'enviar' ? opts.modo : 'ate';
  await salvarDesbloqueio(leadId, (d) => {
    for (const k of Object.keys(d)) if (!['historico', 'telefones', 'perguntadoEm', 'perguntadoPor'].includes(k)) delete d[k];
    Object.assign(d, { status: 'FILA', modo, pedidoEm: new Date().toISOString(), por, tentativas: 0, ...(opts.perguntar ? { perguntarAuto: true } : {}) });
  });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔓 CAIXA — desbloqueio do cadastro (cliente em outro convênio) na fila da extensão (${por}): ${modo === 'enviar' ? 'ela clica "Enviar Token" — a CAIXA manda o código por SMS pro celular cadastrado do cliente' : modo === 'ate' ? 'ela responde SIM ao aviso, marca o celular na tela do token e PARA antes do "Enviar Token"' : 'ela abre o cadastro e para no aviso do outro convênio'}.` } }).catch(() => {});
  return null;
}

/** Próximo desbloqueio pra extensão (um por vez). */
export async function proximoDesbloqueio(accountId: string): Promise<any | null> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false
      AND "customFields"->'_caixaDesbloqueio'->>'status' IN ('FILA', 'RODANDO')
    ORDER BY "customFields"->'_caixaDesbloqueio'->>'pedidoEm' ASC LIMIT 5`;
  for (const { id } of ids) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, customFields: true, contact: { select: { phone: true, whatsappPhone: true } } } });
    const cf = (l?.customFields || {}) as Cf;
    const d = (cf._caixaDesbloqueio || {}) as Cf;
    if (d.status === 'RODANDO') {
      if (d.inicio && Date.now() - Date.parse(d.inicio) < LEASE_MS) return null; // em andamento
      if ((d.tentativas || 0) >= 2) {
        await salvarDesbloqueio(id, (x) => { x.status = 'ERRO: a extensão largou no meio (2 tentativas)'; x.fim = new Date().toISOString(); });
        await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: '⚠️ CAIXA — desbloqueio do cadastro: a extensão largou no meio duas vezes. Confira no Caixa Aqui (Cadastro de Clientes).' } }).catch(() => {});
        continue;
      }
    }
    const p1 = participantesDa(cf).find((x) => x.ordem === 1);
    if (!p1 || String(p1.cpf || '').length !== 11) {
      await salvarDesbloqueio(id, (x) => { x.status = 'ERRO: sem CPF do 1º participante'; x.fim = new Date().toISOString(); });
      continue;
    }
    await salvarDesbloqueio(id, (x) => { x.status = 'RODANDO'; x.inicio = new Date().toISOString(); x.tentativas = (x.tentativas || 0) + 1; });
    // Identificação Positiva da CAIXA (18/11, Gilvano): primeiro nome do pai + número da identidade, da ficha.
    return { tipo: 'desbloquear', leadId: id, leadName: l!.name, ordem: 1, nome: p1.nome, cpf: p1.cpf, modo: d.modo === 'enviar' || d.modo === 'ver' ? d.modo : 'ate', finais: finaisDoCard(cf, [l!.contact?.whatsappPhone, l!.contact?.phone]), pai: p1.pai || null, identidade: p1.identidade?.numero || null };
  }
  return null;
}

/** O que a extensão viu/fez → card (estado + anotação) e push nos marcos. */
export async function gravarDesbloqueio(accountId: string, leadId: string, body: { status: string; texto?: string; telefones?: string[]; campos?: string[]; final?: boolean }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!l) return;
  const status = String(body.status || '').slice(0, 200);
  const texto = mascaraCpf(String(body.texto || '')).slice(0, 3000);
  const telefones = (body.telefones || []).map((x) => String(x).slice(0, 60)).slice(0, 6);
  const salvo = await salvarDesbloqueio(leadId, (d) => {
    d.status = status;
    d.atualizadoEm = new Date().toISOString();
    if (telefones.length) d.telefones = telefones;
    if (/^TOKEN ENVIADO/.test(status)) { d.enviadoEm = d.atualizadoEm; for (const k of ['tokenRecebido', 'tokenRecebidoEm', 'tokenEntregue', 'tokenEntregueEm', 'avisoTokenEm']) delete d[k]; } // código novo: o anterior não vale mais
    if (/^LIBERADO/.test(status)) d.liberadoEm = d.atualizadoEm;
    if (body.final !== false) d.fim = d.atualizadoEm;
    d.historico = [...(d.historico || []), { at: d.atualizadoEm, status }].slice(-12);
  });
  const campos = (body.campos || []).slice(0, 30).join(' · ');
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔓 CAIXA — desbloqueio do cadastro: ${status}${telefones.length ? `\nCelular(es) da CAIXA pro token: ${telefones.join('; ')}` : ''}\n\nTela do Caixa Aqui:\n${texto}${campos ? `\n\nBotões/campos: ${mascaraCpf(campos)}` : ''}` } }).catch(() => {});
  if (/^TOKEN ENVIADO/.test(status)) await avisarClienteDoCodigo(accountId, leadId).catch((e) => console.error('[CAIXA desbloqueio] aviso do código:', e?.message));
  // Fabio 18/11: "e cancela, roda o cadastro pelo nosso e faz o crédito" — liberado → cadastro pela ficha na fila (a análise de crédito continua só com o OK da equipe).
  if (/^LIBERADO/.test(status)) await cadastroDepoisDeLiberar(accountId, leadId).catch((e) => console.error('[CAIXA desbloqueio] cadastro depois de liberar:', e?.message));
  // Tudo automático (Fabio 18/11): chegou na tela do token pelo pedido automático → pergunta ao cliente; código expirado → pede outro sozinho.
  if (/^NA TELA DO TOKEN/.test(status) && salvo.perguntarAuto && !salvo.perguntadoEm) {
    const e = await perguntarAoCliente(accountId, leadId, 'CRM (automático)').catch((x) => x?.message || 'erro');
    if (e) await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ CAIXA — outro correspondente: a pergunta automática ao cliente não saiu (${e}).` } }).catch(() => {});
  }
  if (/^TOKEN RECUSADO/.test(status) && /expirad/i.test(texto)) await reenviarCodigo(accountId, leadId, 'a CAIXA disse que o código expirou').catch(() => {});
  if (/^(TOKEN ENVIADO|TOKEN RECUSADO|TOKEN DIGITADO|LIBERADO|SEM OUTRO CONVÊNIO|PAROU|ERRO)/.test(status)) {
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `🔓 ${l.name}: desbloqueio CAIXA`, body: `${status}${telefones.length ? ` — ${telefones[0]}` : ''}`.slice(0, 180), leadId }).catch(() => {});
  }
}

/** Linha da IA do cliente (Fabio 18/11, Lucas: "perguntar ao cliente se ele se recorda dessa aprovação e se podemos seguir por aqui, para isso precisa encaminhar o
 *  token"). Só com a consulta da CAIXA mostrando outro correspondente. Pura. */
export function aiOutroCorrespondenteLinha(cf: Cf, temOutro: boolean): string | null {
  if (!temOutro) return null;
  const d = (cf._caixaDesbloqueio || {}) as Cf;
  if (/^LIBERADO/.test(String(d.status || ''))) return 'CAIXA — o cadastro do cliente, que estava com outro correspondente, JÁ FOI LIBERADO pra gente: siga o processo da CAIXA normalmente, sem tocar mais no assunto.';
  const final = ((d.telefones || []) as string[]).map((t) => String(t).replace(/\D/g, '').slice(-4)).find((x) => x.length === 4);
  const cel = final ? `o celular dele cadastrado na CAIXA (final ${final})` : 'o celular dele cadastrado na CAIXA';
  const enviado = d.enviadoEm ? new Date(String(d.enviadoEm)) : null;
  const hora = enviado ? enviado.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }) : '';
  const recebido = d.tokenRecebidoEm ? new Date(String(d.tokenRecebidoEm)) : null;
  const estado = recebido
    ? `O cliente JÁ MANDOU o código do SMS às ${recebido.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}: agradeça, diga que a gente já vai liberar o cadastro aqui e seguir com a CAIXA, não peça o código de novo e não repita o número.`
    : enviado
    ? `O CÓDIGO JÁ FOI ENVIADO pela CAIXA por SMS pra ${cel} às ${hora}. Peça, com palavras suas (sem repetir o aviso do sistema), que ele mande o código aqui assim que chegar. Se ele disser que não chegou, pergunte à equipe — não prometa reenvio.`
    : `Se ainda não perguntou (veja o histórico), na sua PRÓXIMA resposta — depois de responder o que ele disse — pergunte se ele se lembra dessa análise/aprovação feita em outro correspondente e se pode seguir por aqui com a gente; explique em uma frase que, pra isso, a CAIXA manda um código por SMS pra ${cel} e ele repassa o código aqui. Se ele CONCORDAR em seguir com a gente (agora, respondendo a essa pergunta), ponha "caixaToken": true no JSON e responda curto que você vai pedir o código à CAIXA agora (o aviso de que o SMS saiu vai logo em seguida, pelo sistema). Se ele já respondeu, não pergunte de novo.`;
  return `CAIXA — CLIENTE EM OUTRO CORRESPONDENTE (Fabio 18/11): a consulta da CAIXA mostra uma avaliação de crédito/proposta dele feita por OUTRO correspondente. Pra seguir com a gente, essa análise antiga é cancelada A PEDIDO DELE: a CAIXA manda um código por SMS e, com o código, a gente libera o cadastro aqui. ${estado} Não diga o nome nem o número do outro correspondente, não use as palavras "convênio" ou "token" (diga "código por SMS da CAIXA"), não peça documento por causa disso. Se ele não quiser cancelar, disser que não fez análise em outro lugar ou tiver dúvida que você não sabe responder, pergunte à equipe.`;
}

/** Final de 4 dígitos do celular da tela do token ("celular (xx) - xxxxx - 8584"). */
const finalDoToken = (d: Cf): string | null => ((d.telefones || []) as string[]).map((t) => String(t).replace(/\D/g, '').slice(-4)).find((x) => x.length === 4) || null;

/** Primeira mensagem ao cliente (Fabio 18/11, Lucas: "perguntar ao cliente se ele se recorda dessa aprovação e se podemos seguir por aqui, para isso precisa encaminhar o
 *  token"). Pura. */
export function textoPerguntaOutroCca(saudacao: string, final: string | null): string {
  return `${saudacao ? `${saudacao}, uma` : 'Uma'} atualização sobre a CAIXA: lá consta uma análise de crédito sua feita por outro correspondente. Você se lembra dessa aprovação? Se quiser seguir com a gente, a CAIXA cancela essa análise a seu pedido: ela manda um código por SMS pro seu celular${final ? ` final ${final}` : ' cadastrado lá'} e você me repassa aqui. Posso pedir o código?`;
}

/** Manda a pergunta ao cliente (conversa aberta) — daí em diante a IA conduz pela linha aiOutroCorrespondenteLinha; o "sim" dele vira `caixaToken` e a extensão
 *  clica "Enviar Token". Conversa fechada: não manda; anota o texto pra equipe. */
export async function perguntarAoCliente(accountId: string, leadId: string, por: string, io?: any): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true, contact: { select: { phone: true, whatsappPhone: true } } } });
  if (!l) return 'Card não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const { outroCcaDe } = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
  if (!outroCcaDe(cf, (await (require('../lib/empresa') as typeof import('../lib/empresa')).dadosDaConta(accountId)).caixaConvenio).length) return 'A consulta da CAIXA deste card não mostra outro correspondente';
  const d = (cf._caixaDesbloqueio || {}) as Cf;
  const final = finalDoToken(d) || finaisDoCard(cf, [l.contact?.whatsappPhone, l.contact?.phone])[0] || null;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const texto = textoPerguntaOutroCca(callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, l.name) || '', final);
  const { whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!(await whatsappWindowOpen(leadId))) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ CAIXA — outro correspondente: a conversa está fechada (mais de 24 h sem o cliente escrever), não mandei a pergunta. Texto pronto:\n“${texto}”` } }).catch(() => {});
    return 'A conversa do WhatsApp está fechada (mais de 24 h): o texto ficou na anotação';
  }
  const msg = require('./message.service') as typeof import('./message.service');
  const env = await msg.sendOutboundWhatsApp({ accountId, leadId, content: texto, io });
  if (!env.success) return `Não consegui mandar: ${env.error || 'erro no envio'}`;
  await salvarDesbloqueio(leadId, (x) => { x.perguntadoEm = new Date().toISOString(); x.perguntadoPor = por; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📨 CAIXA — outro correspondente (${por}): perguntei ao cliente se ele se lembra da análise feita em outro correspondente e se pode seguir com a gente, explicando o código por SMS${final ? ` (celular final ${final})` : ''}. O "sim" dele faz a extensão clicar "Enviar Token".` } }).catch(() => {});
  return null;
}

/** Código do SMS no texto do cliente: um número só, de 4 a 8 dígitos (espaços entre os dígitos contam como o mesmo número). Pura. */
export function codigoNoTexto(texto: string): string | null {
  const t = String(texto || '');
  if (t.length > 120) return null;
  const junto = t.replace(/(\d)[\s.\-]+(?=\d)/g, '$1');
  const achados = junto.match(/(?<!\d)\d{4,8}(?!\d)/g) || [];
  return achados.length === 1 ? achados[0] : null;
}

/** Depois do "Enviar Token" (até 60 min): o número que o cliente manda é o código da CAIXA → card + anotação + push pra equipe digitar na tela do token. */
export async function guardarCodigoDoCliente(accountId: string, leadId: string, texto: string): Promise<boolean> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const d = (((l?.customFields || {}) as Cf)._caixaDesbloqueio || {}) as Cf;
  if (!d.enviadoEm || Date.now() - Date.parse(d.enviadoEm) > 60 * 60_000) return false;
  const codigo = codigoNoTexto(texto);
  if (!codigo || d.tokenRecebido === codigo) return false;
  // Passou de 30 min (a extensão já largou a tela do token e o código da CAIXA vale pouco — Fabio 18/11 "passou do prazo"): pede um código novo sozinho.
  if (Date.now() - Date.parse(d.enviadoEm) > 30 * 60_000) { await reenviarCodigo(accountId, leadId, `o cliente mandou o código ${codigo} depois de 30 min`); return true; }
  await salvarDesbloqueio(leadId, (x) => { x.tokenRecebido = codigo; x.tokenRecebidoEm = new Date().toISOString(); });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔑 CAIXA — o cliente mandou o código do SMS: ${codigo}. Digite na tela do token do Caixa Aqui pra liberar o cadastro (cancela a análise do outro correspondente).` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `🔑 ${l!.name}: código da CAIXA`, body: `Código ${codigo} — digite na tela do token do Caixa Aqui.`, leadId }).catch(() => {});
  return true;
}

/** Fabio 18/11: "ele encaminha o token, avisa o cliente sobre o token, ele informa o token, a extensão digita o token". Assim que a CAIXA envia o SMS, o cliente é
 *  avisado (conversa aberta; uma vez por envio). */
async function avisarClienteDoCodigo(accountId: string, leadId: string): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true, contact: { select: { phone: true, whatsappPhone: true } } } });
  const cf = (l?.customFields || {}) as Cf;
  const d = (cf._caixaDesbloqueio || {}) as Cf;
  if (!l || d.avisoTokenEm || cf._autoPaused) return;
  const final = finalDoToken(d) || finaisDoCard(cf, [l.contact?.whatsappPhone, l.contact?.phone])[0] || null;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, l.name) || '';
  // Cada envio com OUTRAS palavras (Fabio 18/11, print do Lucas: o aviso saiu igual às 13:27 e às 14:07 — "sempre repetir a mesma frase", "precisa alterar as palavras",
  // "tbm retira isso" = o "(ele vale por pouco tempo)"). 2º e 3º diferentes entre si e do 1º; sem parênteses.
  const envios = ((d.historico || []) as Cf[]).filter((h) => /^TOKEN ENVIADO/.test(String(h.status || ''))).length;
  const texto = textoAvisoCodigo(nome, final, envios);
  const { whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!(await whatsappWindowOpen(leadId))) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ CAIXA — o código foi enviado por SMS, mas a conversa está fechada: avise o cliente. Texto pronto:\n“${texto}”` } }).catch(() => {});
    return;
  }
  const msg = require('./message.service') as typeof import('./message.service');
  const env = await msg.sendOutboundWhatsApp({ accountId, leadId, content: texto });
  if (!env.success) { await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ CAIXA — não consegui avisar o cliente do código (${env.error || 'erro'}). Texto pronto:\n“${texto}”` } }).catch(() => {}); return; }
  await salvarDesbloqueio(leadId, (x) => { x.avisoTokenEm = new Date().toISOString(); });
}

/** A extensão (parada na tela do token) pergunta se o código chegou: entrega uma vez por código (até 60 min do envio). */
export async function entregarCodigo(accountId: string, leadId: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  const d = (((l?.customFields || {}) as Cf)._caixaDesbloqueio || {}) as Cf;
  if (!d.tokenRecebido || d.tokenEntregue === d.tokenRecebido) return null;
  if (!d.enviadoEm || Date.now() - Date.parse(d.enviadoEm) > 60 * 60_000) return null;
  await salvarDesbloqueio(leadId, (x) => { x.tokenEntregue = d.tokenRecebido; x.tokenEntregueEm = new Date().toISOString(); });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔑 CAIXA — a extensão pegou o código ${d.tokenRecebido} e vai digitar na tela do token.` } }).catch(() => {});
  return String(d.tokenRecebido);
}

async function cadastroDepoisDeLiberar(accountId: string, leadId: string): Promise<void> {
  // Fabio 18/11 (Lucas): "cadastro dele já estava atualizado — por que ela tá refazendo?" + "precisa concluir o cadastro, colocar apenas a nossa agência de vinculação e
  // clicar em concluir cadastro" + "não precisa mandar para a CAIXA analisar o crédito ainda". Liberado → cadastro no modo "concluir sem mexer" (sem análise).
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, userId: true } });
  const cc = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
  const r = await cc.cadastroCaixaPeloCard(accountId, leadId, { id: l?.userId || '', nome: 'CRM (liberado do outro correspondente: concluir o cadastro)' }, undefined, { analise: false });
  const n = 'erro' in r ? 0 : await cc.marcarSoConcluir(leadId);
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: 'erro' in r ? `⚠️ CAIXA — liberado do outro correspondente, mas o cadastro não foi pra fila: ${r.erro}` : `✅ CAIXA — cadastro LIBERADO do outro correspondente. A extensão conclui o cadastro sem mexer (${n} participante(s)): mantém o que está na CAIXA, põe a agência 3444 e clica "Concluir Cadastro". A análise de crédito sai só quando a equipe pedir.` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `✅ ${l?.name}: liberado na CAIXA`, body: 'Saiu do outro correspondente; concluindo o cadastro (agência 3444). Análise só quando você pedir.', leadId }).catch(() => {});
}

/** Pede um código NOVO (modo `enviar`; o cliente é avisado de que é novo). No máximo 3 envios por desbloqueio — depois, a equipe. */
async function reenviarCodigo(accountId: string, leadId: string, motivo: string): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const d = (((l?.customFields || {}) as Cf)._caixaDesbloqueio || {}) as Cf;
  const envios = ((d.historico || []) as Cf[]).filter((h) => /^TOKEN ENVIADO/.test(String(h.status || ''))).length;
  if (envios >= 3) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ CAIXA — desbloqueio: ${motivo}, mas já foram ${envios} códigos. Não peço outro sozinho — fale com o cliente.` } }).catch(() => {});
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `⚠️ ${l?.name}: desbloqueio CAIXA parado`, body: `${envios} códigos enviados — fale com o cliente.`, leadId }).catch(() => {});
    return;
  }
  const e = await pedirDesbloqueio(accountId, leadId, `CRM (automático: ${motivo})`, { modo: 'enviar' });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: e ? `⚠️ CAIXA — desbloqueio: ${motivo}; o código novo não foi pedido (${e}).` : `🔁 CAIXA — desbloqueio: ${motivo} → pedi um código NOVO (a extensão clica "Nova Solicitação de token"; o cliente é avisado).` } }).catch(() => {});
}

const SIM_RX = /^\s*(sim|s|pode|pode ser|pode sim|pode pedir|pode mandar|manda|ok|okay|claro|quero|quero sim|vamos|bora|isso|com certeza|fechado|beleza|blz|certo|positivo|t[aá] bom|tudo bem|aham|uhum|desejo|prossiga|segue|seguir)\b/i;
const NAO_RX = /^\s*(n[aã]o|nao|prefiro (n[aã]o|l[aá]|o outro|seguir l[aá])|vou seguir (com|l[aá])|deixa (l[aá]|quieto))\b/i;
/** Mensagem do cliente (IA ligada ou não): o código do SMS, ou a resposta à pergunta (sim → código; não → equipe). */
export async function aoReceberDoCliente(accountId: string, leadId: string, texto: string): Promise<void> {
  if (await guardarCodigoDoCliente(accountId, leadId, texto)) return;
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const d = (((l?.customFields || {}) as Cf)._caixaDesbloqueio || {}) as Cf;
  if (!d.perguntadoEm || Date.now() - Date.parse(d.perguntadoEm) > 72 * 3600_000) return;
  if (d.enviadoEm && Date.parse(d.enviadoEm) > Date.parse(d.perguntadoEm)) return; // já enviou depois da pergunta
  if (d.recusouEm || /^LIBERADO/.test(String(d.status || ''))) return;
  const t = String(texto || '').trim();
  if (!t || t.length > 200) return;
  if (NAO_RX.test(t)) {
    await salvarDesbloqueio(leadId, (x) => { x.recusouEm = new Date().toISOString(); });
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ CAIXA — outro correspondente: o cliente respondeu "${t.slice(0, 120)}" à pergunta do código. Nada foi enviado — fale com ele.` } }).catch(() => {});
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `⚠️ ${l?.name}: não quer cancelar o outro correspondente?`, body: t.slice(0, 140), leadId }).catch(() => {});
    return;
  }
  if (SIM_RX.test(t) && !/\bn[aã]o\b/i.test(t)) await pedirDesbloqueio(accountId, leadId, `cliente respondeu "${t.slice(0, 40)}" (automático)`, { modo: 'enviar', seNaoEnviado: true }).catch(() => {});
}

/** Aviso de que a CAIXA mandou o código — texto diferente a cada envio (1º, 2º, 3º+). Pura. */
export function textoAvisoCodigo(nome: string, final: string | null, envio: number): string {
  const cel = final ? `no seu celular com final ${final}` : 'no seu celular cadastrado na CAIXA';
  const voc = nome ? `${nome}, ` : '';
  if (envio <= 1) return `${voc}a CAIXA enviou agora um código por SMS ${cel}. Assim que ele chegar, é só me mandar o número por aqui.`;
  if (envio === 2) return `${voc}aquele primeiro código não serviu, então pedi outro à CAIXA e ele já foi enviado ${cel}. Consegue me repassar esse novo número?`;
  return `${voc}fiz mais uma solicitação e a CAIXA mandou um novo código ${cel}. Me envia esse último que eu libero por aqui na hora.`;
}

/** Ficha de cadastro nova: o desbloqueio que parou na Identificação Positiva sem os dados (nome do pai + identidade) volta pra fila do mesmo jeito (até a tela do
 *  código, perguntando ao cliente se era o automático). */
export async function retomarDepoisDaFicha(accountId: string, leadId: string): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (l?.customFields || {}) as Cf;
  const d = (cf._caixaDesbloqueio || {}) as Cf;
  if (!/^PAROU: a CAIXA pede a Identifica/.test(String(d.status || ''))) return;
  const p1 = participantesDa(cf).find((x) => x.ordem === 1);
  if (!p1?.pai || !p1?.identidade?.numero) return;
  const { outroCcaDe } = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
  if (!outroCcaDe(cf, (await (require('../lib/empresa') as typeof import('../lib/empresa')).dadosDaConta(accountId)).caixaConvenio).length) return;
  await pedirDesbloqueio(accountId, leadId, 'CRM (automático: a ficha ficou pronta, com o nome do pai e a identidade)', { modo: d.modo === 'enviar' ? 'enviar' : 'ate', perguntar: !!d.perguntarAuto });
}
