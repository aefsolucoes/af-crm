import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';
import { comRegrasCaixa, regrasRendaCaixa, rendaForaDoPrazo } from './caixa-cr016';

/* Fila do cadastro na CAIXA (Fabio 29/10: "quero que o CRM indique qual cliente rodar"). A extensão "Cadastro CAIXA (Caixa Aqui)" pergunta a fila a cada minuto.
 * Ordem da CAIXA (Fabio 29/10): (1) consultar o nome de cada participante em Oportunidades de Negócios; (2) limpo → cadastrar 1º e 2º participante (2º sem renda:
 * "SEM RENDA" e salvar); (3) análise de crédito. Os dados vêm da ficha de cadastro (`_fichaCadastral`, lida dos documentos do Drive).
 * Estado no card: `_caixaCadastro` = { status: FILA | CONSULTADO, pedidoEm, por, consultas: { [ordem]: { at, texto } }, atual?: { ordem, desde } }.
 * Entra na fila: pela equipe (POST /api/leads/:id/caixa-cadastro) ou sozinho quando a ficha está pronta e o cliente vai pela CAIXA
 * (Financiamento: todo cliente sem outro banco escolhido; Home Equity: optou pela CAIXA ou reaberto por ela). Consultado → o cadastro de quem está com a
 * ficha completa sai sozinho (Fabio 31/10). */

type Cf = Record<string, any>;
// Home Equity entra na CAIXA (Fabio 31/10: "INCLUA A CAIXA NAS AVALIAÇÕES DE HE"; "depois que a documentação chega: cadastro automático e em seguida a avaliação").
// Vale para fichas geradas daqui pra frente — os HE que já estavam em contratação não começam a ser cadastrados de uma vez.
const HE_CAIXA_DESDE = '2026-10-31T20:00:00.000Z';
const ehHe = (dept: string | null | undefined) => /home|garantia/i.test(dept || '');
const LEASE_MS = 10 * 60_000; // participante "em consulta" há mais que isso = a extensão largou; volta pra fila

async function salvar(leadId: string, mut: (c: Cf) => void): Promise<Cf> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const c: Cf = { ...(((l?.customFields || {}) as Cf)._caixaCadastro || {}) };
  mut(c);
  // Grava SÓ a chave _caixaCadastro (jsonb_set): regravar o card inteiro trazia de volta chaves que outro processo tinha acabado de tirar (Jézer 29/10).
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaCadastro}', ${JSON.stringify(c)}::jsonb, true) WHERE id = ${leadId}`;
  return c;
}

const participantesDa = (cf: Cf): any[] => {
  const ps = Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : [];
  const base = ps.map((p: any, i: number) => {
    const n = Number(p.ordem) || i + 1;
    return { ...p, ordem: n, cpf: String(p.cpf || cf[`cpf_${n}`] || '').replace(/\D/g, ''), telefone: cf[`telefone_${n}`] || '', email: cf[`email_${n}`] || '' };
  });
  // CPF do cônjuge: a certidão de casamento não traz — se o cônjuge é o outro participante do card, usa o CPF dele (Jézer/Bianca 29/10).
  const primeiroNome = (s: string) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim().split(/\s+/)[0];
  return base.map((p: any) => {
    if (!p.conjuge?.nome || String(p.conjuge.cpf || '').replace(/\D/g, '').length === 11) return p;
    const outro = base.find((o: any) => o.ordem !== p.ordem && primeiroNome(o.nome) === primeiroNome(p.conjuge.nome) && o.cpf.length === 11);
    return outro ? { ...p, conjuge: { ...p.conjuge, cpf: outro.cpf } } : p;
  });
};

/** Coloca o card na fila. Erro em texto quando não dá. */
export async function pedirCadastroCaixa(accountId: string, leadId: string, por: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  if (!participantesDa(cf).length) return 'O card ainda não tem a ficha de cadastro (anotação "📋 FICHA DE CADASTRO — CAIXA")';
  await salvar(leadId, (c) => { c.status = 'FILA'; c.pedidoEm = new Date().toISOString(); c.por = por; c.consultas = {}; delete c.atual; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Card na fila da CAIXA (${por}): a extensão vai consultar o nome de cada participante em Oportunidades de Negócios e gravar o resultado aqui.` } }).catch(() => {});
  logActivity({ accountId, userId: null, userName: por, action: 'lead_edited', leadId, leadName: l.name, summary: 'colocou o card na fila do cadastro da CAIXA' } as any);
  return null;
}

/** Próximo trabalho da extensão: o 1º participante ainda sem consulta do card mais antigo na fila. Marca como "em consulta" (10 min). */
export async function proximaConsulta(accountId: string): Promise<any | null> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaCadastro'->>'status' = 'FILA'
    ORDER BY "customFields"->'_caixaCadastro'->>'pedidoEm' ASC LIMIT 10`;
  // Depois das consultas: cadastros pedidos (Fabio 29/10: "faz o cadastro da Bianca e da Adriana").
  const cads = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaCadastro'->'cadastros' IS NOT NULL
    ORDER BY "customFields"->'_caixaCadastro'->>'pedidoEm' ASC LIMIT 10`;
  // Depois: Avaliação de Risco (passo 2 — análise de crédito da CAIXA, Fabio 30/10).
  const avs = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaCadastro'->'avaliacao'->>'status' IN ('FILA', 'RODANDO')
    ORDER BY "customFields"->'_caixaCadastro'->'avaliacao'->>'pedidoEm' ASC LIMIT 10`;
  for (const { id } of [...ids, ...cads.filter((x) => !ids.some((y) => y.id === x.id)), ...avs.filter((x) => !ids.some((y) => y.id === x.id) && !cads.some((y) => y.id === x.id))]) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, customFields: true } });
    const cf = (l?.customFields || {}) as Cf;
    const c = cf._caixaCadastro || {};
    if (c.atual && Date.now() - Date.parse(c.atual.desde) < LEASE_MS) return null; // um por vez: espera o que está em andamento
    if (c.status !== 'FILA') {
      const ps = participantesDa(cf);
      // FILA, ou RODANDO que passou do prazo (a extensão largou no meio — volta pra fila, até 3 tentativas).
      const ordem = Object.entries(c.cadastros || {}).find(([, v]: [string, any]) => v?.status === 'FILA' || (v?.status === 'RODANDO' && v.inicio && Date.now() - Date.parse(v.inicio) > LEASE_MS && (v.tentativas || 0) < 3))?.[0];
      const pc = ordem && ps.find((x) => x.ordem === Number(ordem));
      if (!pc) {
        const av = c.avaliacao;
        const vez = av && (av.status === 'FILA' || (av.status === 'RODANDO' && av.inicio && Date.now() - Date.parse(av.inicio) > LEASE_MS && (av.tentativas || 0) < 3));
        if (!vez) continue;
        const quem = participantesDaAvaliacao(ps);
        if (quem.segurar) {
          await salvar(id, (x) => { x.avaliacao = { ...x.avaliacao, status: `SEGURADO: ${quem.segurar}`, fim: new Date().toISOString() }; });
          await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: `⏸️ Avaliação de Risco CAIXA não rodou: ${quem.segurar}. Na CAIXA só entra participante com renda (Fabio 31/10). Corrija a ficha/o card e peça a avaliação de novo.` } }).catch(() => {});
          const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
          sendPushToAccount(accountId, { title: `⏸️ ${l!.name}: Avaliação CAIXA segurada`, body: quem.segurar.slice(0, 120), leadId: id }).catch(() => {});
          continue;
        }
        const ajuste = await prisma.creditOverride.findFirst({ where: { leadId: id, bank: 'CAIXA' }, select: { data: true } }).catch(() => null);
        const operacao = operacaoDaAvaliacao(cf, [quem.tomador, ...quem.incluir], valorDe((ajuste?.data as Cf | null)?.prazo));
        if (typeof operacao === 'string') {
          await salvar(id, (x) => { x.avaliacao = { ...x.avaliacao, status: `SEGURADO: ${operacao}`, fim: new Date().toISOString() }; });
          await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: `⏸️ Avaliação de Risco CAIXA não rodou: ${operacao}. Corrija e peça de novo (painel CAIXA da Análise de Crédito).` } }).catch(() => {});
          continue;
        }
        const p1 = quem.tomador;
        await salvar(id, (x) => { x.atual = { ordem: 1, desde: new Date().toISOString(), tipo: 'avaliar' }; x.avaliacao = { ...x.avaliacao, status: 'RODANDO', inicio: new Date().toISOString(), tentativas: (x.avaliacao?.tentativas || 0) + 1 }; });
        return { tipo: 'avaliar', leadId: id, leadName: l!.name, ordem: 1, nome: p1.nome, cpf: p1.cpf, produto: av.produto, participantes: ps.map(({ fontes, faltando, ...x }: any) => x), incluir: quem.incluir.map((x) => ({ ordem: x.ordem, nome: x.nome, cpf: x.cpf })), fora: quem.fora.map((x) => x.nome), operacao };
      }
      await salvar(id, (x) => { x.atual = { ordem: pc.ordem, desde: new Date().toISOString(), tipo: 'cadastrar' }; x.cadastros[pc.ordem] = { ...x.cadastros[pc.ordem], status: 'RODANDO', inicio: new Date().toISOString(), tentativas: (x.cadastros[pc.ordem]?.tentativas || 0) + 1 }; });
      const { fontes, faltando, ...participante } = pc;
      const p1 = ps.find((x) => x.ordem === 1);
      return { tipo: 'cadastrar', leadId: id, leadName: l!.name, ordem: pc.ordem, nome: pc.nome, cpf: pc.cpf, participante, primeiro: p1 ? { endereco: p1.endereco } : null };
    }
    const p = participantesDa(cf).find((x) => !c.consultas?.[x.ordem]);
    if (!p) continue;
    if (p.cpf.length !== 11) {
      await salvar(id, (x) => { x.consultas = { ...(x.consultas || {}), [p.ordem]: { at: new Date().toISOString(), texto: 'SEM CPF na ficha nem no card — consulta não feita' } }; });
      await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: `⚠️ CAIXA: ${p.nome || `${p.ordem}º participante`} sem CPF na ficha nem no card — não consultei. Corrija o CPF no card.` } }).catch(() => {});
      continue;
    }
    await salvar(id, (x) => { x.atual = { ordem: p.ordem, desde: new Date().toISOString() }; });
    return { tipo: 'consultar', leadId: id, leadName: l!.name, ordem: p.ordem, nome: p.nome, cpf: p.cpf };
  }
  return null;
}

/** Resultado da consulta de um participante → anotação; todos consultados → CONSULTADO + push pra equipe cadastrar. */
export async function gravarConsulta(accountId: string, leadId: string, ordem: number, texto: string): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return;
  const p = participantesDa((l.customFields || {}) as Cf).find((x) => x.ordem === Number(ordem));
  const limpo = String(texto || '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 3500);
  const c = await salvar(leadId, (x) => { x.consultas = { ...(x.consultas || {}), [ordem]: { at: new Date().toISOString(), texto: limpo } }; delete x.atual; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 CAIXA — Oportunidades de Negócios (${ordem}º participante: ${p?.nome || '—'}), consultado pela extensão:\n\n${limpo}` } }).catch(() => {});
  const todos = participantesDa((l.customFields || {}) as Cf).every((x) => c.consultas?.[x.ordem]);
  if (!todos) return;
  await salvar(leadId, (x) => { x.status = 'CONSULTADO'; x.consultadoEm = new Date().toISOString(); });
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `🏦 ${l.name}: consulta da CAIXA pronta`, body: 'Resultado nas anotações. Quem está com a ficha completa já vai pro cadastro (a extensão preenche e o CRM confere).', leadId }).catch(() => {});
  await cadastroAutomatico(accountId, leadId).catch((e) => console.error('[CAIXA] cadastro automático:', e?.message));
}

/** Cards prontos pro cadastro (consultados) — a extensão mostra pra escolher na hora de preencher. */
export async function prontosParaCadastro(accountId: string): Promise<any[]> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaCadastro'->>'status' IN ('FILA', 'CONSULTADO')
    ORDER BY "customFields"->'_caixaCadastro'->>'pedidoEm' ASC LIMIT 30`;
  const out: any[] = [];
  for (const { id } of ids) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { id: true, name: true, customFields: true } });
    const cf = (l?.customFields || {}) as Cf;
    out.push({ leadId: id, leadName: l!.name, status: cf._caixaCadastro?.status, participantes: participantesDa(cf) });
  }
  return out;
}

/** Entra sozinho na fila: ficha pronta + cliente vai pela CAIXA. Roda no poller. Financiamento (Fabio 31/10, Fernanda): a CAIXA roda com a documentação
 *  completa — entra todo cliente do FH com ficha, menos quem já escolheu outro banco. Depois da consulta, o cadastro sai sozinho (cadastroAutomatico). */
export async function processFilaCaixa(accountId: string): Promise<void> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT l.id FROM "Lead" l LEFT JOIN "Pipeline" p ON p.id = l."pipelineId" LEFT JOIN "Department" d ON d.id = p."departmentId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND l."customFields"->'_fichaCadastral' IS NOT NULL AND l."customFields"->'_caixaCadastro' IS NULL
      AND (l."customFields"->'_fhCaixaAnswer'->>'resposta' = 'SIM' OR l."customFields"->>'_reentryCaixaAt' IS NOT NULL OR l."customFields"->'_bancosCombinados'->>'caixa' = 'true'
        OR l."customFields"->'_optouCaixa'->>'banco' = 'CAIXA'
        OR (d.name ~* 'habitacional|financiamento' AND COALESCE(UPPER(l."customFields"->'_fhChosen'->>'bank'), 'CAIXA') IN ('CAIXA', 'BRB'))
        OR (d.name ~* 'home|garantia' AND l."customFields"->'_fichaCadastral'->>'at' >= ${HE_CAIXA_DESDE}))
    LIMIT 5`;
  for (const { id } of ids) await pedirCadastroCaixa(accountId, id, 'automático (cliente vai pela CAIXA)').catch((e) => console.error('[CAIXA] fila:', e?.message));
  // Ficha completa depois (documento novo, CNPJ respondido) → cadastro de quem ainda não foi.
  const cands = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND jsonb_typeof("customFields"->'_fichaCadastral'->'participantes') = 'array'
      AND ("customFields"->'_caixaCadastro'->>'status' = 'CONSULTADO' OR jsonb_typeof("customFields"->'_caixaCadastro'->'cadastros') = 'object')
      AND jsonb_array_length("customFields"->'_fichaCadastral'->'participantes')
        > (SELECT count(*) FROM jsonb_object_keys(COALESCE("customFields"->'_caixaCadastro'->'cadastros', '{}'::jsonb)))
    LIMIT 10`;
  for (const { id } of cands) await cadastroAutomatico(accountId, id).catch((e) => console.error('[CAIXA] cadastro automático:', e?.message));
}

/** Quem entra na Avaliação de Risco (Fabio 31/10: "PARTICIPANTE NA CAIXA SÓ ENTRA SE TIVER RENDA"): o 1º participante é o tomador; dos outros, só quem tem
 *  renda na ficha (renda informal conta — semRenda false). O cadastro do cônjuge sem renda continua (não é desfeito), ele só não entra na avaliação. 1º sem
 *  renda ou participante com renda sem CPF → `segurar` (a equipe decide, nada vai à CAIXA). Pura. */
export function participantesDaAvaliacao(ps: any[]): { tomador: any | null; incluir: any[]; fora: any[]; segurar: string | null } {
  const tem = (p: any) => p && p.semRenda !== true;
  const tomador = ps.find((x) => x.ordem === 1) || null;
  const outros = ps.filter((x) => x.ordem !== 1);
  const incluir = outros.filter(tem), fora = outros.filter((x) => !tem(x));
  const semCpf = [tomador, ...incluir].filter((x) => x && String(x.cpf || '').length !== 11);
  const segurar = !tomador ? 'o card não tem o 1º participante na ficha'
    : !tem(tomador) ? `o 1º participante (${tomador.nome || '—'}) está SEM RENDA na ficha — quem é o tomador?`
    : semCpf.length ? `sem CPF: ${semCpf.map((x) => x.nome || `${x.ordem}º`).join(', ')}` : null;
  return { tomador, incluir, fora, segurar };
}

/** Consulta da CAIXA que mostra proposta ou avaliação em andamento em OUTRO correspondente (CCA): o cadastro automático espera a equipe. Pura. */
export function consultaSegura(textos: string[]): string | null {
  for (const t of textos) {
    if (/proposta solicitada em outro CCA/i.test(t) && !/n[aã]o possui proposta solicitada em outro CCA/i.test(t)) return 'proposta em outro correspondente (CCA)';
    if (/avalia[cç][aã]o em andamento/i.test(t) && !/n[aã]o possui avalia[cç][aã]o em andamento/i.test(t)) return 'avaliação de risco em andamento';
  }
  return null;
}

/** O que falta na ficha pro cadastro de um participante (CPF, identidade, o que a leitura apontou e — CR016, Fabio 31/10 — comprovante de renda dentro dos
 *  2 meses que a CAIXA aceita). Vazio = pronto. Pura. */
export function faltaParaCadastro(p: any, agora = new Date()): string[] {
  return [
    ...(String(p?.cpf || '').replace(/\D/g, '').length === 11 ? [] : ['CPF']),
    ...(String(p?.identidade?.numero || '').trim() ? [] : ['documento de identidade']),
    ...(Array.isArray(p?.faltando) ? p.faltando.map(String) : []),
    ...rendaForaDoPrazo(p, agora),
  ];
}

/** "Quando estiver tudo ok, a extensão da CAIXA ativa para fazer o cadastro do cliente" (Fabio 31/10): participante com a ficha completa e ainda sem cadastro →
 *  fila da extensão (que preenche pela ficha e o CRM confere tela a tela). Faltando dado → anotação + push uma vez por participante; a ficha é refeita quando
 *  chega documento novo e o cadastro sai na rodada seguinte. Consulta com proposta/avaliação em outro CCA → segura pra equipe. */
export async function cadastroAutomatico(accountId: string, leadId: string): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return;
  const cf = (l.customFields || {}) as Cf;
  const c = (cf._caixaCadastro || {}) as Cf;
  const cads = (c.cadastros || {}) as Record<string, any>;
  const pendentes = participantesDa(cf).filter((p) => !cads[p.ordem]);
  if (!pendentes.length) return;
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  const motivo = consultaSegura(Object.values(c.consultas || {}).map((x: any) => String(x?.texto || '')));
  if (motivo) {
    if (c.autoSeguradoAt) return;
    await salvar(leadId, (x) => { x.autoSeguradoAt = new Date().toISOString(); });
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Cadastro na CAIXA NÃO saiu sozinho: a consulta mostra ${motivo}. Confira e, se for seguir, peça o cadastro pela tela.` } }).catch(() => {});
    sendPushToAccount(accountId, { title: `🏦 ${l.name}: CAIXA segurada`, body: `Consulta com ${motivo} — cadastro automático parado.`, leadId }).catch(() => {});
    return;
  }
  const prontos = pendentes.filter((p) => !faltaParaCadastro(p).length).map((p) => p.ordem);
  if (prontos.length) await pedirCadastroParticipantes(accountId, leadId, prontos, 'CRM (ficha completa)');
  const avisar = pendentes.filter((p) => faltaParaCadastro(p).length && !c.faltaAvisada?.[p.ordem]);
  if (!avisar.length) return;
  await salvar(leadId, (x) => { x.faltaAvisada = { ...(x.faltaAvisada || {}), ...Object.fromEntries(avisar.map((p) => [p.ordem, new Date().toISOString()])) }; });
  const linhas = avisar.map((p) => `• ${p.nome || `${p.ordem}º participante`}: falta ${faltaParaCadastro(p).join(', ')}`);
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Cadastro na CAIXA esperando a ficha completa (lida dos documentos da conversa/pasta):\n${linhas.join('\n')}\nQuando chegar o documento com o dado, a ficha é refeita e o cadastro sai sozinho.` } }).catch(() => {});
  sendPushToAccount(accountId, { title: `🏦 ${l.name}: cadastro CAIXA esperando dado`, body: linhas.join(' ').slice(0, 160), leadId }).catch(() => {});
}

/** Conferência do cadastro (Fabio 29/10: "orientar o CRM para que ele faça a conferência dos dados"): a extensão manda o que ficou em cada campo da tela
 *  do Caixa Aqui e a IA compara com a ficha do participante (lida dos documentos). Anotação no card + resposta pra extensão mostrar. */
const SYSTEM_CONFERE = `Você confere um CADASTRO de cliente preenchido no portal da CAIXA (Caixa Aqui) contra a FICHA DE CADASTRO do participante (dados lidos dos documentos dele).
Recebe a lista de campos da tela (rótulo e valor que ficou) e a ficha. Compare campo a campo o que existe nos dois: nome, CPF, nascimento, sexo, identidade (tipo, número, órgão, UF, emissão), naturalidade, nacionalidade, filiação, estado civil, regime, cônjuge, endereço/CEP, telefone, e-mail, trabalho e renda.
Regras da A&F (Fabio 29/10 — NÃO são divergência): a identidade é a do documento apresentado (com CNH, vale o número de registro, órgão "ÓRGÃO DE TRÂNSITO" e UF/emissão da CNH; com RG — inclusive a identidade nova, CIN, cujo número é o próprio CPF —, subtipo CARTEIRA DE IDENTIDADE e o órgão emissor pela lista da CAIXA, que só tem SSP, Polícia Civil, Defesa Social, Casa Civil e Outro: Instituto de Identificação/Polícia Civil da UF (ex.: "INSTITUTO DE IDENTIFICAÇÃO PCDF", "PC/GO") = POLÍCIA CIVIL, SSP/SESP = SECRETARIA DE SEGURANÇA PÚBLICA, órgão fora da lista = OUTRO TIPO DE ÓRGÃO EMISSOR); CNH vencida não é problema; participante SEM RENDA vai com Tipo de Ocupação FORMAL e Ocupação ADMINISTRADOR; bairro vale o do comprovante de residência (a consulta do CEP pode trazer outro nome — não é divergência se a tela tem o do comprovante); tipo de imóvel CASA e ocupação do imóvel PRÓPRIA QUITADA são padrão da A&F; a lista de ocupações da CAIXA não tem todos os cargos — a opção MAIS PARECIDA com o cargo da ficha vale (ex.: "Analista PCPM Sr" → ANALISTA DE SISTEMAS); SERVIDOR PÚBLICO (vínculo servidor/órgão público — Fabio 31/10, Fernanda) vai como SERVIDOR PÚBLICO ESTADUAL/FEDERAL/MUNICIPAL pela esfera do órgão, mesmo com cargo específico (assessor de juiz no TJ do Estado = SERVIDOR PÚBLICO ESTADUAL — nunca a ocupação de juiz/desembargador pra quem é assessor); RENDA LANÇADA (Fabio 31/10): de cada fonte vale o contracheque VÁLIDO (competência dos 2 últimos meses — a CAIXA recusa mais antigo) MAIS RECENTE; um mais antigo só vale se a renda bruta dele passa a do mais recente em MAIS DE R$ 1.000 (bruta igual ou parecida com líquido diferente = o mais recente); o IMPOSTO DE RENDA RETIDO NA FONTE do contracheque (irRetido) TEM que estar no campo de IR retido — vazio/0,00 com desconto de IR no contracheque = "faltando"; aposentadoria vai com comprovante EXTRATO DE BENEFÍCIO PREVIDENCIÁRIO; SÓCIO (Fabio 31/10 — a CAIXA não aceita pró-labore nem DECORE): renda = distribuição de lucros do imposto de renda ÷ 12, comprovante DECLARAÇÃO DE IMPOSTO DE RENDA, ocupação PROPRIETÁRIO DE ESTABELECIMENTO COMERCIAL ou DIRETOR DE EMPRESAS (as duas valem), referência = dezembro do ano-calendário (não é "contracheque vencido"), admissão = entrada na sociedade/abertura da empresa, sem IR retido; MAIS DE UMA RENDA: a profissão/ocupação da 1ª tela é a da MAIOR renda, igual à ocupação lançada na renda dela, e cada renda leva a ocupação DELA; renda de aposentadoria (fundo de previdência/seguridade, INSS, "outrasRendas" aposentadoria) = APOSENTADO (EXCETO FUNCIONÁRIO PÚBLICO), sem a data de admissão do outro emprego — não é divergência ocupação APOSENTADO com o cargo de outro emprego na ficha; grau de instrução é sempre SUPERIOR COMPLETO; o nome reduzido abrevia os nomes do meio e nunca o último sobrenome; estado civil e regime vêm juntos ("CASADO (A) COM COMUNHÃO PARCIAL DE BENS"); comunhão UNIVERSAL de bens é a COMUNHÃO TOTAL DE BENS da lista da CAIXA (mesmo regime); Declaração de Propósitos = só Movimentação de Conta e Empréstimos/Financiamentos com Financiamento Habitacional SIM; formato diferente (maiúsculas, acento, pontuação, máscara de CPF/CEP/data) NÃO é divergência; campo que EXISTE na tela e ficou vazio, mas a ficha tem = "faltando"; campo que NÃO aparece nesta tela = ignore (o cadastro da CAIXA tem várias páginas: dados pessoais na 1ª, endereço/telefone/e-mail na 2ª — nunca cobre o que é de outra página); campo que a ficha não tem = ignore.
Responda SOMENTE com JSON: {"ok": true|false, "divergencias": ["<campo: na tela X, na ficha Y>"], "faltando": ["<campo que a ficha tem e a tela deixou vazio>"], "resumo": "<1 frase>"}`;

export async function conferirCadastro(accountId: string, leadId: string, ordem: number, campos: { rotulo: string; valor: string }[]): Promise<{ ok: boolean; divergencias: string[]; faltando: string[]; resumo: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return null;
  const p = participantesDa((l.customFields || {}) as Cf).find((x) => x.ordem === Number(ordem));
  if (!p) return null;
  const { fontes, faltando, ...ficha } = p;
  // Normativo CR016 da Base de Conhecimento (Fabio 31/10) pra conferir a renda da tela.
  const system = comRegrasCaixa(SYSTEM_CONFERE, await regrasRendaCaixa(accountId), 'Use o normativo pra conferir a RENDA da tela — tipo de comprovante, competência/data de referência, fonte pagadora, ocupação, renda bruta/líquida e IR retido — no que a ficha e as regras da A&F não resolvem: renda lançada fora do normativo é divergência, citando a regra (ex.: "renda: data de referência 06/2026 — fora do prazo do normativo").');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 8192, system, messages: [{ role: 'user', content: [{ type: 'text', text: `Hoje é ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.\n\nFICHA:\n${JSON.stringify(ficha)}\n\nCAMPOS DA TELA:\n${JSON.stringify(campos.slice(0, 200))}` }] }] }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const data = (await res.json()) as { content: { type: string; text?: string }[] };
  let r: any;
  try { r = JSON.parse((data.content?.find((b) => b.type === 'text')?.text || '').match(/\{[\s\S]*\}/)?.[0] || ''); } catch { return null; }
  const out: { ok: boolean; divergencias: string[]; faltando: string[]; resumo: string } = { ok: !!r.ok, divergencias: Array.isArray(r.divergencias) ? r.divergencias.map(String) : [], faltando: Array.isArray(r.faltando) ? r.faltando.map(String) : [], resumo: String(r.resumo || '') };
  const linhas = [...out.divergencias.map((d) => `• ❌ ${d}`), ...out.faltando.map((f) => `• ⚠️ vazio na tela: ${f}`)];
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔎 Conferência do cadastro na CAIXA — ${ordem}º participante (${p.nome || '—'}): ${out.ok && !linhas.length ? '✅ tudo confere com os documentos.' : 'precisa corrigir antes de gravar:'}${linhas.length ? `\n${linhas.join('\n')}` : ''}${out.resumo ? `\n${out.resumo}` : ''}` } }).catch(() => {});
  await salvar(leadId, (x) => { x.conferencias = { ...(x.conferencias || {}), [ordem]: { at: new Date().toISOString(), ok: out.ok && !linhas.length } }; });
  return out;
}

/** Pede o cadastro de participantes na CAIXA (a extensão faz: CPF → formulário preenchido pela ficha → conferência do CRM). */
export async function pedirCadastroParticipantes(accountId: string, leadId: string, ordens: number[], por: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const ps = participantesDa((l.customFields || {}) as Cf);
  const validos = ordens.filter((o) => ps.some((p) => p.ordem === o));
  if (!validos.length) return 'Participante não está na ficha';
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}) }; for (const o of validos) x.cadastros[o] = { status: 'FILA', pedidoEm: new Date().toISOString(), por }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Cadastro na CAIXA pedido (${por}) para: ${validos.map((o) => ps.find((p) => p.ordem === o)?.nome || `${o}º`).join(', ')}. A extensão preenche pela ficha e o CRM confere.` } }).catch(() => {});
  return null;
}

/** Ficha refeita com documento novo da pasta (Fabio 29/10 — Bianca sem RG/CNH): o cadastro que não saiu porque faltava a identidade e agora a ficha tem → volta pra fila. */
export async function reenfileirarComFichaNova(leadId: string, antes: any[]): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cf = (l?.customFields || {}) as Cf;
  const cads = (cf._caixaCadastro?.cadastros || {}) as Record<string, any>;
  const temId = (p: any) => !!String(p?.identidade?.numero || '').trim();
  const ps = participantesDa(cf);
  const voltar = Object.entries(cads)
    .filter(([o, v]) => v && !['GRAVADO', 'FILA', 'RODANDO'].includes(String(v.status)) && !temId(antes.find((p: any, i: number) => (Number(p.ordem) || i + 1) === Number(o))) && temId(ps.find((p) => p.ordem === Number(o))))
    .map(([o]) => Number(o));
  if (!voltar.length) return;
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}) }; for (const o of voltar) x.cadastros[o] = { status: 'FILA', pedidoEm: new Date().toISOString(), por: 'CRM (documento novo)' }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Chegou o documento de identidade de ${voltar.map((o) => ps.find((p) => p.ordem === o)?.nome || `${o}º`).join(', ')} — a ficha foi refeita e o cadastro na CAIXA voltou pra fila da extensão.` } }).catch(() => {});
}

/** Dado novo na ficha (resposta do cliente com CNPJ/admissão — Fabio 30/10): cadastro da CAIXA que não saiu (nem gravado, nem na fila/rodando) volta pra fila. */
export async function reenfileirarCadastrosPendentes(leadId: string, motivo: string): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cads = (((l?.customFields || {}) as Cf)._caixaCadastro?.cadastros || {}) as Record<string, any>;
  const voltar = Object.entries(cads).filter(([, v]) => v && !['GRAVADO', 'FILA', 'RODANDO'].includes(String(v.status))).map(([o]) => Number(o));
  if (!voltar.length) return;
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}) }; for (const o of voltar) x.cadastros[o] = { status: 'FILA', pedidoEm: new Date().toISOString(), por: `CRM (${motivo})` }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Cadastro na CAIXA de volta pra fila da extensão (${motivo}).` } }).catch(() => {});
}

/** Formulário do cadastro ("Imprimir Formulário" da tela final da CAIXA, PDF) → subpasta FORMULARIOS da pasta do cliente no Drive (Fabio 30/10).
 *  A assinatura do cliente na ficha da CAIXA fica pra contratação. Cadastro refeito: troca o arquivo de mesmo nome. */
export async function salvarFormularioCaixa(accountId: string, leadId: string, ordem: number, pdfBase64: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const link = String(cf.link_pasta_drive || '').trim();
  if (!link) return 'O card não tem a pasta do Drive';
  const data = Buffer.from(String(pdfBase64 || ''), 'base64');
  if (data.length < 1000 || data.subarray(0, 4).toString('latin1') !== '%PDF') return 'O arquivo do formulário não é um PDF';
  const p = participantesDa(cf).find((x) => x.ordem === Number(ordem));
  const quem = String(p?.nome || `${ordem}º participante`).toUpperCase();
  const nome = `FICHA CADASTRAL CAIXA - ${quem}.pdf`;
  const google = await import('./google.service');
  const pasta = await google.createFolder(accountId, 'FORMULARIOS', google.extractFolderId(link));
  for (const velho of (await google.listFolderContents(accountId, pasta.id)).filter((f) => f.name === nome)) await google.trashDriveItem(accountId, velho.id).catch(() => {});
  const up = await google.uploadFile(accountId, { name: nome, mimeType: 'application/pdf', parentId: pasta.id, data });
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}), [ordem]: { ...(x.cadastros?.[ordem] || {}), formulario: up.id } }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📄 Formulário do cadastro na CAIXA de ${quem} salvo na pasta FORMULARIOS do Drive (${nome}). A assinatura do cliente fica pra contratação.` } }).catch(() => {});
  return null;
}

/** Avaliação de Risco da CAIXA (passo 2, Fabio 30/10: "vamos rodar a análise de crédito do Jézer"). Produto pelo setor: Home Equity → "11 - Empréstimo com
 *  Garantia de Imóvel (EGI)"; Financiamento → "1 - Crédito Imobiliário". 1ª fase: a extensão abre, consulta o CPF, marca o produto e PARA mostrando a tela (mapa). */
export async function pedirAvaliacao(accountId: string, leadId: string, por: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!l) return 'Lead não encontrado';
  const ps = participantesDa((l.customFields || {}) as Cf);
  if (!ps.length) return 'O card ainda não tem a ficha de cadastro';
  const produto = /home|garantia/i.test(l.pipeline?.department?.name || '') ? '11 - empréstimo com garantia de imóvel' : '1 - crédito imobiliário';
  const quem = participantesDaAvaliacao(ps);
  await salvar(leadId, (x) => { x.avaliacao = { status: 'FILA', pedidoEm: new Date().toISOString(), por, produto }; });
  const lista = [quem.tomador && `${quem.tomador.nome} (tomador)`, ...quem.incluir.map((x) => x.nome)].filter(Boolean).join(', ');
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Avaliação de Risco na CAIXA pedida (${por}) — produto "${produto.toUpperCase()}". Participantes: ${lista || '—'}${quem.fora.length ? `; fora por não ter renda: ${quem.fora.map((x) => x.nome).join(', ')} (o cadastro na CAIXA fica como está)` : ''}. A extensão consulta o CPF, marca o produto e mostra a tela antes de enviar.` } }).catch(() => {});
  return null;
}
export async function gravarAvaliacao(accountId: string, leadId: string, r: { status: string; texto: string }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!l) return;
  await salvar(leadId, (x) => { x.avaliacao = { ...(x.avaliacao || {}), status: r.status, fim: new Date().toISOString() }; delete x.atual; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Avaliação de Risco CAIXA: ${r.status}\n\n${String(r.texto || '').slice(0, 3500)}` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `🏦 ${l.name}: Avaliação de Risco CAIXA`, body: r.status.slice(0, 120), leadId }).catch(() => {});
}

/** Resultado do cadastro vindo da extensão (preenchido + conferência; salvo ou parado antes de salvar). */
export async function gravarCadastro(accountId: string, leadId: string, ordem: number, r: { status: string; texto: string }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return;
  const p = participantesDa((l.customFields || {}) as Cf).find((x) => x.ordem === Number(ordem));
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}), [ordem]: { ...(x.cadastros?.[ordem] || {}), status: r.status, fim: new Date().toISOString() } }; delete x.atual; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Cadastro na CAIXA — ${ordem}º participante (${p?.nome || '—'}): ${r.status}\n\n${String(r.texto || '').slice(0, 3500)}` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `🏦 ${l.name}: cadastro CAIXA (${p?.nome || `${ordem}º`})`, body: r.status, leadId }).catch(() => {});
  if (/^GRAVADO/i.test(r.status)) await pedirConferencia(accountId, leadId).catch((e) => console.error('[CAIXA] conferência:', e?.message));
}

const gravado = (c: Cf, ordem: number) => /^GRAVADO/i.test(String(c.cadastros?.[ordem]?.status || ''));

/** Todos os participantes da ficha com o cadastro GRAVADO → a equipe confere na CAIXA (Fabio 31/10: "depois que cadastrar chega um push no CRM para conferir
 *  o cadastro; depois de o colaborador conferir é que ele roda [a avaliação]"). Uma vez por card; o botão fica no painel CAIXA da Análise de Crédito. */
async function pedirConferencia(accountId: string, leadId: string): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, customFields: true } });
  const cf = (l?.customFields || {}) as Cf;
  const c = cf._caixaCadastro || {};
  const ps = participantesDa(cf);
  if (!l || !ps.length || c.conferencia || !ps.every((p) => gravado(c, p.ordem))) return;
  await salvar(leadId, (x) => { x.conferencia = { status: 'PENDENTE', desde: new Date().toISOString() }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔎 Cadastro na CAIXA gravado (${ps.map((p) => p.nome).join(', ')}): CONFIRA no Caixa Aqui. Estando certo, clique em "Cadastro conferido" no painel CAIXA da Análise de Crédito — no Home Equity a Avaliação de Risco roda em seguida.` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `🔎 ${l.name}: conferir o cadastro da CAIXA`, body: 'Cadastro gravado. Confira e clique em "Cadastro conferido" (Análise de Crédito → CAIXA).', leadId }).catch(() => {});
}

/** "Cadastro conferido" (botão do painel CAIXA): marca quem conferiu e, no Home Equity, pede a Avaliação de Risco. Erro em texto quando não dá. */
export async function marcarConferido(accountId: string, leadId: string, por: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const c = cf._caixaCadastro || {};
  const ps = participantesDa(cf);
  if (!ps.length) return 'O card não tem a ficha de cadastro';
  const falta = ps.filter((p) => !gravado(c, p.ordem));
  if (falta.length) return `Cadastro ainda não gravado na CAIXA: ${falta.map((p) => p.nome || `${p.ordem}º`).join(', ')}`;
  const he = ehHe(l.pipeline?.department?.name);
  await salvar(leadId, (x) => { x.conferencia = { ...(x.conferencia || {}), status: 'CONFERIDO', por, em: new Date().toISOString() }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `✅ Cadastro na CAIXA conferido por ${por}.${he ? ' A Avaliação de Risco foi pra fila da extensão.' : ' No Financiamento a Avaliação de Risco não roda sozinha.'}` } }).catch(() => {});
  return he ? pedirAvaliacao(accountId, leadId, `${por} (cadastro conferido)`) : null;
}

const valorDe = (v: any): number | null => {
  if (typeof v === 'number') return v > 0 ? v : null;
  let s = String(v ?? '').replace(/[^\d,.]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return s && Number.isFinite(n) && n > 0 ? n : null;
};

/** Tela "Informações da Operação" da Avaliação de Risco (Fabio 31/10): PRICE, TR, garantia = alienação fiduciária, prazo máximo (240; outro só quando o
 *  cliente pede — ajuste "prazo" da CAIXA), imóvel e crédito da proposta do card, prestação necessária = 30% da renda BRUTA de quem entra na avaliação. Pura. */
export function operacaoDaAvaliacao(cf: Cf, pessoas: any[], prazoPedido?: number | null): Record<string, any> | string {
  const imovel = valorDe(cf.valor_imovel), credito = valorDe(cf.valor_credito);
  const renda = pessoas.reduce((t, p) => t + (valorDe(p?.rendaBrutaMensal) || valorDe(p?.contracheques?.[0]?.bruto) || 0), 0);
  if (!imovel || !credito) return 'valor do imóvel ou do crédito vazio no card';
  if (!renda) return 'renda bruta vazia na ficha';
  return { portabilidade: 'NAO', origem: 'CAIXA', prazo: prazoPedido && prazoPedido > 0 ? Math.round(prazoPedido) : 240, valorImovel: imovel, valorFinanciamento: credito,
    rendaBruta: Math.round(renda * 100) / 100, prestacao: Math.round(renda * 0.3 * 100) / 100, garantia: 'alienacao fiduciaria', amortizacao: 'PRICE', indexador: 'TR' };
}

/** Botão "Fazer cadastro" do painel CAIXA (Fabio 31/10: "preciso de um botão também para fazer o cadastro do cliente quando não rodar sozinho"):
 *  sem nada na CAIXA → fila da consulta (o cadastro sai em seguida); já consultado → cadastro de quem ainda não está GRAVADO, mesmo com a ficha incompleta
 *  (a extensão para e mostra o que faltou). */
export async function fazerCadastroManual(accountId: string, leadId: string, por: string): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const c = cf._caixaCadastro;
  const ps = participantesDa(cf);
  if (!ps.length) return 'O card ainda não tem a ficha de cadastro (lida dos documentos da pasta ou da conversa)';
  if (!c || (c.status !== 'FILA' && !ps.some((p) => c.consultas?.[p.ordem]))) return pedirCadastroCaixa(accountId, leadId, por);
  if (c.status === 'FILA') return 'Já está na fila da CAIXA (consulta do nome em andamento)';
  const ordens = ps.filter((p) => !gravado(c, p.ordem) && !['FILA', 'RODANDO'].includes(String(c.cadastros?.[p.ordem]?.status || ''))).map((p) => p.ordem);
  if (!ordens.length) return ps.every((p) => gravado(c, p.ordem)) ? 'Todos os participantes já estão cadastrados (GRAVADO)' : 'O cadastro já está na fila/rodando';
  return pedirCadastroParticipantes(accountId, leadId, ordens, por);
}

/** Painel CAIXA da Análise de Crédito: cards com cadastro na CAIXA (sem CPF) — rodando, conferir, avaliação — e os que têm ficha e ainda não foram pra CAIXA. */
export async function painelCaixa(accountId: string): Promise<any[]> {
  const rows = await prisma.$queryRaw<{ id: string; name: string; c: Cf; ps: any; dept: string | null }[]>`
    SELECT l.id, l.name, l."customFields"->'_caixaCadastro' AS c, l."customFields"->'_fichaCadastral'->'participantes' AS ps, d.name AS dept
    FROM "Lead" l LEFT JOIN "Pipeline" p ON p.id = l."pipelineId" LEFT JOIN "Department" d ON d.id = p."departmentId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."customFields"->'_caixaCadastro' IS NOT NULL
    ORDER BY l."updatedAt" DESC LIMIT 80`;
  return rows.map((r) => {
    const c = r.c || {};
    const ps = (Array.isArray(r.ps) ? r.ps : []).map((p: any, i: number) => ({ ordem: Number(p.ordem) || i + 1, nome: p.nome || '', semRenda: p.semRenda === true }));
    const atual = c.atual && Date.now() - Date.parse(c.atual.desde) < LEASE_MS ? { tipo: c.atual.tipo || 'consultar', ordem: c.atual.ordem, desde: c.atual.desde } : null;
    return {
      leadId: r.id, nome: r.name, produto: ehHe(r.dept) ? 'HE' : 'FH', status: c.status || null, atual,
      participantes: ps.map((p: any) => ({ ...p, cadastro: c.cadastros?.[p.ordem]?.status || null, consultado: !!c.consultas?.[p.ordem] })),
      conferencia: c.conferencia || null,
      avaliacao: c.avaliacao ? { status: c.avaliacao.status, pedidoEm: c.avaliacao.pedidoEm || null, fim: c.avaliacao.fim || null } : null,
    };
  });
}
export async function semCadastroCaixa(accountId: string): Promise<any[]> {
  const rows = await prisma.$queryRaw<{ id: string; name: string; ps: any; dept: string | null; at: string | null }[]>`
    SELECT l.id, l.name, l."customFields"->'_fichaCadastral'->'participantes' AS ps, d.name AS dept, l."customFields"->'_fichaCadastral'->>'at' AS at
    FROM "Lead" l LEFT JOIN "Pipeline" p ON p.id = l."pipelineId" LEFT JOIN "Department" d ON d.id = p."departmentId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND jsonb_typeof(l."customFields"->'_fichaCadastral'->'participantes') = 'array' AND l."customFields"->'_caixaCadastro' IS NULL
    ORDER BY l."customFields"->'_fichaCadastral'->>'at' DESC NULLS LAST LIMIT 30`;
  return rows.map((r) => ({ leadId: r.id, nome: r.name, produto: ehHe(r.dept) ? 'HE' : 'FH', fichaEm: r.at, participantes: (Array.isArray(r.ps) ? r.ps : []).map((p: any) => p.nome || '').filter(Boolean) }));
}
