import { prisma } from '../lib/prisma';

/* Resultado da Avaliação de Risco da CAIXA. A tela do envio só dá o número da proposta (Fabio 01/11: "O RESULTADO NÃO SAI NESSA TELA, PRECISA CONSULTAR
 * DEPOIS" e "PARA CONSULTAR O RESULTADO, PRECISA VOLTAR NO MENU E IR EM FORMULÁRIOS ENVIADOS"): Consulta de Formulários Enviados → Buscar por CPF →
 * Consultar. A extensão Cadastro Caixa consulta pelo CPF do tomador e devolve a tela. 1ª fase: só sob pedido, e a tela vira nota pra mapear onde fica o
 * resultado. Fica em _caixaResultado, fora de _caixaCadastro (a fila do cadastro regrava aquela chave inteira). */

type Cf = Record<string, any>;
const LEASE_MS = 10 * 60_000;
// "Avaliação em Processamento" (Fabio 03/11): costuma virar resultado em 3–5 min — reconsulta em 3, 5, 10, 15 e 30 min e depois a cada 2 h; passou de 24 h
// nesse status, push pra equipe (uma vez por envio).
const PROCESSANDO_RE = /em processamento/i;
const RECONSULTA_MIN = [3, 5, 10, 15, 30, 120];

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

/** Avaliação de Risco rodada DE NOVO (Fabio 03/11, Jézer/Fernanda depois da autorização do PV): o resultado da anterior sai de cena — já foi pro histórico da
 *  avaliação (`_caixaCadastro.avaliacao.anteriores`, pedirAvaliacao) — e a consulta de Formulários Enviados volta a rodar depois do novo envio (rota /avaliacao →
 *  pedirConsultaResultado). A chave continua no card (o "crédito já rodado" segue valendo) e o pvAviso fica (histórico do aviso ao cliente). Sem resultado → nada. */
export async function reiniciarResultado(leadId: string): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  if (!((l?.customFields || {}) as Cf)._caixaResultado) return;
  await salvar(leadId, (r) => {
    const anterior = r.status && r.status !== 'AGUARDANDO_NOVA_AVALIACAO' ? { status: String(r.status).slice(0, 300), fim: r.fim || null } : r.anterior || null;
    for (const k of Object.keys(r)) if (k !== 'pvAviso') delete r[k];
    r.status = 'AGUARDANDO_NOVA_AVALIACAO';
    r.desde = new Date().toISOString();
    if (anterior) r.anterior = anterior;
  });
}

/** Próxima consulta de resultado pra extensão (a fila da CAIXA chama quando não há consulta/cadastro/avaliação). FILA, RODANDO largada há mais de 10 min
 *  (até 3 tentativas), ou "Em Processamento" com a reconsulta vencida (sem `processando` = de antes da regra: reconsulta já). */
export async function proximaConsultaResultado(accountId: string) {
  const agora = new Date().toISOString();
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND ("customFields"->'_caixaResultado'->>'status' IN ('FILA', 'RODANDO')
        OR ("customFields"->'_caixaResultado'->>'status' ILIKE '%em processamento%'
          AND COALESCE("customFields"->'_caixaResultado'->'processando'->>'proximaEm', "customFields"->'_caixaResultado'->>'fim', '') <= ${agora}))
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
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return;
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  if (PROCESSANDO_RE.test(r.status)) { await gravarProcessando(accountId, leadId, l.name, (l.customFields || {}) as Cf, r); return; }
  await salvar(leadId, (x) => { x.status = r.status; x.fim = new Date().toISOString(); x.ultimaTela = String(r.texto || '').slice(0, 3000); delete x.processando; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Resultado da Avaliação de Risco CAIXA (Formulários Enviados): ${r.status}\n\n${String(r.texto || '').slice(0, 3500)}` } }).catch(() => {});
  if (CONDICIONADA_RE.test(r.status)) await tratarCondicionada(accountId, leadId, l.name, String(r.texto || '')).catch((e) => console.error('[CAIXA condicionada]', e?.message));
  else if (APROVADA_RE.test(r.status) && !/n[aã]o aprovad/i.test(r.status)) await tratarAprovadaNaPrice(accountId, leadId, l.name, String(r.texto || '')).catch((e) => console.error('[CAIXA aprovada na PRICE]', e?.message));
  // "2ª autorização do PV" (Fabio 01/11): o cliente rodou crédito mais de uma vez, com correspondentes diferentes — o colaborador pede a autorização à agência.
  if (PV_RE.test(`${r.status}\n${r.texto}`)) {
    // 1ª ou 2ª autorização, com o motivo da CAIXA ("Grupo Fam. Alt.", "Renda Alterada" — Fabio 02/11: a renda/o grupo familiar mudou desde a avaliação em outro correspondente).
    const motivoPv = ((/([^\n]*autoriza[cç][aã]o do PV[^\n]*)/i.exec(`${r.status}\n${r.texto}`) || [])[1] || '').replace(/^.*?(RESULTADO:[^—]*—\s*)/, '').trim();
    // Fabio 02/11: com autorização do PV NÃO se avisa mais o cliente — só push pro COLABORADOR responsável pelo card (sem responsável, pra conta), uma vez por proposta.
    const proposta = (/C[oó]digo Proposta\s*\t?\s*(\d{5,})/i.exec(r.texto) || /Proposta\s+(\d{5,})/i.exec(r.texto) || [])[1] || '?';
    const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { userId: true, customFields: true } });
    if ((lead?.customFields as Cf | null)?._caixaResultado?.pvAviso?.proposta === proposta) return;
    await salvar(leadId, (x) => { x.pvAviso = { status: 'SO_EQUIPE', proposta, at: new Date().toISOString() }; });
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ A CAIXA pede AUTORIZAÇÃO DO PV (agência)${motivoPv ? ` — "${motivoPv}"` : ''} na proposta ${proposta}: o cliente já rodou crédito em outro correspondente e os dados mudaram desde então (renda/grupo familiar) — não é nome sujo. Solicite a autorização à agência para seguir com a avaliação. O cliente NÃO é avisado (Fabio 02/11).` } }).catch(() => {});
    sendPushToAccount(accountId, { title: `⚠️ ${l.name}: pedir autorização à agência (PV)`, body: (motivoPv || 'A CAIXA pede a autorização do PV').slice(0, 120), leadId }, lead?.userId ? [lead.userId] : undefined).catch(() => {});
    return;
  }
  sendPushToAccount(accountId, { title: `🏦 ${l.name}: resultado da avaliação CAIXA`, body: r.status.slice(0, 120), leadId }).catch(() => {});
}

// ─── "Avaliação Condicionada" (Fabio 03/11) ───
// A CAIXA aprova só uma parcela menor ("Valor da prestação Possível"). O CRM calcula o crédito máximo com essa parcela pela conta do simulador do site
// (HE: taxa da CAIXA por faixa — 20,75% a.a. até R$ 150 mil, 16,2012% acima — com o IOF de 3,4813% somado à base; FH: 10,92% a.a., sem IOF), na Price no
// prazo máximo (240 meses no HE, 360 no FH, sem olhar a idade).
// - Abaixo do mínimo (HE R$ 50 mil, FH R$ 100 mil): avisa o cliente que a parcela aprovada não dá o mínimo (mesmo caminho do aviso do PV: 07h–21h, conversa
//   fechada → template e o texto quando ele responder). Sem outra aprovação → Perdidos. Com aprovação em outro banco (Fabio 03/11, Jézer: "primeiro pergunta
//   se ele deseja seguir com as outras aprovações; se ele não quiser, aí move para perdido") → o aviso termina com "Você deseja seguir com o crédito aprovado?"
//   e o "não" dele leva pra Perdidos (IA da conversa).
// - No mínimo ou acima: "SEMPRE QUE RETORNAR CONDICIONADA … RODE NA PRICE … ALTERAR APENAS O VALOR DA PARCELA E DEPOIS COLOCA PARA APROVAR" — a extensão
//   reabre a proposta, troca a prestação pela possível e a amortização pra PRICE e envia; a consulta do resultado roda sozinha. Aprovou → avisa o cliente só
//   do valor liberado ("NÃO ENTRO EM DETALHES, APENAS SE O CLIENTE QUESTIONAR"). Voltou condicionada de novo → equipe.
const CONDICIONADA_RE = /condicionad/i;
const APROVADA_RE = /aprovad/i;
const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const numeroBr = (v: unknown) => { const t = String(v ?? '').replace(/[^\d.,]/g, ''); return Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t) || 0; };
const propostaDa = (texto: string) => (/C[oó]digo Proposta\s*\t?\s*(\d{5,})/i.exec(texto) || /Proposta\s+(\d{5,})/i.exec(texto) || [])[1] || '';
const AVISO_NO_CARD: Record<string, string> = { PENDING: 'aviso ao cliente na fila', TEMPLATE: 'template enviado, o aviso sai quando ele responder', ENVIADO: 'cliente avisado', FALHOU: 'aviso não saiu, texto pronto nas anotações' };

/** Crédito (líquido) que a parcela paga na Price — prazo da tela da CAIXA quando houver, senão o máximo. Pura. */
export function creditoMaximoPelaParcela(parcela: number, he: boolean, prazo?: number | null): number {
  const n = Math.min(prazo && prazo > 0 ? prazo : 999, he ? 240 : 360);
  const price = (taxaAnual: number) => { const i = taxaAnual / 12 / 100; return (parcela * (1 - Math.pow(1 + i, -n))) / i; };
  if (!he) return price(10.92);
  const liquido = (taxaAnual: number) => price(taxaAnual) / (1 + 3.4813 / 100);
  const faixaCheia = liquido(20.75);
  return faixaCheia > 150_000 ? liquido(16.2012) : faixaCheia;
}

export function textoCondicionada(saudacao: string, c: { parcela: number; minimo: number; he: boolean; motivo: boolean; seguir?: boolean }): string {
  const { SEGUIR_APROVADO_Q } = require('./ai-auto-reply.service') as typeof import('./ai-auto-reply.service');
  return `Oi${saudacao ? ` ${saudacao}` : ''}, tudo bem? Saiu a resposta da CAIXA: ela aprovou uma parcela de no máximo ${brl(c.parcela)} por mês${c.motivo ? ', por causa de outros compromissos financeiros no seu nome (na CAIXA ou em outros bancos)' : ''}. Com essa parcela, o ${c.he ? 'crédito' : 'financiamento'} ficaria bem abaixo do mínimo de R$ ${c.minimo / 1000} mil, então não conseguimos seguir pela CAIXA neste momento.${c.seguir ? `\n\nMas as outras aprovações que conseguimos pra você continuam valendo. ${SEGUIR_APROVADO_Q}` : ''}`;
}

export function textoLiberado(saudacao: string, c: { valor: number; he: boolean }): string {
  return `Oi${saudacao ? ` ${saudacao}` : ''}, tudo bem? Boa notícia: a CAIXA aprovou o seu ${c.he ? 'crédito' : 'financiamento'} no valor de ${brl(c.valor)}.`;
}

async function tratarCondicionada(accountId: string, leadId: string, nome: string, texto: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { userId: true, status: true, customFields: true, pipeline: { select: { departmentId: true } } } });
  const cf = (lead?.customFields || {}) as Cf;
  const proposta = propostaDa(texto) || '?';
  const nota = (content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  const pushEquipe = (title: string, body: string) => sendPushToAccount(accountId, { title, body, leadId }, lead?.userId ? [lead.userId] : undefined).catch(() => {});
  const m = /presta[cç][aã]o\s+poss[ií]vel\s*\t?\s*(?:R\$\s*)?([\d.]+,\d{2})/i.exec(texto);
  if (!m) {
    await nota(`🟡 CAIXA condicionada (proposta ${proposta}), mas não achei o "Valor da prestação Possível" na tela. Confira no Caixa Aqui. O cliente NÃO foi avisado.`);
    return;
  }
  const parcela = Number(m[1].replace(/\./g, '').replace(',', '.'));
  const ant = cf._caixaResultado?.condicionada as Cf | undefined;
  if (ant?.proposta === proposta && ant?.parcela === parcela && ant?.status !== 'SO_EQUIPE') return; // a mesma resposta já foi tratada (consulta repetida)
  const av = (cf._caixaCadastro?.avaliacao || {}) as Cf;
  const he = /garantia|EGI/i.test(`${av.produto || ''} ${texto}`);
  const minimo = he ? 50_000 : 100_000;
  const credito = creditoMaximoPelaParcela(parcela, he);
  const conta = `a parcela possível de ${brl(parcela)} paga no máximo uns ${brl(Math.floor(credito / 100) * 100)} de ${he ? 'crédito' : 'financiamento'} (Price em ${he ? 240 : 360} meses, com a taxa da CAIXA do simulador do site${he ? ' e o IOF' : ''}; sem contar o limite de idade)`;
  const base = { proposta, parcela, credito: Math.round(credito), minimo, he, motivo: /compromissos financeiros/i.test(texto), at: new Date().toISOString() };
  if (credito < minimo) {
    const { temAprovacao } = require('./caixa-screening.service') as typeof import('./caixa-screening.service');
    const seguir = await temAprovacao(leadId, cf);
    await salvar(leadId, (x) => { x.condicionada = { ...base, status: 'PENDING', ...(seguir ? { seguir: true } : {}) }; });
    await nota(`🟡 CAIXA condicionada (proposta ${proposta}): ${conta}, abaixo do mínimo de R$ ${minimo / 1000} mil. O CRM avisa o cliente que a parcela aprovada não dá o mínimo${seguir ? ' e, como ele tem aprovação em outro banco, pergunta se deseja seguir com o crédito aprovado (o "não" leva pra Perdidos)' : ' e o card vai pra Perdidos'}.`);
    if (seguir || lead?.status !== 'OPEN') return;
    const motivo = `CAIXA condicionada: a parcela aprovada (${brl(parcela)}) não alcança o mínimo de R$ ${minimo / 1000} mil`;
    const { updateLead } = require('./lead.service') as typeof import('./lead.service');
    const { moveLeadToPerdidos } = require('./named-pipeline.service') as typeof import('./named-pipeline.service');
    await updateLead(leadId, accountId, { status: 'LOST', lostReason: motivo });
    await moveLeadToPerdidos({ accountId, leadId, departmentId: lead.pipeline?.departmentId, byName: 'Assistente IA', userId: null, motivo });
    return;
  }
  if (av.ajuste && String(av.ajuste.de || '') === proposta) {
    await salvar(leadId, (x) => { x.condicionada = { ...base, status: 'SO_EQUIPE' }; });
    await nota(`🟡 CAIXA voltou CONDICIONADA de novo (proposta ${proposta}), mesmo refeita na PRICE com a prestação de ${brl(Number(av.ajuste.prestacao))}: agora a parcela possível é ${brl(parcela)}. O CRM não refaz de novo sozinho — veja com a agência. O cliente NÃO foi avisado.`);
    pushEquipe(`🟡 ${nome}: CAIXA condicionada de novo`, `Mesmo na PRICE: parcela possível ${brl(parcela)}. Ver com a agência.`);
    return;
  }
  const { pedirAvaliacao } = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
  const em = new Date().toISOString();
  const via = 'regra do Fabio 03/11: condicionada → refaz na PRICE com a prestação possível';
  const erro = await pedirAvaliacao(accountId, leadId, 'automático (condicionada → PRICE)', { enviar: true, denovo: true, ajuste: { prestacao: parcela, amortizacao: 'PRICE', de: proposta, credito: Math.round(credito) }, autorizacao: { por: 'automático', em, enviar: true, denovo: true, via } });
  if (erro) {
    await salvar(leadId, (x) => { x.condicionada = { ...base, status: 'SO_EQUIPE' }; });
    await nota(`🟡 CAIXA condicionada (proposta ${proposta}): ${conta}. Não consegui pedir a avaliação de novo na PRICE: ${erro}. O cliente NÃO foi avisado.`);
    pushEquipe(`🟡 ${nome}: CAIXA condicionada`, `Parcela ${brl(parcela)}: não consegui refazer na PRICE sozinho.`);
    return;
  }
  await nota(`🟡 CAIXA condicionada (proposta ${proposta}): ${conta}. Refazendo na PRICE com essa prestação pra aprovar; o resultado sai na consulta.`);
}

/** Aprovada depois de refeita na PRICE com a prestação possível: guarda o valor liberado (simulação da Price com o prazo da tela, até o valor pedido) e o
 *  aviso ao cliente vai pra fila — só o valor, sem detalhes (Fabio 03/11). */
async function tratarAprovadaNaPrice(accountId: string, leadId: string, nome: string, texto: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { userId: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const aj = cf._caixaCadastro?.avaliacao?.ajuste as Cf | undefined;
  if (!aj) return;
  const proposta = propostaDa(texto) || String(aj.de || '?');
  const ant = cf._caixaResultado?.condicionada as Cf | undefined;
  if (ant?.tipo === 'liberado' && ant?.proposta === proposta) return;
  const he = /garantia|EGI/i.test(`${cf._caixaCadastro?.avaliacao?.produto || ''} ${texto}`);
  const prazoTela = Number((/Prazo\s*\(Meses\)\s*\t?\s*(\d+)/i.exec(texto) || [])[1]) || null;
  const prazo = Math.min(prazoTela || 999, he ? 240 : 360);
  const parcela = Number(aj.prestacao);
  const desejado = numeroBr(cf.valor_credito);
  const estimado = creditoMaximoPelaParcela(parcela, he, prazo);
  const valor = Math.floor(Math.min(estimado, desejado > 0 ? desejado : Infinity) / 1000) * 1000;
  await salvar(leadId, (x) => { x.condicionada = { tipo: 'liberado', status: 'PENDING', proposta, parcela, valor, prazo, he, desejado: desejado || null, at: new Date().toISOString() }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `✅ CAIXA APROVOU na PRICE com a prestação de ${brl(parcela)} (proposta ${proposta}). Pela simulação (Price em ${prazo} meses, taxa da CAIXA do simulador do site${he ? ' e IOF' : ''}), libera uns ${brl(valor)}${desejado > valor ? ` — o pedido era ${brl(desejado)}` : ''}. O CRM avisa o cliente só do valor liberado; detalhes só se ele perguntar (Fabio 03/11). Confira o valor no Caixa Aqui.` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `✅ ${nome}: CAIXA aprovou na PRICE`, body: `Libera uns ${brl(valor)} · o cliente vai ser avisado`, leadId }, lead?.userId ? [lead.userId] : undefined).catch(() => {});
}

/** Linha do resultado no bloco CAIXA do card (Fabio 03/11: "registrar no card, colocar condicionado e o valor da parcela"): a parcela possível, se dá o
 *  mínimo, o valor liberado depois da PRICE e como está o aviso ao cliente. Condicionada é resultado final: não volta pra fila de consulta. Pura. */
export function resultadoNoCard(res: Cf | null | undefined): string | null {
  if (!res?.status) return null;
  const c = res.condicionada as Cf | undefined;
  const aviso = c ? AVISO_NO_CARD[c.status] : '';
  if (c?.tipo === 'liberado') return `Aprovada na PRICE (parcela de ${brl(Number(c.parcela))}): libera uns ${brl(Number(c.valor))}${aviso ? ` · ${aviso}` : ''}`;
  if (!c || !CONDICIONADA_RE.test(String(res.status))) return String(res.status).slice(0, 200);
  if (c.credito >= c.minimo) return `Condicionada: parcela de ${brl(Number(c.parcela))} (dá até uns ${brl(Math.floor(c.credito / 1000) * 1000)})`;
  return `Condicionada: parcela de ${brl(Number(c.parcela))}, não dá o mínimo de R$ ${Number(c.minimo) / 1000} mil${aviso ? ` · ${aviso}` : ''}`;
}

/** Aviso ao cliente da condicionada (não dá o mínimo) ou do valor liberado na PRICE (poller de 1 min, junto do aviso do PV). STOP total → texto pronto pra equipe. */
export async function avisarCondicionadaCliente(accountId: string, leadId: string, io?: any): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const cf = (lead?.customFields || {}) as Cf;
  const c = cf._caixaResultado?.condicionada as Cf | undefined;
  if (!lead || !c || (c.status !== 'PENDING' && c.status !== 'TEMPLATE')) return;
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const saudacao = callableFirstName(cf.falando_com, cf.participante_1, lead.name) || '';
  const liberado = c.tipo === 'liberado';
  const texto = liberado ? textoLiberado(saudacao, { valor: Number(c.valor), he: !!c.he }) : textoCondicionada(saudacao, { parcela: Number(c.parcela), minimo: Number(c.minimo), he: !!c.he, motivo: !!c.motivo, seguir: !!c.seguir });
  const rotulo = liberado ? 'CAIXA aprovada na PRICE' : 'CAIXA condicionada';
  const nota = (content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  const falhou = async (porque: string) => {
    await salvar(leadId, (x) => { x.condicionada = { ...(x.condicionada || {}), status: 'FALHOU' }; });
    await nota(`⚠️ ${rotulo}: ${porque}. Avise você o cliente. Texto pronto:\n“${texto}”`);
    sendPushToAccount(accountId, { title: `⚠️ ${lead.name}: avisar o cliente (${rotulo})`, body: 'Texto pronto na anotação.', leadId }).catch(() => {});
  };
  if (cf._autoPaused) return falhou('o card está em STOP TOTAL, então o CRM não mandou sozinho');
  const { inNoticeWindow, whatsappWindowOpen } = require('./approval-notice.service') as typeof import('./approval-notice.service');
  if (!inNoticeWindow()) return;
  const msg = require('./message.service') as typeof import('./message.service');
  if (await whatsappWindowOpen(leadId)) {
    const env = await msg.sendOutboundWhatsApp({ accountId, leadId, content: texto, io });
    if (!env.success) return; // tenta no próximo minuto
    await salvar(leadId, (x) => { x.condicionada = { ...(x.condicionada || {}), status: 'ENVIADO', enviadoAt: new Date().toISOString() }; });
    await nota(liberado ? `📨 Avisei o cliente que a CAIXA aprovou ${brl(Number(c.valor))} (sem detalhes).` : '📨 Avisei o cliente que a CAIXA aprovou uma parcela pequena demais, que não dá o mínimo, e que não dá pra seguir pela CAIXA agora.');
    return;
  }
  if (c.status === 'PENDING') {
    const t = await msg.sendOutboundWhatsAppTemplate({ accountId, leadId, templateName: PV_TEMPLATE, language: 'pt_BR', bodyParams: [saudacao || 'cliente'], previewText: `Oi ${saudacao || 'cliente'}, tudo bem? Temos uma atualização sobre o seu processo de crédito com garantia de imóvel. Responda esta mensagem para que a gente possa te passar os detalhes.`, io });
    if (!t.success) return falhou(`a conversa está fechada e o template de atualização não saiu (${t.error})`);
    await salvar(leadId, (x) => { x.condicionada = { ...(x.condicionada || {}), status: 'TEMPLATE', templateAt: new Date().toISOString() }; });
    await nota(`📨 ${rotulo}: conversa fechada, mandei o template de atualização. O aviso ao cliente sai quando ele responder.`);
    return;
  }
  if (c.templateAt && Date.now() - Date.parse(c.templateAt) > 48 * 3600_000) return falhou('o cliente não respondeu ao template em 48 h');
}

/** Bloco pra IA da conversa: aviso da condicionada/do valor liberado esperando o template, ou enviado há até 3 dias. '' se não houver. Pura. */
export function aiCondicionadaContext(cf: Cf): string {
  const c = cf._caixaResultado?.condicionada as Cf | undefined;
  if (c?.status === 'TEMPLATE') {
    return `--- CAIXA (aviso ainda não enviado) ---
A conversa estava fechada e o CRM chamou o cliente pelo template de atualização: assim que ele responder, o CRM manda SOZINHO, logo em seguida, a resposta da CAIXA. Agora responda só UMA frase curta de retorno (ex.: "Oi, tudo bem? Já te explico aqui embaixo."), sem falar da CAIXA.`;
  }
  if (c?.status !== 'ENVIADO' || !c.enviadoAt || Date.now() - Date.parse(c.enviadoAt) > 3 * 86_400_000) return '';
  if (c.tipo === 'liberado') {
    return `--- CAIXA APROVOU (aviso enviado ao cliente; Fabio 03/11) ---
O CRM avisou o cliente que a CAIXA aprovou o ${c.he ? 'crédito' : 'financiamento'} no valor de ${brl(Number(c.valor))}. Só dê detalhes se ele perguntar: a CAIXA limitou a parcela em ${brl(Number(c.parcela))} por mês, por isso foi na tabela PRICE em ${c.prazo} meses${c.desejado && Number(c.desejado) > Number(c.valor) ? ` e o valor ficou abaixo do pedido (${brl(Number(c.desejado))})` : ''}. Não prometa outro valor nem outra condição; dúvida que você não sabe responder → "askTeam".`;
  }
  return `--- CAIXA CONDICIONADA (aviso enviado ao cliente; Fabio 03/11) ---
O CRM avisou o cliente que a CAIXA aprovou uma parcela de no máximo ${brl(Number(c.parcela))} por mês${c.motivo ? ' (por outros compromissos financeiros no nome dele)' : ''} e que, com essa parcela, o ${c.he ? 'crédito' : 'financiamento'} ficaria abaixo do mínimo de R$ ${Number(c.minimo) / 1000} mil, então não dá pra seguir pela CAIXA agora. NÃO é restrição no nome: nunca diga isso.
${c.seguir ? `O aviso terminou perguntando se ele deseja seguir com o crédito aprovado em outro banco (as outras aprovações continuam valendo).
- Respondeu que NÃO quer seguir: agradeça em 1 frase e marque "markLost": "Não quis seguir com as outras aprovações (CAIXA condicionada não alcançou o mínimo)".
- Respondeu que SIM: diga em 1 frase que vamos seguir com o crédito aprovado e que a equipe já dá sequência (sem prometer prazo).
` : ''}Quando ele responder: tire dúvidas sobre o que foi dito em 1–2 frases. Se ele perguntar o que dá pra fazer (quitar dívidas, nova análise, outro banco, outro valor), não prometa nada e use "askTeam" com a pergunta dele.`;
}

/** "Em Processamento": agenda a próxima reconsulta (RECONSULTA_MIN) e, passadas 24 h do envio nesse status, avisa a equipe por push. Só a 1ª vez de cada
 *  envio vira anotação — as reconsultas são silenciosas. O ciclo é por envio (`_caixaCadastro.avaliacao.fim`): rodar de novo recomeça a contagem. */
async function gravarProcessando(accountId: string, leadId: string, nome: string, cf: Cf, r: { status: string; texto: string }): Promise<void> {
  const agora = new Date().toISOString();
  const envio = String(cf._caixaCadastro?.avaliacao?.fim || '');
  const ant = cf._caixaResultado?.processando as Cf | undefined;
  const mesmo = !!ant && ant.envio === envio;
  const consultas = mesmo ? (Number(ant!.consultas) || 1) + 1 : 1;
  const desde = mesmo && ant!.desde ? String(ant!.desde) : envio || agora;
  const espera = RECONSULTA_MIN[Math.min(consultas - 1, RECONSULTA_MIN.length - 1)];
  const avisar = !(mesmo && ant!.avisado24h) && Date.now() - Date.parse(desde) > 24 * 3600_000;
  const proc = { envio, desde, consultas, proximaEm: new Date(Date.now() + espera * 60_000).toISOString(), avisado24h: avisar ? agora : (mesmo && ant!.avisado24h) || null };
  await salvar(leadId, (x) => { x.status = r.status; x.fim = agora; x.ultimaTela = String(r.texto || '').slice(0, 3000); x.tentativas = 0; x.processando = proc; });
  const proposta = (/C[oó]digo Proposta\s*\t?\s*(\d{5,})/i.exec(r.texto) || /Proposta\s+(\d{5,})/i.exec(r.texto) || [])[1];
  if (consultas === 1) await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⏳ Avaliação de Risco CAIXA em processamento${proposta ? ` (proposta ${proposta})` : ''}. O CRM consulta de novo sozinho em 3, 5, 10, 15 e 30 min e depois a cada 2 h; se passar de 24 h assim, avisa a equipe.` } }).catch(() => {});
  if (!avisar) return;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ A Avaliação de Risco CAIXA${proposta ? ` (proposta ${proposta})` : ''} está "em processamento" há mais de 24 h. Vale olhar no Caixa Aqui ou falar com a agência. O CRM segue consultando a cada 2 h.` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `⚠️ ${nome}: CAIXA em processamento há +24 h`, body: 'A avaliação de risco não saiu. Vale olhar no Caixa Aqui ou falar com a agência.', leadId }).catch(() => {});
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

/** Poller (vai junto do das ocorrências, a cada minuto): aviso de PV ou da condicionada que ficou pra depois. */
export async function processPvAvisos(accountId: string, io?: any): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND archived = false
      AND ((status = 'OPEN' AND "customFields"->'_caixaResultado'->'pvAviso'->>'status' IN ('PENDING', 'TEMPLATE'))
        OR (status IN ('OPEN', 'LOST') AND "customFields"->'_caixaResultado'->'condicionada'->>'status' IN ('PENDING', 'TEMPLATE'))) LIMIT 20`; // condicionada que não dá o mínimo vai pra Perdidos: o aviso ainda sai
  for (const { id } of ids) {
    await avisarPvCliente(accountId, id, io).catch((e) => console.error('[CAIXA PV]', e?.message));
    await avisarCondicionadaCliente(accountId, id, io).catch((e) => console.error('[CAIXA condicionada]', e?.message));
  }
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
