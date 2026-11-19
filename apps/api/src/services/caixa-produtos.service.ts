import { prisma } from '../lib/prisma';

/* ── CONTA + CARTÃO do PROPONENTE na contratação da CAIXA (Fabio 18/11, Fernanda: "faz a contratação da abertura de conta e cartão de crédito"; "conta
 * individual"; "somente para o proponente principal, tanto abertura de conta quanto cartão, ou quando o cliente preferir fazer no nome do outro que tenha
 * renda"; 19/11: "quando a gente faz a análise de crédito esses produtos já são encaminhados para aprovação; caso estejam aprovados, basta contratá-los").
 * A Avaliação de Risco do Caixa Aqui gera uma linha por produto em Formulários Enviados (Fernanda 03/11: Habitação + Cartão de Crédito + Cheque Azul (CROT)) — o
 * CRM já guarda isso em `_caixaResultado.ultimaTela`. A extensão "Cadastro CAIXA" faz o portal (o CRM nunca digita CPF).
 * 1ª fase ("olhar", só consulta): Formulários Enviados do CPF + Solicitar Contas → CPF → Consultar → grava a tela e PARA. "ate" (19/11): no Solicitar Contas escolhe
 * Individual → Avançar e só segue (até `avancos` telas) as telas que a CAIXA trouxe preenchidas; para na 1ª com campo vazio ou botão de confirmar (não digita nem confirma).
 * O Quadro de Oportunidades da habitação não lista cartão/conta (só crédito imobiliário/EGI). Cartão de Crédito (19/11): o link do menu é goToURLPinpad,
 * mas abre sem o aparelho (Fabio: "não depende dele") — a extensão entra pelo menu, CPF → Consultar cliente → grava e para.
 * Estado: `_caixaProdutos` = { status: FILA | RODANDO | MAPEADO… | PAROU… | ERRO, modo, ordem, nome, pedidoEm, por, tentativas, inicio, fim, aprovados, ultimaTela }. */

type Cf = Record<string, any>;
const LEASE_MS = 10 * 60_000;

async function salvarProd(leadId: string, mut: (c: Cf) => void): Promise<Cf> {
  const l = await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } });
  const c: Cf = { ...(((l?.customFields || {}) as Cf)._caixaProdutos || {}) };
  mut(c);
  await prisma.$executeRaw`UPDATE "Lead" SET "customFields" = jsonb_set(COALESCE("customFields", '{}'::jsonb), '{_caixaProdutos}', ${JSON.stringify(c)}::jsonb, true) WHERE id = ${leadId}`;
  return c;
}
const note = (leadId: string, content: string) => prisma.note.create({ data: { leadId, type: 'COMMENT', content } }).catch(() => {});
const push = (accountId: string, title: string, body: string, leadId: string) => {
  try { (require('./push.service') as typeof import('./push.service')).sendPushToAccount(accountId, { title, body: body.slice(0, 180), leadId }).catch(() => {}); } catch { /* só aviso */ }
};

/** Linhas de Cartão de Crédito / Cheque Azul / conta que a Avaliação de Risco gerou (texto do resultado gravado no card). Pura.
 *  Ex.: "118223324 03/11/2026 Cartão de Crédito — Avaliação Aprovada. (Avaliação de Risco)". */
export function produtosDaAvaliacao(cf: Cf): { proposta: string; data: string; produto: string; resultado: string; aprovado: boolean }[] {
  const t = `${cf._caixaResultado?.ultimaTela || ''}\n${cf._caixaResultado?.texto || ''}`;
  const out: { proposta: string; data: string; produto: string; resultado: string; aprovado: boolean }[] = [];
  const re = /(\d{6,})\s+(\d{2}\/\d{2}\/\d{4})\s+([^—\n·]*?(?:cart[ãa]o|cheque|crot|conta)[^—\n·]*?)\s+—\s+([^(·\n]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const item = { proposta: m[1], data: m[2], produto: m[3].trim(), resultado: m[4].trim(), aprovado: /aprovad/i.test(m[4]) && !/n[ãa]o aprovad|condicionad|erro/i.test(m[4]) };
    if (!out.some((x) => x.proposta === item.proposta)) out.push(item);
  }
  return out;
}

/** Quem leva conta e cartão: o proponente (tomador da Avaliação de Risco — maior renda); `ordem` = outro participante COM renda, se o cliente preferir. Pura. */
export function titularDosProdutos(cf: Cf, ordem?: number): { ordem: number; nome: string; cpf: string; email: string } | { erro: string } {
  const cc = require('./caixa-cadastro.service') as typeof import('./caixa-cadastro.service');
  const ps = cc.participantesDa(cf);
  const q = cc.participantesDaAvaliacao(ps);
  const p = ordem ? ps.find((x: any) => x.ordem === ordem) : q.tomador;
  if (!p) return { erro: ordem ? `não há o ${ordem}º participante na ficha` : 'o card não tem o proponente na ficha' };
  if (p.semRenda === true) return { erro: `${p.nome || `${p.ordem}º participante`} está sem renda — conta e cartão só pro proponente ou outro participante COM renda (Fabio 18/11)` };
  const cpf = String(p.cpf || '').replace(/\D/g, '');
  if (cpf.length !== 11) return { erro: `${p.nome || `${p.ordem}º participante`} sem CPF na ficha` };
  // E-mail da fatura do cartão: o do titular; sem ele, o do outro participante do card (Fabio 19/11, João Pedro sem e-mail: "usa o da Fernanda").
  const emailDe = (x: any) => String(x?.email || cf[`email_${x?.ordem}`] || '').trim();
  const email = emailDe(p) || ps.map(emailDe).find(Boolean) || String(cf.email || '').trim();
  return { ordem: Number(p.ordem) || 1, nome: String(p.nome || ''), cpf, email };
}

/** A equipe pede a conta/cartão (1ª fase: só consulta). Erro em texto. */
export async function pedirProdutosCaixa(accountId: string, leadId: string, por: string, opts: { ordem?: number; modo?: 'olhar' | 'ate'; avancos?: number; conta?: { tipo: 'corrente'; cheque: boolean; gerar: boolean; limite?: string; encaminhar?: boolean; regerar?: boolean } | null; cartao?: boolean | { solicitar?: boolean; bandeira?: string; vencimento?: string; limite?: string; variante?: string } } = {}): Promise<string | null> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!l) return 'Lead não encontrado';
  const cf = (l.customFields || {}) as Cf;
  if (cf._fhChosen?.bank !== 'CAIXA' && !/caixa/i.test(String(cf.instituicao || ''))) return 'O card não está seguindo pela CAIXA';
  const st = cf._caixaProdutos || {};
  if (st.status === 'RODANDO' && st.inicio && Date.now() - Date.parse(st.inicio) < LEASE_MS) return 'A extensão já está com a conta/cartão deste card';
  const t = titularDosProdutos(cf, opts.ordem);
  if ('erro' in t) return t.erro;
  const aprovados = produtosDaAvaliacao(cf);
  // regerar (Fabio 19/11 "Pode gerar e encaminhar"): o nº gerado antes não volta na tela do Solicitar Contas, então só dá pra
  // encaminhar gerando outro na mesma rodada — o antigo fica guardado em numerosAnteriores. Nunca depois de encaminhada.
  if (opts.conta?.gerar && st.numeroConta && !opts.conta.regerar) return `A conta já foi gerada (nº ${st.numeroConta}) — não gero outra`;
  if (opts.conta?.regerar && /^ENCAMINHADO/.test(String(st.contaStatus || ''))) return 'A proposta da conta já foi encaminhada — não gero outro nº';
  if (opts.conta && !opts.conta.gerar && opts.conta.encaminhar && !st.numeroConta) return 'A conta ainda não tem nº gerado — peça a conta (gerar) primeiro';
  if (opts.conta?.encaminhar && /^ENCAMINHADO/.test(String(st.contaStatus || ''))) return 'A proposta da conta já foi encaminhada';
  if (typeof opts.cartao === 'object' && opts.cartao.solicitar && /^SOLICITADO/.test(String(st.cartaoStatus || ''))) return 'O cartão já foi solicitado — não solicito outro';
  // Com a conta definida (Fabio 19/11: "com cheque especial") a tela do endereço precisa ser avançada: no mínimo 1.
  const avancos = Math.max(opts.conta ? 1 : 0, Math.min(8, Number(opts.avancos) || 0));
  await salvarProd(leadId, (x) => {
    if (x.status && x.status !== 'FILA') x.anteriores = [...(x.anteriores || []), { status: x.status, fim: x.fim, modo: x.modo }].slice(-5);
    Object.assign(x, { status: 'FILA', modo: opts.conta ? 'ate' : (opts.modo || 'olhar'), avancos, conta: opts.cartao ? null : (opts.conta || null), cartao: opts.cartao ? { consultar: true, ...(typeof opts.cartao === 'object' && opts.cartao.solicitar ? { solicitar: true, bandeira: opts.cartao.bandeira || 'MASTERCARD', vencimento: opts.cartao.vencimento || '10', ...(opts.cartao.limite ? { limite: opts.cartao.limite } : {}), ...(opts.cartao.variante ? { variante: opts.cartao.variante } : {}) } : {}) } : null, ordem: t.ordem, nome: t.nome, pedidoEm: new Date().toISOString(), por, tentativas: 0, aprovados });
    delete x.inicio; delete x.fim;
    if (opts.conta?.gerar && opts.conta.regerar && x.numeroConta) { x.numerosAnteriores = [...(x.numerosAnteriores || []), { numero: x.numeroConta, em: x.contaGeradaEm }].slice(-5); delete x.numeroConta; delete x.contaGeradaEm; delete x.contaStatus; }
  });
  const linhas = aprovados.length ? aprovados.map((a) => `• ${a.produto} (proposta ${a.proposta}, ${a.data}): ${a.resultado}`).join('\n') : '• (o resultado da Avaliação de Risco gravado no card não lista cartão/cheque azul)';
  await note(leadId, `🏦 Conta + cartão CAIXA de ${t.nome} (proponente) pedidos por ${por} — ${opts.cartao ? (typeof opts.cartao === 'object' && opts.cartao.solicitar ? `CARTÃO DE CRÉDITO — SOLICITAR: Cartão Normal, limite ${opts.cartao.limite || 'disponível'}, ${opts.cartao.bandeira || 'MASTERCARD'}, vencimento dia ${opts.cartao.vencimento || '10'}, fatura só por e-mail, sem proteção perda/roubo, sem análise emergencial, sem adicional — a extensão clica em "Solicitar Contratação" uma vez e para` : 'CARTÃO DE CRÉDITO: Negócios → Cartão de Crédito → Cartão de Crédito → CPF → Consultar cliente → a extensão grava a tela e para (não escolhe nem confirma nada)') : opts.conta ? `conta CORRENTE PF individual ${opts.conta.cheque ? `COM cheque especial${opts.conta.limite ? ` de R$ ${opts.conta.limite}` : ''}` : 'sem cheque especial'}${opts.conta.gerar ? (opts.conta.regerar && st.numeroConta ? ` — gera um nº NOVO (o ${st.numeroConta} não volta na tela; fica sem uso)` : '') + (opts.conta.encaminhar === false ? ' — a extensão clica em "Gerar Nº Conta" uma vez e para' : ' — a extensão clica em "Gerar Nº Conta" e depois em "Encaminhar Proposta", uma vez cada (Fabio 19/11: "a extensão deveria encaminhar")') : opts.conta.encaminhar ? ' — só ENCAMINHAR a proposta da conta já gerada (não gera outro nº)' : ' — preenche e para antes do "Gerar Nº Conta"'}` : opts.modo === 'ate' ? 'no Solicitar Contas a extensão escolhe Individual → Avançar e só segue (até ' + (Number(opts.avancos) || 0) + ' tela(s)) as telas que a CAIXA já trouxe preenchidas; para na 1ª que falta dado ou tem confirmar — não digita nem confirma nada' : 'a extensão só CONSULTA nesta fase (Formulários Enviados + Solicitar Contas), não contrata nada'}.\nO que a Avaliação de Risco já mandou pra aprovação:\n${linhas}`);
  return null;
}

/** Próximo pedido de conta/cartão pra extensão (depois de tudo da fila da CAIXA). */
export async function proximoProdutosCaixa(accountId: string): Promise<any | null> {
  const ids = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND status = 'OPEN' AND archived = false
      AND "customFields"->'_caixaProdutos'->>'status' IN ('FILA', 'RODANDO')
    ORDER BY "customFields"->'_caixaProdutos'->>'pedidoEm' ASC LIMIT 10`;
  for (const { id } of ids) {
    const l = await prisma.lead.findUnique({ where: { id }, select: { name: true, customFields: true } });
    const cf = (l?.customFields || {}) as Cf;
    const st = cf._caixaProdutos || {};
    if (st.status === 'RODANDO') {
      if (st.inicio && Date.now() - Date.parse(st.inicio) < LEASE_MS) return null; // um por vez
      if ((st.tentativas || 0) >= 3) { await salvarProd(id, (x) => { x.status = 'ERRO: a extensão largou 3 vezes — peça de novo'; x.fim = new Date().toISOString(); }); continue; }
    }
    const t = titularDosProdutos(cf, st.ordem);
    if ('erro' in t) { await salvarProd(id, (x) => { x.status = `PAROU: ${t.erro}`; x.fim = new Date().toISOString(); }); await note(id, `⏸️ Conta/cartão CAIXA: ${t.erro}.`); continue; }
    await salvarProd(id, (x) => { x.status = 'RODANDO'; x.inicio = new Date().toISOString(); x.tentativas = (x.tentativas || 0) + 1; });
    return { tipo: 'produtos', modo: st.modo || 'olhar', avancos: Number(st.avancos) || 0, conta: st.conta || null, cartao: st.cartao ? { ...st.cartao, ...(st.cartao.solicitar ? { email: t.email } : {}) } : null, leadId: id, leadName: l!.name, ordem: t.ordem, nome: t.nome, cpf: t.cpf };
  }
  return null;
}

/** O que a extensão viu (status + tela) → estado, anotação e push. */
export async function gravarProdutosCaixa(accountId: string, leadId: string, r: { status?: string; texto?: string; mapa?: any; botoes?: string[]; numeroConta?: string }): Promise<void> {
  const l = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true } });
  if (!l) return;
  const status = String(r.status || 'TELA').slice(0, 400);
  const st = await salvarProd(leadId, (x) => { x.status = status; x.fim = new Date().toISOString(); x.ultimaTela = String(r.texto || '').slice(0, 7000); x.mapa = r.mapa || null; x.botoes = (r.botoes || []).slice(0, 40); if (r.numeroConta) { x.numeroConta = String(r.numeroConta).slice(0, 40); x.contaGeradaEm = new Date().toISOString(); } if (x.cartao && /cart[aã]o/i.test(status)) { x.cartaoStatus = status; x.cartaoEm = new Date().toISOString(); } if (x.conta && /^(ENCAMINHADO|GERADO|CONFERIR: conta)/.test(status)) { x.contaStatus = status; x.contaEm = new Date().toISOString(); } });
  await note(leadId, `🏦 Conta + cartão CAIXA de ${st.nome || 'proponente'} — ${status}${r.numeroConta ? `\n💳 Nº da conta gerado no Caixa Aqui: ${r.numeroConta}` : ''}\n\n${String(r.texto || '').slice(0, 6000)}${(r.botoes || []).length ? `\n\nBotões na tela: ${(r.botoes || []).join(' | ')}` : ''}`);
  push(accountId, `🏦 ${l.name}: conta/cartão CAIXA`, status, leadId);
}
