import { prisma } from '../lib/prisma';
import { logActivity } from './activity.service';
import { comRegrasCaixa, regrasRendaCaixa, rendaForaDoPrazo } from './caixa-cr016';
import { comEmissaoDoRg } from './rg-emissao';

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
const ehHe = (dept: string | null | undefined) => /home|garantia/i.test(dept || '');
// "Cadastro conferido" pede a Avaliação de Risco do HE sozinho? DESLIGADO — Fabio 31/10: "NÃO RODA NENHUM CRÉDITO, ACOMPANHA OS CADASTROS". Só ele libera.
export const AVALIACAO_APOS_CONFERENCIA = false;
const LEASE_MS = 10 * 60_000; // participante "em consulta" há mais que isso = a extensão largou; volta pra fila
const CONSULTA_MAX_TENTATIVAS = 2; // respostas da CAIXA sem resultado antes de o card sair da fila
const CONSULTA_PARADA = 'CONSULTA_PARADA';

async function salvar(leadId: string, mut: (c: Cf) => void): Promise<Cf> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const c: Cf = { ...(((l?.customFields || {}) as Cf)._caixaCadastro || {}) };
  mut(c);
  // Grava SÓ a chave _caixaCadastro (jsonb_set): regravar o card inteiro trazia de volta chaves que outro processo tinha acabado de tirar (Jézer 29/10).
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaCadastro}', ${JSON.stringify(c)}::jsonb, true) WHERE id = ${leadId}`;
  return c;
}

/** A ficha de cadastro (lida dos documentos) já existe? Sem ela só dá pra CONSULTAR — o cadastro espera. */
const temFicha = (cf: Cf): boolean => Array.isArray(cf._fichaCadastral?.participantes) && cf._fichaCadastral.participantes.length > 0;

/** Órgão emissor da identidade no nome da lista da CAIXA — mesma regra da extensão (orgaoDaIdentidade): CNH = ÓRGÃO DE TRÂNSITO; Instituto de Identificação/Polícia
 *  Civil da UF/SSP/SESP = SECRETARIA DE SEGURANÇA PÚBLICA (Fabio 01/11: "deveria ser SESP ou SSP"). Pura. */
export function orgaoCaixa(id: { tipo?: string; orgao?: string } | null | undefined): string | undefined {
  if (!id) return undefined;
  if (String(id.tipo || '').toUpperCase() === 'CNH') return 'ÓRGÃO DE TRÂNSITO';
  const o = String(id.orgao || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (!o.trim()) return id.orgao;
  if (/defesa social|\bsds\b/.test(o)) return 'SECRETARIA DEFESA SOCIAL';
  if (/casa civil/.test(o)) return 'SECRETARIA DE ESTADO DA CASA CIVIL';
  if (/seguranca|\bssp|\bsesp|\bsejusp|\bigp\b|policia civil|instituto de identifica|\bpc[ /-]?[a-z]{2}\b|\bii[ /-]?[a-z]{2}\b|\bdgpc\b/.test(o)) return 'SECRETARIA DE SEGURANÇA PÚBLICA';
  return 'OUTRO TIPO DE ÓRGÃO EMISSOR';
}

/** Crédito já rodado na CAIXA (Avaliação de Risco enviada/rodando ou resultado gravado). Daí em diante o CRM NÃO mexe sozinho no cadastro — mexer depois pede a
 *  "2ª autorização do PV" (Fabio 01/11: "SE JÁ TIVER RODADO O CRÉDITO E O CLIENTE DESEJAR ALTERAR O CADASTRO, VERIFICAR COM A EQUIPE ANTES, NÃO MEXER NO CADASTRO";
 *  antes disso "pode mexer tranquilo"). O botão da equipe continua valendo. Pura. */
export const avaliacaoFeita = (cf: Cf): boolean => !!cf._caixaResultado || /ENVIAD|RODANDO/i.test(String(cf._caixaCadastro?.avaliacao?.status || ''))
  || (Array.isArray(cf._caixaCadastro?.avaliacao?.anteriores) && cf._caixaCadastro.avaliacao.anteriores.some((a: any) => a?.chegouNaCaixa)); // rodada de novo (Fabio 03/11): a anterior que chegou à CAIXA conta

/** Cadastro automático segurado porque o crédito já rodou: nota + push pra equipe, uma vez por motivo. */
async function segurarPosAvaliacao(leadId: string, motivo: string): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true, accountId: true, customFields: true } });
  if (!l) return;
  const ja = ((l.customFields || {}) as Cf)._caixaCadastro?.seguradoPosAvaliacao || {};
  if (ja[motivo]) return;
  await salvar(leadId, (x) => { x.seguradoPosAvaliacao = { ...(x.seguradoPosAvaliacao || {}), [motivo]: new Date().toISOString() }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `✋ CAIXA: ${motivo}, mas o crédito na CAIXA já foi rodado (Avaliação de Risco) — o CRM não mexe sozinho no cadastro (alterar depois pede a 2ª autorização do PV). A equipe decide; pra alterar, peça o cadastro pela tela.` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(l.accountId, { title: `✋ ${l.name}: alterar cadastro CAIXA?`, body: `${motivo} — crédito já rodado, a equipe decide`.slice(0, 160), leadId }).catch(() => {});
}

/** CNPJ válido (14 dígitos e dígitos verificadores). Pura. */
export function cnpjValido(v: unknown): boolean {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const dv = (base: string) => { let s = 0, w = base.length - 7; for (const ch of base) { s += Number(ch) * w; w = w === 2 ? 9 : w - 1; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(d.slice(0, 12)) === Number(d[12]) && dv(d.slice(0, 13)) === Number(d[13]);
}

/** CNPJ e data de admissão da fonte de renda informados pela equipe (Fabio 10/11, Deborah: a admissão veio em foto da ficha funcional do SIAPE e nenhum
 *  documento traz o CNPJ) — `cnpj_renda_N` / `admissao_renda_N` mandam na ficha e continuam valendo quando ela é refeita. Valem pro emprego da ficha
 *  (`trabalho`) e os contracheques dele; aposentadoria, pensão e lucros ficam como estão. Pura. */
export function comRendaInformada(p: any, cf: Cf, n: number): any {
  const cnpj = String(cf[`cnpj_renda_${n}`] || '').replace(/\D/g, '');
  const admissao = String(cf[`admissao_renda_${n}`] || '').trim();
  const temCnpj = cnpj.length === 14, temAdm = /^\d{2}\/\d{2}\/\d{4}$/.test(admissao);
  if (!temCnpj && !temAdm) return p;
  const t = p?.trabalho || {};
  const chave = (s: unknown) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim().split(/\s+/).slice(0, 2).join(' ');
  const doEmprego = (c: any) => !/aposent|pens|lucro|labore/i.test(String(c?.tipo || '')) && (!c?.empregador || !t.empregador || chave(c.empregador) === chave(t.empregador));
  const novo = { ...(temCnpj ? { cnpj } : {}), ...(temAdm ? { admissao } : {}) };
  return {
    ...p,
    trabalho: { ...t, ...novo },
    contracheques: (Array.isArray(p?.contracheques) ? p.contracheques : []).map((c: any) => (doEmprego(c) ? { ...c, ...novo } : c)),
    faltando: (Array.isArray(p?.faltando) ? p.faltando : []).filter((f: unknown) => !((temCnpj && /cnpj/i.test(String(f))) || (temAdm && /admiss/i.test(String(f))))),
  };
}

/** Mês/ano do comprovante de residência informado pela equipe (Fabio 11/11, Deborah: a ficha leu o endereço da apólice do seguro, que não tem mês, e a conta
 *  do mesmo endereço está no nome de outra pessoa) — `comprovante_residencia_N` ("mm/aaaa") manda no da ficha e continua valendo quando ela é refeita. Pura. */
export function comComprovanteInformado(p: any, cf: Cf, n: number): any {
  const m = /^(\d{2})\/(\d{4})$/.exec(String(cf[`comprovante_residencia_${n}`] || '').trim());
  return m ? { ...p, endereco: { ...(p?.endereco || {}), comprovanteMesAno: `${m[1]}/${m[2]}` } } : p;
}

export const participantesDa = (cf: Cf): any[] => {
  // Sem ficha ainda (Fabio 01/11: "a consulta ocorre assim que o cliente indicar querer fazer com a CAIXA e a pergunta dos requisitos saírem", antes dos documentos):
  // nomes e CPFs da proposta (participante_N / cpf_N), só pra consulta.
  const ps = temFicha(cf) ? cf._fichaCadastral.participantes
    : [1, 2, 3, 4].filter((n) => String(cf[`participante_${n}`] || '').trim()).map((n) => ({ ordem: n, nome: String(cf[`participante_${n}`]).trim(), daProposta: true }));
  // Ficha já gravada sem a data do RG que a conferência de documentos leu no verso (Fabio 10/11, Sueli): completa na leitura, sem esperar a ficha ser refeita.
  const base = comEmissaoDoRg(ps, [], temFicha(cf) ? cf._docReview : {}).map((p: any, i: number) => {
    const n = Number(p.ordem) || i + 1;
    // Estado civil informado pela equipe (Fabio 09/11: divórcio recente, sem documento na pasta) manda no da ficha e continua valendo quando ela é refeita.
    const estadoCivil = String(cf[`estado_civil_${n}`] || '').trim();
    return comComprovanteInformado(comRendaInformada({ ...p, ordem: n, cpf: String(p.cpf || cf[`cpf_${n}`] || '').replace(/\D/g, ''), telefone: cf[`telefone_${n}`] || '', email: cf[`email_${n}`] || '', ...(estadoCivil ? { estadoCivil, faltando: (Array.isArray(p.faltando) ? p.faltando : []).filter((f: unknown) => !/estado civil/i.test(String(f))) } : {}) }, cf, n), cf, n);
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
export async function pedirCadastroCaixa(accountId: string, leadId: string, por: string, userId: string | null = null): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  if (!participantesDa(cf).length) return 'O card ainda não tem a ficha de cadastro (anotação "📋 FICHA DE CADASTRO — CAIXA") nem os participantes da proposta';
  await salvar(leadId, (c) => { c.status = 'FILA'; c.pedidoEm = new Date().toISOString(); c.por = por; c.consultas = {}; delete c.atual; delete c.tentativasConsulta; delete c.consultaParadaEm; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Card na fila da CAIXA (${por}): a extensão vai consultar o nome de cada participante em Oportunidades de Negócios e gravar o resultado aqui.` } }).catch(() => {});
  logActivity({ accountId, userId, userName: por, action: 'lead_edited', leadId, leadName: l.name, summary: 'colocou o card na fila do cadastro da CAIXA' } as any);
  return null;
}

/** Próximo trabalho da extensão: o 1º participante ainda sem consulta do card mais antigo na fila. Marca como "em consulta" (10 min). */
export async function proximaConsulta(accountId: string): Promise<any | null> {
  // Consulta que já falhou ou foi largada vai pro fim da fila (Fabio 09/11: um card repetiu por horas e prendeu quem estava atrás); a que está em andamento fica na frente pra valer o "um por vez".
  const prazo = new Date(Date.now() - LEASE_MS).toISOString();
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaCadastro'->>'status' = 'FILA'
    ORDER BY CASE
        WHEN "customFields"->'_caixaCadastro'->'atual'->>'desde' >= ${prazo} THEN 0
        WHEN "customFields"->'_caixaCadastro'->'atual' IS NOT NULL THEN GREATEST(COALESCE(("customFields"->'_caixaCadastro'->>'tentativasConsulta')::int, 0), 1)
        ELSE COALESCE(("customFields"->'_caixaCadastro'->>'tentativasConsulta')::int, 0)
      END ASC, "customFields"->'_caixaCadastro'->>'pedidoEm' ASC LIMIT 10`;
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
        const ehFh = !/empr[eé]stimo com garantia/i.test(String(av.produto || ''));
        const pediu = async (rx: RegExp, palavra: string) => (await prisma.message.findMany({ where: { leadId: id, direction: 'INBOUND', deleted: false, content: { contains: palavra, mode: 'insensitive' } }, select: { content: true }, take: 20 })).some((m) => rx.test(m.content || ''));
        const pediuPrice = ehFh && (await pediu(/\bprice\b/i, 'price'));
        const pediuSac = !ehFh && (await pediu(/\bsac\b/i, 'sac'));
        // Compra e venda da proposta que o cliente mandou (a mais recente com essa linha).
        const prop = ehFh ? await prisma.message.findFirst({ where: { leadId: id, direction: 'INBOUND', deleted: false, content: { contains: 'compra e venda', mode: 'insensitive' } }, orderBy: { createdAt: 'desc' }, select: { content: true } }) : null;
        const compraVenda = valorDe(String(prop?.content || '').match(/valor de compra e venda:\s*([^\n]+)/i)?.[1]);
        const operacao = operacaoDaAvaliacao(cf, [quem.tomador, ...quem.incluir], valorDe((ajuste?.data as Cf | null)?.prazo), ehFh ? { pediuPrice, compraVenda } : null, ehFh ? null : { pediuSac });
        if (typeof operacao === 'string') {
          await salvar(id, (x) => { x.avaliacao = { ...x.avaliacao, status: `SEGURADO: ${operacao}`, fim: new Date().toISOString() }; });
          await prisma.note.create({ data: { leadId: id, type: 'COMMENT', content: `⏸️ Avaliação de Risco CAIXA não rodou: ${operacao}. Corrija e peça de novo (painel CAIXA da Análise de Crédito).` } }).catch(() => {});
          const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
          sendPushToAccount(accountId, { title: `⏸️ ${l!.name}: Avaliação CAIXA não rodou`, body: operacao.slice(0, 120), leadId: id }).catch(() => {});
          continue;
        }
        const p1 = quem.tomador;
        await salvar(id, (x) => { x.atual = { ordem: 1, desde: new Date().toISOString(), tipo: 'avaliar' }; x.avaliacao = { ...x.avaliacao, status: 'RODANDO', inicio: new Date().toISOString(), tentativas: (x.avaliacao?.tentativas || 0) + 1 }; });
        return { tipo: 'avaliar', leadId: id, leadName: l!.name, ordem: 1, nome: p1.nome, cpf: p1.cpf, produto: av.produto, participantes: ps.map(({ fontes, faltando, ...x }: any) => x), incluir: quem.incluir.map((x) => ({ ordem: x.ordem, nome: x.nome, cpf: x.cpf })), fora: quem.fora.map((x) => x.nome), operacao, enviar: av.enviar === true, denovo: av.denovo === true, refazer: av.refazer || null, ajuste: av.ajuste || null }; // denovo/refazer (Fabio 03/11): reabre a avaliação que deu erro e clica em Avançar lá
      }
      await salvar(id, (x) => { x.atual = { ordem: pc.ordem, desde: new Date().toISOString(), tipo: 'cadastrar' }; x.cadastros[pc.ordem] = { ...x.cadastros[pc.ordem], status: 'RODANDO', inicio: new Date().toISOString(), tentativas: (x.cadastros[pc.ordem]?.tentativas || 0) + 1 }; });
      const { fontes, faltando, ...participante } = pc;
      const p1 = ps.find((x) => x.ordem === 1);
      // avaliacaoFeita: a extensão não relança renda só pra acertar o mês de referência depois do crédito rodado (Fabio 01/11).
      return { tipo: 'cadastrar', leadId: id, leadName: l!.name, ordem: pc.ordem, nome: pc.nome, cpf: pc.cpf, participante: { ...participante, avaliacaoFeita: avaliacaoFeita(cf) }, primeiro: p1 ? { endereco: p1.endereco } : null };
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
  const c = await salvar(leadId, (x) => { x.consultas = { ...(x.consultas || {}), [ordem]: { at: new Date().toISOString(), texto: limpo } }; delete x.atual; delete x.tentativasConsulta; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 CAIXA — Oportunidades de Negócios (${ordem}º participante: ${p?.nome || '—'}), consultado pela extensão:\n\n${limpo}` } }).catch(() => {});
  const todos = participantesDa((l.customFields || {}) as Cf).every((x) => c.consultas?.[x.ordem]);
  if (!todos) return;
  await salvar(leadId, (x) => { x.status = 'CONSULTADO'; x.consultadoEm = new Date().toISOString(); });
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `🏦 ${l.name}: consulta da CAIXA pronta`, body: temFicha((l.customFields || {}) as Cf) ? 'Resultado nas anotações. Quem está com a ficha completa já vai pro cadastro (a extensão preenche e o CRM confere).' : 'Resultado nas anotações. O cadastro sai quando a documentação da CAIXA for conferida.', leadId }).catch(() => {});
  await cadastroAutomatico(accountId, leadId).catch((e) => console.error('[CAIXA] cadastro automático:', e?.message));
}

/** Estado civil informado pela equipe (Fabio 09/11): grava só esse campo do card, deixa anotado e passa a valer no lugar do da ficha (participantesDa). Erro em texto quando não dá. */
export async function informarEstadoCivil(accountId: string, leadId: string, ordem: number, estadoCivil: string, por: string): Promise<string | null> {
  if (!/^(solteir|casad|divorciad|separad|vi[uú]v)/i.test(estadoCivil)) return 'Estado civil inválido';
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const p = participantesDa((l.customFields || {}) as Cf).find((x) => x.ordem === ordem);
  if (!p) return 'Participante não encontrado';
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || ${JSON.stringify({ [`estado_civil_${ordem}`]: estadoCivil })}::jsonb WHERE id = ${leadId}`;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📋 Estado civil de ${p.nome || `${ordem}º participante`} informado por ${por}: ${estadoCivil}. Vale no cadastro da CAIXA no lugar do que a ficha trouxer.` } }).catch(() => {});
  return null;
}

/** CNPJ e/ou data de admissão do emprego de um participante, informados pela equipe (comRendaInformada); mês/ano do comprovante de residência
 *  (comComprovanteInformado); `limparCnpj` tira o CNPJ informado antes (Fabio 11/11: CNPJ só o que o cliente confirmar com a instituição, nunca de busca na internet). */
export async function informarDadosRenda(accountId: string, leadId: string, ordem: number, dados: { cnpj?: string; admissao?: string; comprovante?: string; limparCnpj?: boolean }, por: string): Promise<string | null> {
  const cnpj = String(dados.cnpj || '').replace(/\D/g, '');
  const admissao = String(dados.admissao || '').trim();
  const comprovante = String(dados.comprovante || '').trim();
  const limpar = dados.limparCnpj === true && !cnpj;
  if (!cnpj && !admissao && !comprovante && !limpar) return 'Informe o CNPJ, a data de admissão ou o mês do comprovante de residência';
  if (cnpj && !cnpjValido(cnpj)) return 'CNPJ inválido';
  if (comprovante) {
    const m = /^(\d{2})\/(\d{4})$/.exec(comprovante);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return 'Mês do comprovante no formato mm/aaaa';
    const hoje = new Date();
    if (Number(m[2]) * 12 + Number(m[1]) > hoje.getFullYear() * 12 + hoje.getMonth() + 1) return 'Mês do comprovante no futuro';
  }
  if (admissao) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(admissao);
    if (!m) return 'Data de admissão no formato dd/mm/aaaa';
    const d = new Date(`${m[3]}-${m[2]}-${m[1]}T12:00:00-03:00`);
    if (isNaN(d.getTime()) || d.getUTCDate() !== Number(m[1]) || d.getTime() > Date.now()) return 'Data de admissão inválida ou no futuro';
  }
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const p = participantesDa((l.customFields || {}) as Cf).find((x) => x.ordem === ordem);
  if (!p) return 'Participante não encontrado';
  const patch = { ...(cnpj ? { [`cnpj_renda_${ordem}`]: cnpj } : {}), ...(limpar ? { [`cnpj_renda_${ordem}`]: null } : {}), ...(admissao ? { [`admissao_renda_${ordem}`]: admissao } : {}), ...(comprovante ? { [`comprovante_residencia_${ordem}`]: comprovante } : {}) };
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb WHERE id = ${leadId}`;
  const fonte = p.trabalho?.empregador ? ` (${p.trabalho.empregador})` : '';
  const itens = [cnpj && `CNPJ ${cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')}`, limpar && 'CNPJ retirado (espera o que o cliente confirmar)', admissao && `admissão ${admissao}`, comprovante && `comprovante de residência ${comprovante}`].filter(Boolean);
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `📋 Dados de ${p.nome || `${ordem}º participante`}${fonte} informados por ${por}: ${itens.join(', ')}. Vale no cadastro da CAIXA no lugar do que a ficha trouxer.` } }).catch(() => {});
  // Só com a CAIXA já pedida (consulta feita/na fila): o cadastro que esperava esse dado sai sozinho; o que parou volta pra fila.
  if ((l.customFields as Cf | null)?._caixaCadastro) {
    await reenfileirarCadastrosPendentes(leadId, 'dado da renda informado pela equipe').catch(() => {});
    await cadastroAutomatico(accountId, leadId).catch(() => {});
  }
  return null;
}

/** A CAIXA respondeu a consulta sem "Situação CPF": a extensão manda o que apareceu na tela (Fabio 09/11). Na 1ª vez o card vai pro fim da fila; na 2ª sai dela, com nota e
 *  push, e aparece em "Cadastro não saiu sozinho" no painel CAIXA, de onde o "Fazer cadastro" o põe na fila de novo. */
export async function consultaSemResultado(accountId: string, leadId: string, ordem: number, texto: string): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return;
  const p = participantesDa((l.customFields || {}) as Cf).find((x) => x.ordem === Number(ordem));
  const tela = String(texto || '').replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, '[CPF]').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1500);
  console.log('[CAIXA ext] consulta sem resultado:', l.name, '·', tela.slice(0, 500).replace(/\s+/g, ' '));
  const c = await salvar(leadId, (x) => {
    x.tentativasConsulta = (x.tentativasConsulta || 0) + 1;
    delete x.atual;
    if (x.tentativasConsulta >= CONSULTA_MAX_TENTATIVAS) { x.status = CONSULTA_PARADA; x.consultaParadaEm = new Date().toISOString(); }
  });
  if (c.status !== CONSULTA_PARADA) return;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ CAIXA: a consulta de ${p?.nome || `${ordem}º participante`} em Oportunidades de Negócios não trouxe resultado em ${c.tentativasConsulta} tentativas, e o card saiu da fila pra não segurar os outros. Veja no Caixa Aqui e use "Fazer cadastro" no painel CAIXA pra tentar de novo.\n\nO que apareceu na tela:\n${tela || '(tela sem texto)'}` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `⚠️ ${l.name}: consulta da CAIXA não saiu`, body: 'O card saiu da fila. O que apareceu na tela está nas anotações.', leadId }).catch(() => {});
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

/** Entra sozinho na fila: ficha pronta + o cliente PEDIU a CAIXA (`_caixaRota`: já aprovado em algum banco, nome limpo e Habite-se; card na Pré-Análise — Fabio 01/11,
 *  HE e FH). Saíram as entradas antigas: todo FH com ficha (31/10), toda ficha do HE (31/10), "quer CAIXA/BRB também?" do FH, CAIXA combinada antes da proposta,
 *  reprovado que volta e o "optou pela CAIXA" sem as regras. Roda no poller. Depois da consulta, o cadastro sai sozinho (cadastroAutomatico). */
export async function processFilaCaixa(accountId: string): Promise<void> {
  // Card na etapa "Análise CAIXA" vale como rota da CAIXA (Fabio 11/11: "rodar o cadastro sozinho sempre que tiver todos os documentos ou todas as informações" —
  // card que a equipe põe na etapa não tem `_caixaRota` e ficava esperando o clique no "Cadastro CAIXA"). A análise de crédito continua só com o clique.
  const ids = await prisma.$queryRaw<{ id: string; rota: boolean }[]>`
    SELECT l.id, (l."customFields"->'_caixaRota' IS NOT NULL) AS rota FROM "Lead" l LEFT JOIN "Stage" s ON s.id = l."stageId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND l."customFields"->'_fichaCadastral' IS NOT NULL AND l."customFields"->'_caixaCadastro' IS NULL
      AND (l."customFields"->'_caixaRota' IS NOT NULL OR s.name ILIKE 'An_lise CAIXA%')
    LIMIT 5`;
  for (const { id, rota } of ids) await pedirCadastroCaixa(accountId, id, rota ? 'automático (cliente vai pela CAIXA)' : 'automático (card na etapa Análise CAIXA)').catch((e) => console.error('[CAIXA] fila:', e?.message));
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
  // 1º proponente = quem tem a MAIOR renda (Fabio 02/11: "o primeiro proponente sempre será o que tem a maior renda"); empate ou sem renda lida → o 1º da ficha.
  const renda = (p: any) => valorDe(p?.rendaBrutaMensal) || valorDe(p?.contracheques?.[0]?.bruto) || 0;
  const comRenda = ps.filter(tem);
  const maior = comRenda.reduce((m: any, p: any) => (!m || renda(p) > renda(m) ? p : m), null);
  const primeiro = ps.find((x) => x.ordem === 1) || null;
  const tomador = maior && primeiro && renda(maior) > renda(primeiro) ? maior : primeiro;
  const outros = ps.filter((x) => x !== tomador);
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
    if (/avalia[cç][aã]o (de risco )?em andamento/i.test(t) && !/n[aã]o possui avalia[cç][aã]o (de risco )?em andamento/i.test(t)) return 'avaliação de risco em andamento';
    if (/possui proposta solicitada/i.test(t) && !/n[aã]o possui proposta solicitada/i.test(t)) return 'proposta solicitada';
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
 *  chega documento novo e o cadastro sai na rodada seguinte. Consulta com proposta/avaliação em andamento só vira anotação: o cadastro segue (Fabio 06/11). */
export async function cadastroAutomatico(accountId: string, leadId: string): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return;
  const cf = (l.customFields || {}) as Cf;
  const c = (cf._caixaCadastro || {}) as Cf;
  if (!temFicha(cf)) return; // consultado antes dos documentos (Fabio 01/11): o cadastro espera a ficha
  // A ficha trouxe participante que a consulta (feita com a proposta) não pegou: consulta ele antes de cadastrar.
  if (participantesDa(cf).some((p) => !c.consultas?.[p.ordem])) { if (c.status !== 'FILA') await salvar(leadId, (x) => { x.status = 'FILA'; }); return; }
  const cads = (c.cadastros || {}) as Record<string, any>;
  const pendentes = participantesDa(cf).filter((p) => !cads[p.ordem]);
  if (!pendentes.length) return;
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  // Avaliação/proposta em andamento na consulta NÃO segura mais o cadastro (Fabio 06/11, Windson: "sempre que aparecer isso, e a extensão clicar em cadastrar
  // o cliente e não aparecer nenhum empecilho, ela pode seguir com o cadastro"): só anota uma vez; impedimento de verdade o portal mostra e a extensão para.
  const motivo = consultaSegura(Object.values(c.consultas || {}).map((x: any) => String(x?.texto || '')));
  if (motivo && !c.consultaAvisadaAt) {
    await salvar(leadId, (x) => { x.consultaAvisadaAt = new Date().toISOString(); });
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 A consulta da CAIXA mostra ${motivo}. Seguindo com o cadastro mesmo assim (regra do Fabio 06/11): se o portal mostrar algum impedimento ao cadastrar, a extensão para e avisa.` } }).catch(() => {});
  }
  const prontos = pendentes.filter((p) => !faltaParaCadastro(p).length).map((p) => p.ordem);
  if (prontos.length && avaliacaoFeita(cf)) { await segurarPosAvaliacao(leadId, `a ficha tem ${prontos.map((o) => participantesDa(cf).find((p) => p.ordem === o)?.nome || `${o}º`).join(', ')} pronto(s) pro cadastro`); return; }
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
Regras da A&F (Fabio 29/10 — NÃO são divergência): a identidade é a do documento apresentado (com CNH, vale o número de registro, órgão "ÓRGÃO DE TRÂNSITO" e UF/emissão da CNH; com RG — inclusive a identidade nova, CIN, cujo número é o próprio CPF —, subtipo CARTEIRA DE IDENTIDADE e o órgão emissor pela lista da CAIXA, que só tem SSP, Polícia Civil, Defesa Social, Casa Civil e Outro: Instituto de Identificação/Polícia Civil da UF (ex.: "INSTITUTO DE IDENTIFICAÇÃO PCDF", "PC/GO") e SSP/SESP = SECRETARIA DE SEGURANÇA PÚBLICA (Fabio 01/11 — nunca POLÍCIA CIVIL: RG na tela com POLÍCIA CIVIL É DIVERGÊNCIA, mesmo com a ficha dizendo Instituto de Identificação/PC), órgão fora da lista = OUTRO TIPO DE ÓRGÃO EMISSOR); CNH vencida não é problema; participante SEM RENDA vai com Tipo de Ocupação FORMAL e Ocupação ADMINISTRADOR; bairro vale o do comprovante de residência (a consulta do CEP pode trazer outro nome — não é divergência se a tela tem o do comprovante); tipo de imóvel CASA e ocupação do imóvel PRÓPRIA QUITADA são padrão da A&F; a lista de ocupações da CAIXA não tem todos os cargos — a opção MAIS PARECIDA com o cargo da ficha vale (ex.: "Analista PCPM Sr" → ANALISTA DE SISTEMAS); SERVIDOR PÚBLICO (vínculo servidor/órgão público — Fabio 31/10, Fernanda) vai como SERVIDOR PÚBLICO ESTADUAL/FEDERAL/MUNICIPAL pela esfera do órgão, mesmo com cargo específico (assessor de juiz no TJ do Estado = SERVIDOR PÚBLICO ESTADUAL — nunca a ocupação de juiz/desembargador pra quem é assessor); RENDA LANÇADA (Fabio 31/10): de cada fonte vale o contracheque VÁLIDO (competência dos 2 últimos meses — a CAIXA recusa mais antigo) MAIS RECENTE; um mais antigo só vale se a renda bruta dele passa a do mais recente em MAIS DE R$ 1.000 (bruta igual ou parecida com líquido diferente = o mais recente); o IMPOSTO DE RENDA RETIDO NA FONTE do contracheque (irRetido) TEM que estar no campo de IR retido — vazio/0,00 com desconto de IR no contracheque = "faltando"; aposentadoria vai com comprovante EXTRATO DE BENEFÍCIO PREVIDENCIÁRIO; SÓCIO (Fabio 31/10 — a CAIXA não aceita pró-labore nem DECORE): renda = distribuição de lucros do imposto de renda ÷ 12, comprovante DECLARAÇÃO DE IMPOSTO DE RENDA, ocupação PROPRIETÁRIO DE ESTABELECIMENTO COMERCIAL ou DIRETOR DE EMPRESAS (as duas valem), referência = o MÊS ATUAL do cadastro (Fabio 01/11: "sempre que informar um IR como renda, a referência deve ser a do mês atual"; não é "contracheque vencido"), admissão = entrada na sociedade/abertura da empresa, sem IR retido; PRÓ-LABORE DO SÓCIO (Fabio 05/11): o rendimento tributável recebido da PRÓPRIA empresa no imposto de renda ÷ 12 é OUTRA renda, SEPARADA da de lucros (mesma empresa/CNPJ e mesmo comprovante DECLARAÇÃO DE IMPOSTO DE RENDA, referência = mês atual), com ocupação ADMINISTRADOR e o IR retido do ano ÷ 12 (quando o campo de IR retido vier marcado BLOQUEADO PELA CAIXA, ele fica 0,00 e NÃO é divergência nem "faltando") — duas rendas da mesma empresa (lucros + pró-labore) NÃO é duplicidade; QUALQUER campo marcado [BLOQUEADO PELA CAIXA] não é divergência nem "faltando"; MAIS DE UMA RENDA: a profissão/ocupação da 1ª tela é a da MAIOR renda, igual à ocupação lançada na renda dela, e cada renda leva a ocupação DELA; renda de aposentadoria (fundo de previdência/seguridade, INSS, "outrasRendas" aposentadoria) = APOSENTADO (EXCETO FUNCIONÁRIO PÚBLICO), sem a data de admissão do outro emprego — não é divergência ocupação APOSENTADO com o cargo de outro emprego na ficha; grau de instrução é sempre SUPERIOR COMPLETO; o nome reduzido abrevia os nomes do meio e nunca o último sobrenome; NOME DA MÃE/DO PAI (Fabio 12/11 — o RG escaneado de lado foi lido "Rosa Belen" e a CAIXA tinha o certo, "Rosa Belem"): nome da mãe ou do pai na tela com 1 ou 2 LETRAS de diferença do da ficha é o MESMO nome — NÃO é divergência nem "faltando" (a extensão mantém o que a CAIXA já tinha; diferença de uma letra costuma ser letra trocada na leitura do documento); só é divergência quando é OUTRO nome; estado civil e regime vêm juntos ("CASADO (A) COM COMUNHÃO PARCIAL DE BENS"); comunhão UNIVERSAL de bens é a COMUNHÃO TOTAL DE BENS da lista da CAIXA (mesmo regime); Declaração de Propósitos = Movimentação de Conta, Empréstimos/Financiamentos com Financiamento Habitacional SIM, Investimentos, Cartão de Crédito e Seguro/Previdência/Capitalização/Consórcios marcados, só Operações Internacionais/Câmbio desmarcado (Fabio 02/11); formato diferente (maiúsculas, acento, pontuação, máscara de CPF/CEP/data) NÃO é divergência; campo que EXISTE na tela e ficou vazio, mas a ficha tem = "faltando"; endereço dividido pela tela da CAIXA (Fabio 10/11, Deborah): o tipo (RUA, QUADRA, SETOR) vem à parte, a rua fica no logradouro e o que a ficha traz depois da vírgula — lote, apartamento, bloco, condomínio — pode estar no número ou no complemento, abreviado (R = RUA, LT = LOTE), sem hífen/acento e cortado no tamanho do campo da CAIXA (o complemento tem 15 letras); a parte que está em um desses campos, mesmo cortada, NÃO é divergência; LOGRADOURO PELO CEP E COMPLEMENTO APERTADO (Fabio 12/11): a consulta do CEP da CAIXA costuma preencher o logradouro só com o começo (ex.: "QUADRA 202") e o que a ficha traz a mais (ex.: "LOTES 7 9") vai pro complemento, antes do bloco/apartamento; pra caber nas 15 letras o complemento vem abreviado, com a sigla do bloco/apartamento colada e o apartamento do fim às vezes só com o número (ex.: "LT 7 9 BLC 1603" = lotes 7 e 9, bloco C, apartamento 1603) — NÃO é divergência; só é divergência quando o bloco ou o número do apartamento/casa da ficha NÃO aparece em nenhum campo da tela; campo que NÃO aparece nesta tela = ignore (o cadastro da CAIXA tem várias páginas: dados pessoais na 1ª, endereço/telefone/e-mail na 2ª — nunca cobre o que é de outra página); campo que a ficha não tem = ignore.
Responda SOMENTE com JSON: {"ok": true|false, "divergencias": ["<campo: na tela X, na ficha Y>"], "faltando": ["<campo que a ficha tem e a tela deixou vazio>"], "resumo": "<1 frase>"}`;

export async function conferirCadastro(accountId: string, leadId: string, ordem: number, campos: { rotulo: string; valor: string }[]): Promise<{ ok: boolean; divergencias: string[]; faltando: string[]; resumo: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return null;
  const p = participantesDa((l.customFields || {}) as Cf).find((x) => x.ordem === Number(ordem));
  if (!p) return null;
  const { fontes, faltando, ...fichaLida } = p;
  // Órgão do RG já no nome da lista da CAIXA (Fabio 01/11, Fernanda): a ficha antiga diz "INSTITUTO DE IDENTIFICAÇÃO PCDF" e a conferência pedia "Outro" — vai como SSP.
  const ficha = { ...fichaLida, identidade: fichaLida.identidade && { ...fichaLida.identidade, orgao: orgaoCaixa(fichaLida.identidade) } };
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
  if (!temFicha((l.customFields || {}) as Cf)) return 'O card ainda não tem a ficha de cadastro: o cadastro sai quando a documentação da CAIXA for conferida (a consulta já pode ter sido feita com a proposta)';
  const ps = participantesDa((l.customFields || {}) as Cf);
  const validos = ordens.filter((o) => ps.some((p) => p.ordem === o));
  if (!validos.length) return 'Participante não está na ficha';
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}) }; for (const o of validos) x.cadastros[o] = { status: 'FILA', pedidoEm: new Date().toISOString(), por, ...jaFeito(x.cadastros[o]) }; });
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
  if (avaliacaoFeita(cf)) { await segurarPosAvaliacao(leadId, `chegou o documento de identidade de ${voltar.map((o) => ps.find((p) => p.ordem === o)?.nome || `${o}º`).join(', ')}`); return; }
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}) }; for (const o of voltar) x.cadastros[o] = { status: 'FILA', pedidoEm: new Date().toISOString(), por: 'CRM (documento novo)', ...jaFeito(x.cadastros[o]) }; });
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Chegou o documento de identidade de ${voltar.map((o) => ps.find((p) => p.ordem === o)?.nome || `${o}º`).join(', ')} — a ficha foi refeita e o cadastro na CAIXA voltou pra fila da extensão.` } }).catch(() => {});
}

/** Dado novo na ficha (resposta do cliente com CNPJ/admissão — Fabio 30/10): cadastro da CAIXA que não saiu (nem gravado, nem na fila/rodando) volta pra fila. */
export async function reenfileirarCadastrosPendentes(leadId: string, motivo: string): Promise<void> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const cads = (((l?.customFields || {}) as Cf)._caixaCadastro?.cadastros || {}) as Record<string, any>;
  // Só quem não tem mais nada faltando (Fabio 11/11, Deborah: sem o CNPJ o cadastro iria à CAIXA e pararia na renda); o resto espera o próximo dado.
  const ps = participantesDa((l?.customFields || {}) as Cf);
  const voltar = Object.entries(cads).filter(([o, v]) => v && !['GRAVADO', 'FILA', 'RODANDO'].includes(String(v.status)) && !faltaParaCadastro(ps.find((p) => p.ordem === Number(o)) || {}).length).map(([o]) => Number(o));
  if (!voltar.length) return;
  if (avaliacaoFeita((l?.customFields || {}) as Cf)) { await segurarPosAvaliacao(leadId, motivo); return; }
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}) }; for (const o of voltar) x.cadastros[o] = { status: 'FILA', pedidoEm: new Date().toISOString(), por: `CRM (${motivo})`, ...jaFeito(x.cadastros[o]) }; });
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

/** Avaliação de Risco que já terminou (enviada, com resultado, parada, segurada ou recusada pelo portal) — pode rodar de novo. Na fila ou rodando (a extensão com ela
 *  na mão, até 3 tentativas) → null: nunca reenfileira por cima. Pura. */
export function avaliacaoTerminada(cf: Cf): Cf | null {
  const av = cf._caixaCadastro?.avaliacao as Cf | undefined;
  if (!av?.status || av.status === 'FILA') return null;
  if (av.status === 'RODANDO' && !(av.inicio && Date.now() - Date.parse(av.inicio) > LEASE_MS && (av.tentativas || 0) >= 3)) return null;
  return av;
}

/** O que fica no histórico (`avaliacao.anteriores`) quando a Avaliação de Risco roda de novo: status, datas, quem autorizou e o resultado da consulta (com o nº da
 *  proposta e a data de Formulários Enviados — é por eles que a extensão reabre a avaliação que deu erro). Pura. */
export function resumoAvaliacaoAnterior(av: Cf, resultado: Cf | null | undefined): Cf {
  const st = String(av?.status || '');
  const res = resultado?.status && resultado.status !== 'AGUARDANDO_NOVA_AVALIACAO' ? resultado : null;
  const tela = String(res?.ultimaTela || '');
  // "Proposta 118223323 (enviada 02/11/2026) — …" (resumo da consulta) ou "Código Proposta 118223323" (detalhe).
  const linha = /Proposta\s+(\d{5,})\s*\(enviada\s+(\d{2}\/\d{2}\/\d{4})/i.exec(tela);
  const proposta = linha?.[1] || (/C[oó]digo Proposta\s*\t?\s*(\d{5,})/i.exec(tela) || [])[1] || res?.pvAviso?.proposta || resultado?.pvAviso?.proposta || null;
  return {
    status: st.slice(0, 300), pedidoEm: av?.pedidoEm || null, por: av?.por || null, inicio: av?.inicio || null, fim: av?.fim || null, produto: av?.produto || null,
    enviar: av?.enviar === true, tentativas: av?.tentativas || 0, autorizacao: av?.autorizacao || null, refazer: av?.refazer || null,
    resultado: res ? { status: String(res.status).slice(0, 300), fim: res.fim || null, proposta: proposta && proposta !== '?' ? proposta : null, data: linha?.[2] || null } : null,
    chegouNaCaixa: /^ENVIAD|RODANDO/i.test(st) || !!res, arquivadaEm: new Date().toISOString(),
  };
}

/** Avaliação que deu erro e vai ser refeita (Fabio 03/11: "O RODAR DE NOVO NÃO É IGUAL A ANTES, PRECISA USAR A APROVAÇÃO/AVALIAÇÃO QUE DEU ERRO" + "E CLICAR EM
 *  AVANÇAR POR LÁ"): a última do histórico que chegou à CAIXA, com a proposta/data lidas em Formulários Enviados (a mais recente que tem proposta). Uma rodada de novo
 *  que parou herda o alvo da anterior. null = nenhuma chegou à CAIXA (aí roda do começo, como a 1ª). Pura. */
export function avaliacaoParaRefazer(historico: Cf[], produto: string): Cf | null {
  const foram = (historico || []).filter((a) => a?.chegouNaCaixa || a?.refazer);
  if (!foram.length) return null;
  const comProposta = [...foram].reverse().find((a) => a?.resultado?.proposta || a?.refazer?.proposta);
  const base = comProposta || foram[foram.length - 1];
  if (base?.resultado?.proposta) return { proposta: base.resultado.proposta, data: base.resultado.data || null, produto: base.produto || produto, resultado: base.resultado.status || null };
  if (base?.refazer) return { ...base.refazer };
  return { proposta: null, data: null, produto: base?.produto || produto, resultado: base?.resultado?.status || null };
}

/** Avaliação de Risco da CAIXA (passo 2, Fabio 30/10: "vamos rodar a análise de crédito do Jézer"). Produto pelo setor: Home Equity → "11 - Empréstimo com
 *  Garantia de Imóvel (EGI)"; Financiamento → "1 - Crédito Imobiliário". A extensão abre, consulta o CPF, marca o produto, preenche a operação e PARA antes da
 *  seta (Avançar) da tela 3. `enviar` (Fabio 01/11, Jézer: "PODE REFAZER") = a extensão clica na seta e grava a tela seguinte — a CAIXA não dá o resultado
 *  nessa hora ("O RESULTADO NÃO SAI NESSA TELA, PRECISA CONSULTAR DEPOIS"). Só com o pedido explícito do Fabio; avaliação já ENVIADA não é pedida de novo —
 *  salvo `denovo` (Fabio 03/11, Jézer/Fernanda: "JÁ FORAM AUTORIZADAS PELO PV … RODE A AVALIAÇÃO NOVAMENTE"): a anterior vai pro histórico (`avaliacao.anteriores`),
 *  o resultado dela sai de `_caixaResultado` (a consulta de Formulários Enviados roda de novo depois do novo envio) e a extensão refaz o mesmo roteiro. */
export async function pedirAvaliacao(accountId: string, leadId: string, por: string, opts: { enviar?: boolean; autorizacao?: Record<string, unknown>; denovo?: boolean; ajuste?: Record<string, unknown> } = {}): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const ps = participantesDa(cf);
  if (!ps.length) return 'O card ainda não tem a ficha de cadastro';
  const anterior = cf._caixaCadastro?.avaliacao;
  const denovo = opts.denovo === true;
  if (!denovo && /^ENVIADA/i.test(String(anterior?.status || ''))) return `A Avaliação de Risco já foi ENVIADA à CAIXA (${String(anterior.fim || '').slice(0, 10)}) — o resultado sai na consulta`;
  if (denovo && !avaliacaoTerminada(cf)) return 'A Avaliação de Risco deste card está na fila/rodando agora — espere terminar pra rodar de novo';
  const produto = /home|garantia/i.test(l.pipeline?.department?.name || '') ? '11 - empréstimo com garantia de imóvel' : '1 - crédito imobiliário';
  const quem = participantesDaAvaliacao(ps);
  const enviar = opts.enviar === true;
  // autorizacao = quem deu o OK pra este cliente e quando (botão "Análise CAIXA" do card, Fabio 03/11). A avaliação anterior (com o resultado dela) vai pro histórico.
  const anteriores = [...(Array.isArray(anterior?.anteriores) ? anterior.anteriores : []), ...(anterior?.status ? [resumoAvaliacaoAnterior(anterior, cf._caixaResultado)] : [])].slice(-10);
  // Rodar de novo (Fabio 03/11): a extensão REABRE a avaliação que deu erro (Formulários Enviados → proposta) e clica em Avançar lá — não preenche avaliação nova.
  // Nenhuma chegou à CAIXA (a anterior parou antes de enviar) → roda do começo, como a 1ª.
  const refazer = denovo ? avaliacaoParaRefazer(anteriores, produto) : null;
  await salvar(leadId, (x) => {
    x.avaliacao = { status: 'FILA', pedidoEm: new Date().toISOString(), por, produto, ...(enviar ? { enviar: true } : {}), ...(opts.autorizacao ? { autorizacao: opts.autorizacao } : {}), ...(refazer ? { denovo: true, refazer } : {}), ...(refazer && anterior?.enquadramento ? { enquadramento: anterior.enquadramento } : {}), ...(refazer && opts.ajuste ? { ajuste: opts.ajuste } : {}), ...(anteriores.length ? { anteriores } : {}) };
    if (x.atual?.tipo === 'avaliar') delete x.atual;
  });
  if (refazer && cf._caixaResultado) await (require('./caixa-resultado.service') as typeof import('./caixa-resultado.service')).reiniciarResultado(leadId);
  const lista = [quem.tomador && `${quem.tomador.nome} (tomador)`, ...quem.incluir.map((x) => x.nome)].filter(Boolean).join(', ');
  const comoRefaz = refazer && opts.ajuste
    ? ` CONDICIONADA (Fabio 03/11): a extensão reabre a proposta ${refazer.proposta || '(a mais recente)'} em Formulários Enviados, troca só a prestação pela possível (R$ ${Number(opts.ajuste.prestacao).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}) e a amortização pra PRICE, e envia de novo. O resultado sai na consulta.`
    : refazer
    ? ` A extensão REABRE em Formulários Enviados a avaliação que deu erro (${refazer.proposta ? `proposta ${refazer.proposta}${refazer.data ? ` de ${refazer.data}` : ''}` : 'a mais recente do produto — o nº da proposta não estava no card'}), clica em Avançar e segue com os dados que já estão nela (não preenche avaliação nova). Tela que ela não conhece ou botão que não achar: para sem clicar e anota aqui o que viu. A anterior foi pro histórico; o resultado é consultado de novo depois do envio.`
    : denovo ? ' A anterior parou antes de chegar à CAIXA — roda do começo, como a 1ª.' : '';
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Avaliação de Risco na CAIXA pedida${denovo ? ' DE NOVO' : ''} (${por}) — produto "${produto.toUpperCase()}".${comoRefaz} Participantes: ${lista || '—'}${quem.fora.length ? `; fora por não ter renda: ${quem.fora.map((x) => x.nome).join(', ')} (o cadastro na CAIXA fica como está)` : ''}. ${enviar ? 'A extensão preenche a operação, confere os valores e ENVIA (seta da tela 3); o resultado sai depois, na consulta da CAIXA.' : 'A extensão consulta o CPF, marca o produto e mostra a tela antes de enviar.'}` } }).catch(() => {});
  return null;
}
export async function gravarAvaliacao(accountId: string, leadId: string, r: { status: string; texto: string }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!l) return;
  const enquadramento = enquadramentoDaOperacao(r.texto); // SBPE/MCMV da tela da operação (Fabio 11/11) — as telas seguintes não trazem, fica o que já foi lido
  await salvar(leadId, (x) => {
    x.avaliacao = { ...(x.avaliacao || {}), status: r.status, fim: new Date().toISOString(), ...(enquadramento ? { enquadramento } : {}) };
    // Condicionada → PRICE: a extensão só marca "condicionada na PRICE" quando trocou mesmo a prestação e a amortização na tela (o status final sobrescreve).
    if (x.avaliacao.ajuste && /condicionada na PRICE/i.test(r.status)) x.avaliacao.ajuste = { ...x.avaliacao.ajuste, aplicado: true };
    delete x.atual;
  });
  // PORTAL_BLOQUEOU (rodada de novo, Fabio 03/11): a CAIXA não deixou refazer — o texto da tela vai na anotação pra equipe ver com a agência (PV).
  const barrou = /^PORTAL_BLOQUEOU/i.test(r.status);
  const roteiro = /^AGUARDANDO_ROTEIRO/i.test(r.status); // rodar de novo: tela/botão que a extensão não conhece — parou sem clicar
  const cab = barrou ? '⛔ Avaliação de Risco CAIXA (rodar de novo) — o portal da CAIXA não deixou: ' : roteiro ? '🧭 Avaliação de Risco CAIXA (rodar de novo) — a extensão parou SEM CLICAR: ' : '🏦 Avaliação de Risco CAIXA: ';
  const pe = barrou ? '\nNada foi enviado de novo. Confira no Caixa Aqui / com a agência (PV) e, liberado, clique em "Rodar análise CAIXA de novo" no card.'
    : roteiro ? '\nNada foi enviado. Diga qual botão/caminho usar nessa tela (o roteiro da extensão é ajustado) ou faça à mão no Caixa Aqui.' : '';
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `${cab}${r.status}${pe}\n\n${String(r.texto || '').slice(0, 3500)}` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `${barrou ? '⛔' : roteiro ? '🧭' : '🏦'} ${l.name}: Avaliação de Risco CAIXA${barrou ? ' barrada no portal' : roteiro ? ' parou (tela nova)' : ''}`, body: r.status.slice(0, 120), leadId }).catch(() => {});
}

/** Resultado do cadastro vindo da extensão (preenchido + conferência; salvo ou parado antes de salvar). */
/** Recolocar na fila não apaga que a A&F JÁ mexeu nesse cadastro (Tarcisio 05/11: refeito pra corrigir a renda e veio o aviso de "cadastro de menos de 6 meses" — era o nosso). */
const jaFeito = (c: any) => (c?.fim || c?.jaFeito ? { jaFeito: c.jaFeito || c.fim } : {});
const MESES_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
/** Cadastro antigo da CAIXA feito há menos de 6 meses (Fabio 05/11: "consegue verificar isso através do comprovante de residência e ref. renda"): a data mais
 *  recente entre o mês/ano do comprovante de residência e as referências das rendas da lista. Devolve o texto do aviso, ou null. */
export function cadastroAntigoRecente(d: { residenciaMes?: string; residenciaAno?: string; renda?: string } | null | undefined, hoje = new Date()): string | null {
  if (!d) return null;
  const datas: { mm: number; aaaa: number; de: string }[] = [];
  const mesTxt = String(d.residenciaMes || '').trim();
  const mm = Number(mesTxt.replace(/\D/g, '')) || MESES_PT.findIndex((m) => mesTxt.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().startsWith(m)) + 1;
  const aaaa = Number(String(d.residenciaAno || '').replace(/\D/g, ''));
  if (mm >= 1 && mm <= 12 && aaaa > 2000) datas.push({ mm, aaaa, de: 'comprovante de residência' });
  // Referência da renda: MM/AAAA solto (a admissão dd/mm/aaaa não conta)
  for (const m of String(d.renda || '').matchAll(/(?<![\d/])(0[1-9]|1[0-2])\/(20\d{2})(?![\d/])/g)) datas.push({ mm: Number(m[1]), aaaa: Number(m[2]), de: 'referência da renda' });
  if (!datas.length) return null;
  const meses = (x: { mm: number; aaaa: number }) => (hoje.getFullYear() - x.aaaa) * 12 + (hoje.getMonth() + 1 - x.mm);
  const recentes = datas.filter((x) => meses(x) >= 0 && meses(x) < 6);
  if (!recentes.length) return null;
  return recentes.map((x) => `${x.de} ${String(x.mm).padStart(2, '0')}/${x.aaaa}`).filter((v, i, a) => a.indexOf(v) === i).join('; ');
}

export async function gravarCadastro(accountId: string, leadId: string, ordem: number, r: { status: string; texto: string; antigo?: string; antigoDatas?: { residenciaMes?: string; residenciaAno?: string; renda?: string } | null }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return;
  const p = participantesDa((l.customFields || {}) as Cf).find((x) => x.ordem === Number(ordem));
  // Cadastro antigo recente (< 6 meses) = provavelmente outro correspondente rodou há pouco → push + anotação. Não vale quando o cadastro anterior foi a própria A&F.
  const ant = ((l.customFields || {}) as Cf)._caixaCadastro?.cadastros?.[ordem];
  const nossoAntes = !!(ant?.fim || ant?.jaFeito);
  const recente = !nossoAntes ? cadastroAntigoRecente(r.antigoDatas) : null;
  if (recente) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ ${p?.nome || `${ordem}º participante`} já tinha cadastro na CAIXA feito há MENOS DE 6 MESES (${recente}). Pode ter rodado crédito com outro correspondente há pouco — confira antes de seguir.` } }).catch(() => {});
    const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
    sendPushToAccount(accountId, { title: `⚠️ ${l.name}: cadastro recente na CAIXA`, body: `${p?.nome || `${ordem}º participante`} tem cadastro na CAIXA de menos de 6 meses (${recente}). Pode ter passado por outro correspondente.`, leadId }).catch(() => {});
  }
  await salvar(leadId, (x) => { x.cadastros = { ...(x.cadastros || {}), [ordem]: { ...(x.cadastros?.[ordem] || {}), status: r.status, fim: new Date().toISOString() } }; delete x.atual; });
  // Cadastro que o cliente JÁ tinha na CAIXA, inteiro, como estava antes de a A&F mexer (Fabio 05/11: "sempre que o cliente tiver cadastro antigo, os dados desse
  // cadastro antigo precisam ficar gravados nas anotações do card") — anotação própria, antes da do resultado.
  if (r.antigo && r.antigo.trim()) await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🗂️ Cadastro ANTIGO na CAIXA — ${ordem}º participante (${p?.nome || '—'}), como estava antes de a A&F mexer:\n\n${r.antigo.slice(0, 12000)}` } }).catch(() => {});
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🏦 Cadastro na CAIXA — ${ordem}º participante (${p?.nome || '—'}): ${r.status}\n\n${String(r.texto || '').slice(0, 3500)}` } }).catch(() => {});
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  sendPushToAccount(accountId, { title: `🏦 ${l.name}: cadastro CAIXA (${p?.nome || `${ordem}º`})`, body: r.status, leadId }).catch(() => {});
  if (/^GRAVADO/i.test(r.status)) {
    const seguiu = await seguirAnalisePendente(accountId, leadId).catch((e) => { console.error('[CAIXA] análise depois do cadastro:', e?.message); return false; });
    if (!seguiu) await pedirConferencia(accountId, leadId).catch((e) => console.error('[CAIXA] conferência:', e?.message));
  }
}

/* ── Análise logo depois do cadastro (Fabio 11/11, Tarcisio: "isso daqui tem que ser automático" + "na verdade quando for cadastrar o cliente ele faz essa
 * consulta"). O clique da equipe é o OK daquele cliente (regra de 31/10: a Avaliação de Risco só roda com o OK de alguém): "Cadastro CAIXA" com "rodar a análise em
 * seguida" marcado, ou "Análise CAIXA" com o cadastro ainda não gravado. Fica em _caixaAnalisePendente (fora de _caixaCadastro — a fila regrava aquela chave) e,
 * quando o cadastro de quem entra na avaliação grava, a análise vai pra fila sozinha. A conferência manual do cadastro fica dispensada nessa sequência. */
type AnalisePendente = { por: string; userId: string | null; em: string; enviar: boolean; via: string };
async function gravarAnalisePendente(leadId: string, p: AnalisePendente | null): Promise<void> {
  if (p) await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaAnalisePendente}', ${JSON.stringify(p)}::jsonb, true) WHERE id = ${leadId}`;
  else await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = COALESCE("customFields", '{}'::jsonb) - '_caixaAnalisePendente' WHERE id = ${leadId}`;
}
/** true = havia análise pendente (seguiu ou ainda espera alguém gravar) — a conferência manual não é pedida. */
async function seguirAnalisePendente(accountId: string, leadId: string): Promise<boolean> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, userId: true, customFields: true } });
  const cf = (l?.customFields || {}) as Cf;
  const pend = cf._caixaAnalisePendente as AnalisePendente | undefined;
  if (!l || !pend?.por) return false;
  const c = (cf._caixaCadastro || {}) as Cf;
  if (c.avaliacao?.status) { await gravarAnalisePendente(leadId, null); return false; } // a análise já foi pedida por outro caminho
  const q = participantesDaAvaliacao(participantesDa(cf));
  const entram = [q.tomador, ...q.incluir].filter(Boolean) as any[];
  if (!entram.length || !entram.every((p) => gravado(c, p.ordem))) return true; // ainda falta gravar alguém: espera
  await gravarAnalisePendente(leadId, null);
  const agora = new Date().toISOString();
  await salvar(leadId, (x) => { x.conferencia = { status: 'CONFERIDO', por: `automático (análise autorizada por ${pend.por})`, em: agora }; });
  const erro = await pedirAvaliacao(accountId, leadId, `${pend.por} (depois do cadastro)`, { enviar: pend.enviar, autorizacao: { por: pend.por, userId: pend.userId, em: pend.em, enviar: pend.enviar, denovo: false, via: pend.via } });
  const { sendPushToAccount } = require('./push.service') as typeof import('./push.service');
  if (erro) {
    await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `⚠️ Cadastro na CAIXA gravado, mas a análise de crédito autorizada por ${pend.por} NÃO foi pra fila: ${erro}. Rode pelo botão "Análise CAIXA" depois de acertar.` } }).catch(() => {});
    sendPushToAccount(accountId, { title: `⚠️ ${l.name}: análise CAIXA não saiu`, body: erro.slice(0, 120), leadId }, l.userId ? [l.userId] : undefined).catch(() => {});
  } else {
    sendPushToAccount(accountId, { title: `🏦 ${l.name}: cadastro gravado, análise CAIXA na fila`, body: `Autorizada por ${pend.por}${pend.enviar ? '; a extensão envia à CAIXA' : '; para antes de enviar'}`, leadId }).catch(() => {});
  }
  return true;
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
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🔎 Cadastro na CAIXA gravado (${ps.map((p) => p.nome).join(', ')}): CONFIRA no Caixa Aqui. Estando certo, clique em "Cadastro conferido" no painel CAIXA da Análise de Crédito${AVALIACAO_APOS_CONFERENCIA ? ' — no Home Equity a Avaliação de Risco roda em seguida' : ''}.` } }).catch(() => {});
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
  const avaliar = he && AVALIACAO_APOS_CONFERENCIA;
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `✅ Cadastro na CAIXA conferido por ${por}.${avaliar ? ' A Avaliação de Risco foi pra fila da extensão.' : he ? ' A Avaliação de Risco NÃO roda agora (Fabio 31/10: nenhum crédito por enquanto).' : ' No Financiamento a Avaliação de Risco não roda sozinha.'}` } }).catch(() => {});
  return avaliar ? pedirAvaliacao(accountId, leadId, `${por} (cadastro conferido)`) : null;
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
export function operacaoDaAvaliacao(cf: Cf, pessoas: any[], prazoPedido?: number | null, fh?: { pediuPrice?: boolean; compraVenda?: number | null } | null, he?: { pediuSac?: boolean } | null): Record<string, any> | string {
  const imovel = valorDe(cf.valor_imovel), credito = valorDe(cf.valor_credito);
  const renda = pessoas.reduce((t, p) => t + (valorDe(p?.rendaBrutaMensal) || valorDe(p?.contracheques?.[0]?.bruto) || 0), 0);
  if (!imovel || !credito) return 'valor do imóvel ou do crédito vazio no card';
  if (!renda) return 'renda bruta vazia na ficha';
  // Valor do imóvel no Financiamento = o de COMPRA E VENDA da proposta que o próprio cliente mandou (Fabio 02/11), não o do card.
  if (fh) return operacaoFh(cf, { imovel: fh.compraVenda && fh.compraVenda > 0 ? fh.compraVenda : imovel, credito, renda, prazoPedido, pediuPrice: !!fh.pediuPrice });
  return { portabilidade: 'NAO', origem: 'CAIXA', prazo: prazoPedido && prazoPedido > 0 ? Math.round(prazoPedido) : 240, valorImovel: imovel, valorFinanciamento: credito,
    rendaBruta: Math.round(renda * 100) / 100, prestacao: Math.round(renda * 0.3 * 100) / 100, garantia: 'alienacao fiduciaria', amortizacao: he?.pediuSac ? 'SAC' : 'PRICE', indexador: 'TR' }; // Home Equity sempre PRICE, salvo o cliente pedir SAC (Fabio 02/11)
}

/** Imóvel NOVO no Financiamento (Fabio 02/11: "caso o imóvel seja novo, deverá gerar um push para a equipe e não rodar o crédito, apenas fazer o cadastro"):
 *  card marcado como novo, ou vendedor pessoa jurídica (construtora/incorporadora) na ficha do vendedor. Sem ficha do vendedor = usado. Pura. */
export function imovelNovo(cf: Cf): boolean {
  if (/\bnovo|lancamento|na planta/.test(String(cf.imovel_situacao || cf.condicao_imovel || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())) return true;
  const { ehPessoaJuridica } = require('./doc-review.service') as typeof import('./doc-review.service');
  return (Array.isArray(cf._fichaVendedor?.pessoas) ? cf._fichaVendedor.pessoas : []).some((p: any) => ehPessoaJuridica(p?.nome) || String(p?.cnpj || '').replace(/\D/g, '').length === 14);
}

/** Enquadramento do imóvel USADO na CAIXA (Fabio 02/11, prints da Avaliação de Riscos): MCMV outras classes (FGTS, "NPMCMV- FS - Imóvel Usado Individual"),
 *  MCMV Classe Média (FGTS, "PMCMV - Imóvel Usado Individual - Classe Média") ou SBPE ("CCSBPE SFH - TR - Aquisição de Imóvel Residencial Usado").
 *  Limites do programa (renda bruta familiar / valor do imóvel) confirmados pelo Fabio 02/11; fora deles — ou com outro imóvel na mesma região — é SBPE. */
export const MCMV_LIMITES = { outrasClasses: { renda: 8_600, imovel: 350_000 }, classeMedia: { renda: 12_000, imovel: 500_000 } };

/** SBPE ou MCMV da operação que foi pra CAIXA (Fabio 11/11: "além de mostrar aprovado na CAIXA precisa mostrar se foi SBPE ou MCMV"), lido das linhas que a
 *  extensão manda da tela da operação ("• produto: CCSBPE SFH - …", "• origem do recurso: SBPE", "Enquadramento: …"). Home Equity (EGI) → null. Pura. */
export function enquadramentoDaOperacao(texto: string | null | undefined): 'SBPE' | 'MCMV' | 'MCMV Classe Média' | null {
  const t = String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const campo = (re: RegExp) => (re.exec(t) || [])[1] || '';
  const origem = campo(/origem do recurso\s*:\s*([^\n]+)/);
  for (const s of [campo(/produto\s*:\s*([^\n]+)/), campo(/enquadramento\s*:\s*([^;\n]+)/), origem]) {
    if (/mcmv/.test(s)) return /classe media/.test(s) ? 'MCMV Classe Média' : 'MCMV';
    if (/sbpe/.test(s)) return 'SBPE';
  }
  return /fgts/.test(origem) ? 'MCMV' : null;
}
/** Taxa anual usada SÓ pra estimar a 1ª parcela da SAC e decidir SAC x PRICE (não vai pra CAIXA). */
const TAXA_ESTIMADA = { SBPE: 0.12, MCMV_CM: 0.105, MCMV: 0.085 };
export const PRAZO_MAX_FH = 420;

/** Tela "Informações da Operação" do Financiamento Habitacional, imóvel usado. Amortização (Fabio 02/11): SAC é o padrão; PRICE quando a 1ª parcela da SAC
 *  passa da prestação que a renda comporta (30% da renda bruta — cliente de renda mais baixa, pra alcançar o valor do financiamento) ou quando o cliente pediu PRICE. Pura. */
function operacaoFh(cf: Cf, v: { imovel: number; credito: number; renda: number; prazoPedido?: number | null; pediuPrice: boolean }): Record<string, any> | string {
  if (imovelNovo(cf)) return 'imóvel NOVO — no Financiamento a CAIXA fica só com o cadastro; a avaliação do imóvel novo é com a equipe (Fabio 02/11)';
  // Exceção (Fabio 02/11): cliente que já tem OUTRO imóvel na mesma região do que quer comprar vai pro SBPE mesmo dentro dos limites do MCMV.
  const outroNaRegiao = /^s/i.test(String(cf.outro_imovel_regiao || '').trim());
  const faixa = outroNaRegiao ? 'SBPE' : v.renda <= MCMV_LIMITES.outrasClasses.renda && v.imovel <= MCMV_LIMITES.outrasClasses.imovel ? 'MCMV'
    : v.renda <= MCMV_LIMITES.classeMedia.renda && v.imovel <= MCMV_LIMITES.classeMedia.imovel ? 'MCMV_CM' : 'SBPE';
  const prazo = v.prazoPedido && v.prazoPedido > 0 ? Math.min(Math.round(v.prazoPedido), PRAZO_MAX_FH) : (Number(String(cf.prazo_financ || '').match(/(\d+)\s*mes/)?.[1]) || PRAZO_MAX_FH);
  const prestacao = Math.round(v.renda * 0.3 * 100) / 100;
  const i = Math.pow(1 + TAXA_ESTIMADA[faixa], 1 / 12) - 1;
  const sac1 = Math.round((v.credito / prazo + v.credito * i) * 100) / 100;
  const amortizacao = v.pediuPrice || sac1 > prestacao ? 'PRICE' : 'SAC';
  const porque = v.pediuPrice ? 'o cliente pediu PRICE' : sac1 > prestacao ? `a 1ª parcela estimada na SAC (R$ ${sac1.toLocaleString('pt-BR')}) passa dos 30% da renda (R$ ${prestacao.toLocaleString('pt-BR')})` : `SAC cabe na renda (1ª parcela estimada R$ ${sac1.toLocaleString('pt-BR')})`;
  const base = { fh: true, portabilidade: 'NAO', prazo, valorImovel: v.imovel, valorFinanciamento: v.credito, rendaBruta: Math.round(v.renda * 100) / 100, prestacao, amortizacao, amortizacaoPorque: porque, indexador: 'TR', garantia: 'alien. fiduc. - imoveis residenciais urbanos' };
  if (faixa === 'SBPE') return { ...base, enquadramento: 'SBPE', origem: 'SBPE', modalidade: 'aquisicao de imovel residencial usado - individual', produto: `ccsbpe ${v.imovel > 1_500_000 ? 'sfi' : 'sfh'} - tr - aquisicao de imovel residencial usado` };
  if (faixa === 'MCMV_CM') return { ...base, enquadramento: 'MCMV Classe Média', origem: 'FGTS', modalidade: 'aquisicao de imovel usado', produto: 'pmcmv - imovel usado individual - classe media' };
  return { ...base, enquadramento: 'MCMV (outras classes)', origem: 'FGTS', modalidade: 'aquisicao de imovel usado', produto: 'npmcmv- fs - imovel usado individual' };
}

/** Botão "Fazer cadastro" do painel CAIXA (Fabio 31/10: "preciso de um botão também para fazer o cadastro do cliente quando não rodar sozinho"):
 *  sem nada na CAIXA → fila da consulta (o cadastro sai em seguida); já consultado → cadastro de quem ainda não está GRAVADO, mesmo com a ficha incompleta
 *  (a extensão para e mostra o que faltou). */
export async function fazerCadastroManual(accountId: string, leadId: string, por: string, userId: string | null = null): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  const c = cf._caixaCadastro;
  const ps = participantesDa(cf);
  if (!ps.length) return 'O card ainda não tem a ficha de cadastro (lida dos documentos da pasta ou da conversa) nem os participantes da proposta';
  if (!c || (c.status !== 'FILA' && !ps.some((p) => c.consultas?.[p.ordem]))) return pedirCadastroCaixa(accountId, leadId, por, userId);
  if (c.status === 'FILA') return 'Já está na fila da CAIXA (consulta do nome em andamento)';
  const ordens = ps.filter((p) => !gravado(c, p.ordem) && !['FILA', 'RODANDO'].includes(String(c.cadastros?.[p.ordem]?.status || ''))).map((p) => p.ordem);
  if (!ordens.length) return ps.every((p) => gravado(c, p.ordem)) ? 'Todos os participantes já estão cadastrados (GRAVADO)' : 'O cadastro já está na fila/rodando';
  return pedirCadastroParticipantes(accountId, leadId, ordens, por);
}

/** Resumo da consulta em Oportunidades de Negócios pra coluna CAIXA do HE (Fabio 10/11): "Pesquisa Cadastral" (Nada consta / Constam ocorrências), CPF fora do
 *  regular na Receita e o que trava (consultaSegura). Sem CPF nem texto da tela. Pura. */
export function resumoConsulta(texto: unknown): { consulta: string | null; alerta: string | null } {
  const t = String(texto || '').replace(/\s+/g, ' ');
  if (!t) return { consulta: null, alerta: null };
  if (/^SEM CPF/i.test(t)) return { consulta: 'sem CPF', alerta: null };
  const receita = /situa[cç][aã]o (?:do )?cpf na receita:\s*(.+?)(?=\s*pesquisa cadastral|\s*\.\s|$)/i.exec(t)?.[1]?.trim() || '';
  const consulta = /pesquisa cadastral:\s*nada consta/i.test(t) ? 'Nada consta' : /pesquisa cadastral:\s*constam? ocorr/i.test(t) ? 'Constam ocorrências' : null;
  const alerta = consultaSegura([t]) || (receita && !/\bregular\b/i.test(receita) ? `CPF na Receita: ${receita.slice(0, 60)}` : null);
  return { consulta, alerta };
}

/** Uma linha com o andamento da CAIXA no card — aba "Análise CAIXA" da Análise de Crédito (Fabio 11/11: "os clientes que estão lá também precisam aparecer na análise
 *  de crédito"): ficha, consulta do nome, cadastro de cada participante (ou o que falta pra ele sair) e a análise. `resultado` = o que a CAIXA respondeu, quando há.
 *  Sem CPF nem texto de tela. Pura. */
export function andamentoCaixa(cf: Cf, resultado?: string | null): string {
  const c = (cf._caixaCadastro || {}) as Cf;
  const ps = participantesDa(cf);
  const partes: string[] = [];
  const primeiro = (p: any) => String(p?.nome || `${p?.ordem}º participante`).trim().split(/\s+/)[0];
  const rot = (p: any, txt: string) => (ps.length > 1 ? `${primeiro(p)}: ${txt}` : txt);
  if (!temFicha(cf)) partes.push('sem a ficha de cadastro (esperando os documentos)');
  // Consulta do nome (Oportunidades de Negócios)
  if (c.status === 'CONSULTA_PARADA') partes.push('consulta do nome não saiu');
  else if (c.status === 'FILA') partes.push('consulta do nome na fila');
  else if (ps.length && ps.every((p) => c.consultas?.[p.ordem])) {
    const alertas = ps.map((p) => resumoConsulta(c.consultas[p.ordem]?.texto)).filter((r) => r.alerta || r.consulta === 'Constam ocorrências');
    partes.push(alertas.length ? `consulta do nome: ${alertas[0].alerta || 'constam ocorrências'}` : 'nome consultado');
  } else if (temFicha(cf) && !cf._caixaCadastro) partes.push('ficha pronta, entra na fila da consulta');
  // Cadastro de cada participante
  if (temFicha(cf) && cf._caixaCadastro) {
    for (const p of ps) {
      const st = String(c.cadastros?.[p.ordem]?.status || '');
      const falta = faltaParaCadastro(p);
      if (/^GRAVADO/i.test(st)) partes.push(rot(p, 'cadastro gravado'));
      else if (st === 'FILA' || st === 'RODANDO') partes.push(rot(p, st === 'FILA' ? 'cadastro na fila' : 'cadastrando agora'));
      else if (st) partes.push(rot(p, `cadastro não gravou (${st.replace(/\s+/g, ' ').slice(0, 70)})`));
      else if (falta.length) partes.push(rot(p, `cadastro esperando ${falta.join(', ').slice(0, 90)}`));
      else if (c.consultas?.[p.ordem]) partes.push(rot(p, 'cadastro entra na fila'));
    }
  }
  // Análise de crédito (Avaliação de Risco) — só com o clique de alguém
  const av = String(c.avaliacao?.status || '');
  if (resultado) partes.push(`análise: ${String(resultado).replace(/\s+/g, ' ').slice(0, 80)}`);
  else if (av === 'FILA') partes.push('análise na fila');
  else if (av) partes.push(`análise: ${av.replace(/\s+/g, ' ').slice(0, 70)}`);
  else if (cf._caixaAnalisePendente?.por) partes.push('análise autorizada, sai depois do cadastro');
  else if (ps.length && cf._caixaCadastro && ps.every((p) => gravado(c, p.ordem))) partes.push('análise esperando o clique em "Análise CAIXA"');
  return partes.join(' · ');
}

/** Painel CAIXA da Análise de Crédito: cards com cadastro na CAIXA (sem CPF) — rodando, conferir, avaliação — e os que têm ficha e ainda não foram pra CAIXA. */
export async function painelCaixa(accountId: string): Promise<any[]> {
  const rows = await prisma.$queryRaw<{ id: string; name: string; c: Cf; ps: any; dept: string | null; res: string | null }[]>`
    SELECT l.id, l.name, l."customFields"->'_caixaCadastro' AS c, l."customFields"->'_fichaCadastral'->'participantes' AS ps, d.name AS dept,
      l."customFields"->'_caixaResultado'->>'status' AS res
    FROM "Lead" l LEFT JOIN "Pipeline" p ON p.id = l."pipelineId" LEFT JOIN "Department" d ON d.id = p."departmentId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."customFields"->'_caixaCadastro' IS NOT NULL
    ORDER BY l."updatedAt" DESC LIMIT 80`;
  return rows.map((r) => {
    const c = r.c || {};
    const ps = (Array.isArray(r.ps) ? r.ps : []).map((p: any, i: number) => ({ ordem: Number(p.ordem) || i + 1, nome: p.nome || '', semRenda: p.semRenda === true }));
    const atual = c.atual && Date.now() - Date.parse(c.atual.desde) < LEASE_MS ? { tipo: c.atual.tipo || 'consultar', ordem: c.atual.ordem, desde: c.atual.desde } : null;
    return {
      leadId: r.id, nome: r.name, produto: ehHe(r.dept) ? 'HE' : 'FH', status: c.status || null, atual,
      participantes: ps.map((p: any) => ({ ...p, cadastro: c.cadastros?.[p.ordem]?.status || null, consultado: !!c.consultas?.[p.ordem], ...resumoConsulta(c.consultas?.[p.ordem]?.texto) })),
      conferencia: c.conferencia || null,
      avaliacao: c.avaliacao ? { status: c.avaliacao.status, pedidoEm: c.avaliacao.pedidoEm || null, fim: c.avaliacao.fim || null } : null,
      resultado: r.res ? String(r.res).slice(0, 160) : null, // resultado da Avaliação de Risco (Formulários Enviados), pra coluna CAIXA do HE
    };
  });
}
export async function semCadastroCaixa(accountId: string): Promise<any[]> {
  const rows = await prisma.$queryRaw<{ id: string; name: string; ps: any; dept: string | null; at: string | null }[]>`
    SELECT l.id, l.name, l."customFields"->'_fichaCadastral'->'participantes' AS ps, d.name AS dept, l."customFields"->'_fichaCadastral'->>'at' AS at
    FROM "Lead" l LEFT JOIN "Pipeline" p ON p.id = l."pipelineId" LEFT JOIN "Department" d ON d.id = p."departmentId"
    WHERE l."accountId" = ${accountId} AND l.status = 'OPEN' AND l.archived = false AND l."isGroup" = false
      AND jsonb_typeof(l."customFields"->'_fichaCadastral'->'participantes') = 'array' AND l."customFields"->'_caixaCadastro' IS NULL
      AND l."customFields"->'_caixaRota' IS NOT NULL -- só quem pediu a CAIXA (Fabio 01/11); a ficha também sai pra contratação dos outros bancos
    ORDER BY l."customFields"->'_fichaCadastral'->>'at' DESC NULLS LAST LIMIT 30`;
  return rows.map((r) => ({ leadId: r.id, nome: r.name, produto: ehHe(r.dept) ? 'HE' : 'FH', fichaEm: r.at, participantes: (Array.isArray(r.ps) ? r.ps : []).map((p: any) => p.nome || '').filter(Boolean) }));
}

/* ── Botões "Cadastro CAIXA" e "Análise CAIXA" no topo do card (Fabio 03/11: "NÃO ACHEI O BOTÃO PARA RODAR CADASTRO NA CAIXA E TBM OUTRO BOTÃO ESCRITO, RODAR ANÁLISE DE
 * CRÉDITO NA CAIXA"). Mesma fila da extensão "Cadastro CAIXA" (fazerCadastroManual / pedirAvaliacao) — nada paralelo. O clique no "Análise CAIXA" É o OK do Fabio pra
 * AQUELE cliente (31/10: a Avaliação de Risco só roda com o pedido explícito): quem/quando ficam em _caixaCadastro.avaliacao.autorizacao + anotação. ── */

/** 'cadastro' (Fabio 11/11): falta só o cadastro gravado — não trava; a análise sai sozinha depois dele (_caixaAnalisePendente). */
type Trava = { tipo: 'andamento' | 'feito' | 'falta' | 'cadastro'; msg: string } | null;
type Quem = { id: string; nome: string };
type IoLike = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;
const quando = (iso?: string | null): string => (iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
const nomeP = (p: any) => p?.nome || `${p?.ordem}º participante`;

/** A fila da CAIXA só pega card aberto e não arquivado (proximaConsulta). Pura. */
function cardFechado(l: { status: string; archived: boolean }): string | null {
  if (l.archived) return 'O card está arquivado — a fila da CAIXA só roda card aberto. Restaure o card antes.';
  if (l.status !== 'OPEN') return `O card está como ${l.status === 'WON' ? 'Ganho' : 'Perdido'} — a fila da CAIXA só roda card aberto. Reabra o card antes.`;
  return null;
}

/** Cadastro: já na fila/rodando ou todos GRAVADO (botão desabilitado). Sem ficha não trava — o botão manda ler os documentos. Pura. */
export function travaCadastroCaixa(cf: Cf): Trava {
  const c = cf._caixaCadastro as Cf | undefined;
  const ps = participantesDa(cf);
  const atual = c?.atual && Date.now() - Date.parse(c.atual.desde) < LEASE_MS ? c.atual : null;
  if (atual && atual.tipo !== 'avaliar') return { tipo: 'andamento', msg: `A extensão está ${atual.tipo === 'cadastrar' ? 'cadastrando' : 'consultando o nome de'} ${nomeP(ps.find((p) => p.ordem === atual.ordem) || { ordem: atual.ordem })} na CAIXA agora (desde ${quando(atual.desde)})` };
  if (c?.status === 'FILA') return { tipo: 'andamento', msg: `Já na fila da CAIXA desde ${quando(c.pedidoEm)}${c.por ? ` (${c.por})` : ''}: consulta do nome em Oportunidades de Negócios; o cadastro sai em seguida` };
  if (!c || !ps.length || !ps.some((p) => c.consultas?.[p.ordem])) return null;
  if (ps.every((p) => gravado(c, p.ordem))) return { tipo: 'feito', msg: `Já cadastrado na CAIXA (GRAVADO): ${ps.map(nomeP).join(', ')}` };
  const pend = ps.filter((p) => !gravado(c, p.ordem));
  const naFila = pend.filter((p) => ['FILA', 'RODANDO'].includes(String(c.cadastros?.[p.ordem]?.status || '')));
  if (naFila.length === pend.length) return { tipo: 'andamento', msg: `Cadastro na fila da extensão desde ${quando(c.cadastros?.[naFila[0].ordem]?.pedidoEm)}: ${naFila.map(nomeP).join(', ')}` };
  return null;
}

/** Análise (Avaliação de Risco): na fila/rodando (desabilitado) ou o que falta pra rodar — as mesmas regras que a fila aplica na hora (participantesDaAvaliacao,
 *  operacaoDaAvaliacao), pra o erro sair no clique e não virar "SEGURADO" depois. Cadastro GRAVADO de quem entra é pré-requisito (ordem da CAIXA, Fabio 29/10).
 *  Já ENVIADA/terminada NÃO trava mais (Fabio 03/11): o botão vira "Rodar análise CAIXA de novo" (avaliacaoTerminada). Pura. */
export function travaAnaliseCaixa(cf: Cf, fh: boolean): Trava {
  const c = (cf._caixaCadastro || {}) as Cf;
  const av = c.avaliacao as Cf | undefined;
  const st = String(av?.status || '');
  const quem = av?.autorizacao?.por || av?.por;
  if (st === 'FILA') return { tipo: 'andamento', msg: `Análise de crédito na fila da extensão da CAIXA desde ${quando(av!.pedidoEm)}${quem ? ` (autorizada por ${quem})` : ''}` };
  if (av?.status && !avaliacaoTerminada(cf)) return { tipo: 'andamento', msg: `A extensão está rodando a Avaliação de Risco na CAIXA (desde ${quando(av.inicio)})` };
  // Consulta do resultado em andamento: a extensão gravaria o resultado antigo por cima do "aguardando a nova" — espera ela terminar.
  const res = cf._caixaResultado as Cf | undefined;
  if (res?.status === 'RODANDO' && res.inicio && Date.now() - Date.parse(res.inicio) < LEASE_MS) return { tipo: 'andamento', msg: `A extensão está consultando o resultado da avaliação em Formulários Enviados (desde ${quando(res.inicio)}) — espere terminar` };
  const pend = cf._caixaAnalisePendente as Cf | undefined;
  if (pend?.por && !av?.status) return { tipo: 'andamento', msg: `Análise autorizada por ${pend.por} (${quando(pend.em)}): vai pra fila sozinha assim que o cadastro na CAIXA gravar` };
  if (!temFicha(cf)) return { tipo: 'falta', msg: 'O card ainda não tem a ficha de cadastro (dados lidos dos documentos) — rode o "Cadastro CAIXA" primeiro' };
  const q = participantesDaAvaliacao(participantesDa(cf));
  if (q.segurar) return { tipo: 'falta', msg: `Não dá pra rodar a análise: ${q.segurar}` };
  const op = operacaoDaAvaliacao(cf, [q.tomador, ...q.incluir], null, fh ? { pediuPrice: false, compraVenda: null } : null, fh ? null : { pediuSac: false });
  if (typeof op === 'string') return { tipo: 'falta', msg: `Não dá pra rodar a análise: ${op}` };
  const semCadastro = [q.tomador, ...q.incluir].filter((p) => !gravado(c, p.ordem));
  if (semCadastro.length) {
    // Cadastro faltando não trava mais (Fabio 11/11): o CRM faz o cadastro e a análise sai sozinha quando ele gravar. Dado faltando na ficha trava (o cadastro pararia).
    const faltas = semCadastro.filter((p) => faltaParaCadastro(p).length).map((p) => `${nomeP(p)}: ${faltaParaCadastro(p).join(', ')}`);
    if (faltas.length) return { tipo: 'falta', msg: `Falta na ficha pro cadastro na CAIXA — ${faltas.join('; ')}` };
    return { tipo: 'cadastro', msg: `O cadastro de ${semCadastro.map(nomeP).join(', ')} na CAIXA ainda não foi gravado: ao autorizar, o CRM faz o cadastro e a análise vai pra fila sozinha assim que ele gravar (sem a conferência manual).` };
  }
  return null;
}

/** Estado dos dois botões (GET /api/caixa-cadastro/:leadId/card). Sem CPF. `mostrar`: a CAIXA faz sentido no card — já tem algo da CAIXA (fila, rota, pedido,
 *  opção, resultado, ficha de cadastro), é Financiamento Habitacional (a CAIXA é um dos bancos dele) ou é Home Equity com alguma aprovação (Fabio 01/11: CAIXA só
 *  depois de aprovar). */
export async function estadoCaixaDoCard(accountId: string, leadId: string): Promise<Record<string, any> | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { status: true, archived: true, isGroup: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!l) return null;
  const cf = (l.customFields || {}) as Cf;
  const c = (cf._caixaCadastro || {}) as Cf;
  const dept = l.pipeline?.department?.name || '';
  const he = ehHe(dept);
  const ficha = temFicha(cf);
  const temCaixa = !!(cf._caixaCadastro || cf._caixaRota || cf._caixaPedido || cf._caixaResultado || ficha || /caixa/i.test(String(cf._optouCaixa?.banco || '')));
  const { temAprovacao } = require('./caixa-screening.service') as typeof import('./caixa-screening.service');
  const mostrar = !l.isGroup && (temCaixa || /habitacional/i.test(dept) || (he && (await temAprovacao(leadId, cf).catch(() => false))));
  // Pedido da CAIXA (Fabio 11/11 — consulta do nome antes de qualquer documento): o botão "Consultar na CAIXA" aparece mesmo quando o bloco não teria nada da CAIXA pra mostrar.
  const ped = cf._caixaPedido as Cf | undefined;
  const podeConsultar = !l.isGroup && !cardFechado(l) && !ped;
  const pedido = ped ? {
    em: ped.at || null,
    por: ped.por || null,
    resultado: ped.limpo ? 'limpo' : (c.consultadoEm && cf._ocorrencias?.consultadoEm === c.consultadoEm) ? 'ocorrencia' : 'andamento',
  } : null;
  if (!mostrar) return { mostrar: false, podeConsultar };
  const ps = participantesDa(cf);
  const q = ficha ? participantesDaAvaliacao(ps) : null;
  const av = c.avaliacao as Cf | undefined;
  const terminada = avaliacaoTerminada(cf);
  const anteriores = Array.isArray(av?.anteriores) ? av!.anteriores : [];
  const res = cf._caixaResultado as Cf | undefined;
  return {
    mostrar: true,
    podeConsultar,
    pedido,
    produto: he ? 'HE' : 'FH',
    fechado: cardFechado(l),
    temFicha: ficha,
    rotaCaixa: !!cf._caixaRota,
    avaliacaoFeita: avaliacaoFeita(cf),
    participantes: ps.map((p) => ({ ordem: p.ordem, nome: p.nome || '', semRenda: p.semRenda === true, consultado: !!c.consultas?.[p.ordem], cadastro: c.cadastros?.[p.ordem]?.status ? String(c.cadastros[p.ordem].status).slice(0, 90) : null, falta: ficha ? faltaParaCadastro(p) : [] })),
    cadastro: { trava: travaCadastroCaixa(cf) },
    analise: {
      trava: travaAnaliseCaixa(cf, !he),
      // Janela do "Cadastro CAIXA" mostra "rodar a análise em seguida" (Fabio 11/11).
      podeEmSeguida: !c.avaliacao?.status && !cf._caixaAnalisePendente && ((t) => !t || t.tipo === 'cadastro' || (t.tipo === 'falta' && !ficha))(travaAnaliseCaixa(cf, !he)),
      // Rodada anterior chegou à CAIXA → o cadastro já foi usado lá; a conferência só é pedida antes da 1ª avaliação.
      precisaConferir: c.conferencia?.status === 'PENDENTE' && !(terminada && avaliacaoFeita(cf)),
      produto: he ? '11 - Empréstimo com Garantia de Imóvel (EGI)' : '1 - Crédito Imobiliário',
      tomador: q?.tomador?.nome || null, incluir: (q?.incluir || []).map((x) => x.nome), fora: (q?.fora || []).map((x) => x.nome),
      valorImovel: cf.valor_imovel ?? null, valorCredito: cf.valor_credito ?? null,
      avaliacao: av ? { status: String(av.status || '').slice(0, 160), pedidoEm: av.pedidoEm || null, inicio: av.inicio || null, fim: av.fim || null, por: av.por || null, enviar: av.enviar === true, denovo: av.denovo === true, autorizacao: av.autorizacao || null, vezes: anteriores.length + 1 } : null,
      // Já rodou (enviada, com resultado, parada…) → "Rodar análise CAIXA de novo".
      // refazer = a avaliação que deu erro e vai ser REABERTA (proposta/data de Formulários Enviados); null = nenhuma chegou à CAIXA, roda do começo.
      denovo: terminada ? { status: String(terminada.status || '').slice(0, 160), fim: terminada.fim || terminada.pedidoEm || null, resultado: res?.status && res.status !== 'AGUARDANDO_NOVA_AVALIACAO' ? String(res.status).slice(0, 200) : null, refazer: avaliacaoParaRefazer([...anteriores, resumoAvaliacaoAnterior(terminada, res)], he ? '11 - empréstimo com garantia de imóvel' : '1 - crédito imobiliário') } : null,
      resultado: (require('./caixa-resultado.service') as typeof import('./caixa-resultado.service')).resultadoNoCard(res),
    },
  };
}

/** Botão "Cadastro CAIXA": reaproveita o "Fazer cadastro" do painel CAIXA (consulta do nome se ainda não consultou; senão o cadastro de quem não está GRAVADO). Sem a
 *  ficha de cadastro, manda ler os documentos (pasta do Drive ou conversa — gerarFichaCadastral, 1–3 min) e, com ela pronta, a consulta/o cadastro vão pra fila sozinhos. */
export async function cadastroCaixaPeloCard(accountId: string, leadId: string, quem: Quem, io?: IoLike, opts: { analise?: boolean; enviar?: boolean } = {}): Promise<{ erro: string } | { mensagem: string }> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, status: true, archived: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!l) return { erro: 'Lead não encontrado' };
  const fechado = cardFechado(l);
  if (fechado) return { erro: fechado };
  const cf = (l.customFields || {}) as Cf;
  const trava = travaCadastroCaixa(cf);
  if (trava) return { erro: trava.msg };
  const c = cf._caixaCadastro as Cf | undefined;
  const ps = participantesDa(cf);
  const ficha = temFicha(cf);
  const consulta = ps.length > 0 && (!c || (c.status !== 'FILA' && !ps.some((p) => c.consultas?.[p.ordem])));
  let mensagem: string;
  if (consulta || ficha) {
    const erro = await fazerCadastroManual(accountId, leadId, quem.nome, quem.id);
    if (erro) return { erro };
  }
  if (ficha && consulta) mensagem = 'Na fila da CAIXA: a extensão consulta o nome de cada participante e, em seguida, faz o cadastro pela ficha.';
  else if (ficha) {
    const cads = ((((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf)._caixaCadastro?.cadastros || {}) as Cf;
    const foram = ps.filter((p) => cads[p.ordem]?.status === 'FILA' && cads[p.ordem]?.por === quem.nome);
    const faltas = foram.filter((p) => faltaParaCadastro(p).length).map((p) => `${nomeP(p)}: ${faltaParaCadastro(p).join(', ')}`);
    mensagem = `Cadastro de ${foram.map(nomeP).join(', ') || 'quem falta'} na fila da extensão da CAIXA (preenche pela ficha e o CRM confere).${faltas.length ? ` Atenção, falta na ficha — ${faltas.join('; ')}: a extensão para e mostra o que faltou.` : ''}`;
  } else {
    // Sem ficha: lê os documentos em segundo plano (igual ao POST /api/leads/:id/ficha-cadastral) e, pronta, encaminha pra fila.
    const { gerarFichaCadastral } = require('./ficha-cadastral.service') as typeof import('./ficha-cadastral.service');
    gerarFichaCadastral(accountId, leadId, { userId: quem.id, io })
      .then(async (erro) => {
        if (erro) {
          if (!/sendo lida/.test(erro)) await prisma.note.create({ data: { leadId, userId: quem.id, type: 'COMMENT', content: `📋 Ficha de cadastro não gerada (botão "Cadastro CAIXA"): ${erro}. Sem a ficha o cadastro na CAIXA não sai.` } }).catch(() => {});
          return;
        }
        const depois = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf;
        if (!depois._caixaCadastro) await pedirCadastroCaixa(accountId, leadId, quem.nome, quem.id);
        else await cadastroAutomatico(accountId, leadId);
      })
      .catch((e) => console.error('[CAIXA] ficha pelo botão do card:', e?.message));
    mensagem = consulta
      ? 'Consulta do nome na fila da CAIXA. Lendo os documentos pra montar a ficha de cadastro (1–3 min) — com ela pronta, o cadastro vai pra fila sozinho.'
      : 'Lendo os documentos do cliente pra montar a ficha de cadastro (1–3 min) — com ela pronta, a consulta e o cadastro na CAIXA vão pra fila sozinhos. Se faltar documento, aparece nas anotações.';
  }
  // "Rodar a análise em seguida" (Fabio 11/11: "quando for cadastrar o cliente ele faz essa consulta"): o clique é o OK da análise pra este cliente.
  if (opts.analise) {
    const fresco = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Cf;
    const ta = travaAnaliseCaixa(fresco, !ehHe(l.pipeline?.department?.name));
    const vaiEnviar = opts.enviar !== false;
    if (fresco._caixaCadastro?.avaliacao?.status) mensagem += ' A análise de crédito não vai em seguida: ela já rodou neste card (use "Rodar análise CAIXA de novo").';
    else if (ta?.tipo === 'falta' && temFicha(fresco)) mensagem += ` A análise de crédito NÃO vai em seguida: ${ta.msg}.`;
    else {
      await gravarAnalisePendente(leadId, { por: quem.nome, userId: quem.id, em: new Date().toISOString(), enviar: vaiEnviar, via: 'botão Cadastro CAIXA do card (análise em seguida)' });
      mensagem += ` Quando o cadastro gravar, a análise de crédito ${vaiEnviar ? 'vai pra fila e é enviada à CAIXA' : 'vai pra fila (para antes de enviar)'} sozinha — o clique é a autorização de ${quem.nome} pra este cliente; a conferência manual fica dispensada.`;
    }
  }
  await prisma.note.create({ data: { leadId, userId: quem.id, type: 'COMMENT', content: `🏦 ${quem.nome} pediu o cadastro na CAIXA (botão "Cadastro CAIXA" do card). ${mensagem}` } }).catch(() => {});
  // Consulta: pedirCadastroCaixa já registrou a atividade (com quem clicou).
  if (!consulta) logActivity({ accountId, userId: quem.id, userName: quem.nome, action: 'lead_edited', leadId, leadName: l.name, summary: 'pediu o cadastro na CAIXA' });
  return { mensagem };
}

/** Botão "Análise CAIXA": o clique é o OK pra este cliente. Cadastro gravado e ainda não conferido → pede a confirmação "já conferi" (Fabio 31/10: "depois de o
 *  colaborador conferir é que ele roda"). `enviar` = a extensão clica na seta da tela 3 (sem ele, preenche e para antes de enviar). Avaliação que já rodou → só com
 *  `denovo` (botão "Rodar análise CAIXA de novo", Fabio 03/11 — Jézer/Fernanda depois da autorização do PV): o clique é a nova autorização. */
export async function analiseCaixaPeloCard(accountId: string, leadId: string, quem: Quem, opts: { enviar?: boolean; conferido?: boolean; denovo?: boolean } = {}): Promise<{ erro: string } | { mensagem: string }> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, status: true, archived: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!l) return { erro: 'Lead não encontrado' };
  const fechado = cardFechado(l);
  if (fechado) return { erro: fechado };
  const cf = (l.customFields || {}) as Cf;
  const trava = travaAnaliseCaixa(cf, !ehHe(l.pipeline?.department?.name));
  if (trava && trava.tipo !== 'cadastro') return { erro: trava.msg };
  // Cadastro ainda não gravado (Fabio 11/11: "isso daqui tem que ser automático"): o clique pede o cadastro e a análise sai sozinha quando ele gravar.
  if (trava?.tipo === 'cadastro') {
    const tc = travaCadastroCaixa(cf);
    if (tc?.tipo !== 'andamento') { const erroCad = await fazerCadastroManual(accountId, leadId, quem.nome, quem.id); if (erroCad) return { erro: erroCad }; }
    const quandoFoi = new Date().toISOString();
    const vaiEnviar = opts.enviar === true;
    await gravarAnalisePendente(leadId, { por: quem.nome, userId: quem.id, em: quandoFoi, enviar: vaiEnviar, via: 'botão Análise CAIXA do card (cadastro antes)' });
    const mensagem = `Cadastro na CAIXA ${tc?.tipo === 'andamento' ? 'já estava na fila' : 'na fila da extensão'}; quando gravar, a análise de crédito ${vaiEnviar ? 'vai pra fila e é enviada à CAIXA' : 'vai pra fila (para antes de enviar)'} sozinha.`;
    await prisma.note.create({ data: { leadId, userId: quem.id, type: 'COMMENT', content: `🏦 ${quem.nome} autorizou a análise de crédito na CAIXA (Avaliação de Risco) em ${quando(quandoFoi)}, com o cadastro ainda não gravado. ${mensagem} A conferência manual do cadastro fica dispensada nessa sequência (Fabio 11/11).` } }).catch(() => {});
    logActivity({ accountId, userId: quem.id, userName: quem.nome, action: 'lead_edited', leadId, leadName: l.name, summary: 'autorizou o cadastro + a análise de crédito na CAIXA' });
    return { mensagem };
  }
  const anterior = avaliacaoTerminada(cf);
  if (anterior && !opts.denovo) return { erro: `A Avaliação de Risco deste card já rodou (${String(anterior.status || '').slice(0, 120)}, ${quando(anterior.fim || anterior.pedidoEm)}). Pra rodar de novo, use "Rodar análise CAIXA de novo".` };
  const agora = new Date().toISOString();
  const enviar = opts.enviar === true;
  const denovo = !!anterior;
  const conferir = ((cf._caixaCadastro || {}) as Cf).conferencia?.status === 'PENDENTE' && !(denovo && avaliacaoFeita(cf));
  if (conferir && !opts.conferido) return { erro: 'O cadastro gravado na CAIXA ainda não foi conferido: confira no Caixa Aqui e marque "Já conferi o cadastro" na confirmação.' };
  if (conferir) await salvar(leadId, (x) => { x.conferencia = { ...(x.conferencia || {}), status: 'CONFERIDO', por: quem.nome, em: agora }; });
  const via = denovo ? 'botão Rodar análise CAIXA de novo do card' : 'botão Análise CAIXA do card';
  const erro = await pedirAvaliacao(accountId, leadId, quem.nome, { enviar, denovo, autorizacao: { por: quem.nome, userId: quem.id, em: agora, enviar, denovo, via } });
  if (erro) return { erro };
  const oQue = enviar ? 'A extensão preenche a operação e ENVIA à CAIXA; o resultado sai depois, na consulta de Formulários Enviados.' : 'A extensão preenche a operação e PARA antes de enviar (tela 3), pra conferir.';
  const ant = denovo ? ` Avaliação anterior: ${String(anterior!.status || '—').slice(0, 120)} (${quando(anterior!.fim || anterior!.pedidoEm)})${cf._caixaResultado?.status ? ` — resultado: ${String(cf._caixaResultado.status).slice(0, 140)}` : ''}; foi pro histórico.` : '';
  await prisma.note.create({ data: { leadId, userId: quem.id, type: 'COMMENT', content: `🏦 ${quem.nome} autorizou a análise de crédito na CAIXA${denovo ? ' DE NOVO' : ''} (Avaliação de Risco) em ${quando(agora)} — ${via}.${ant}${conferir ? ` Cadastro no Caixa Aqui conferido por ${quem.nome}.` : ''} ${oQue}` } }).catch(() => {});
  logActivity({ accountId, userId: quem.id, userName: quem.nome, action: 'lead_edited', leadId, leadName: l.name, summary: `autorizou a análise de crédito na CAIXA${denovo ? ' de novo' : ''}${enviar ? '' : ' (sem enviar)'}` });
  // Rodar de novo com avaliação que chegou à CAIXA: a extensão reabre aquela (Formulários Enviados) e clica em Avançar — não preenche outra (Fabio 03/11).
  const alvo = denovo ? avaliacaoParaRefazer([...(Array.isArray(anterior!.anteriores) ? anterior!.anteriores : []), resumoAvaliacaoAnterior(anterior!, cf._caixaResultado)], '') : null;
  if (alvo) return { mensagem: `Na fila da extensão da CAIXA: ela reabre a avaliação que deu erro (${alvo.proposta ? `proposta ${alvo.proposta}` : 'a mais recente do produto'}), clica em Avançar e segue com os dados dela${enviar ? ' até o Solicitar Avaliação' : ', parando antes de enviar'}. O resultado é consultado de novo depois.` };
  const fila = denovo ? 'Avaliação de Risco de novo na fila da extensão da CAIXA (a anterior não chegou à CAIXA: roda do começo)' : 'Análise de crédito na fila da extensão da CAIXA';
  return { mensagem: enviar ? `${fila} — ela preenche e envia; o resultado sai depois.` : `${fila} — ela preenche e para antes de enviar.` };
}
