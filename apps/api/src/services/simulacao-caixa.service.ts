import { prisma } from '../lib/prisma';
import { sendPushToAccount } from './push.service';

/**
 * SIMULAÇÃO NO SIMULADOR DA CAIXA (Fabio 12/11: "sempre que um cliente aprovar na CAIXA, faz aquela mensagem de aprovação, encaminha ao cliente junto com a
 * simulação no simulador da CAIXA; no simulador ele pede um número — o CRM ou a extensão pode colocar o número da API, aí o código vai chegar e ele insere";
 * "na simulação da CAIXA precisa marcar taxa bonificada, quando houver").
 * simuladorhabitacao.caixa.gov.br: "Simulação Completa" (FH) / "Empréstimo com garantia de imóvel" (HE). Etapa 1 = CPF, nascimento, celular (= número da API),
 * renda bruta (soma de quem participa), 3 anos de FGTS, mais de um comprador e o aceite (Fabio: "pode marcar"). Ao avançar a CAIXA manda um código pelo WhatsApp
 * pro número da API → chega na Inbox → `codigoSimulacao` acha → a extensão digita. Etapas 2–4 em mapeamento: a extensão manda o que viu (`MAPEAR`) e para.
 */

type Io = { to: (room: string) => { emit: (event: string, payload: unknown) => void } } | null | undefined;

/** Número da API Oficial (WhatsApp do CRM) — o código da CAIXA chega aqui. */
export const NUMERO_API_SIMULADOR = process.env.CAIXA_SIMULADOR_TELEFONE || '61981721313';
const LEASE_MS = 15 * 60_000;

const num = (v: unknown) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let t = String(v ?? '').replace(/[^\d.,-]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  return Number(t) || 0;
};
const brl = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBr = (v: unknown) => { const s = String(v || '').trim(); const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/); return iso ? `${iso[3]}/${iso[2]}/${iso[1]}` : /^\d{2}\/\d{2}\/\d{4}$/.test(s) ? s : ''; };

async function gravar(leadId: string, patch: Record<string, any>): Promise<void> {
  const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
  await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, _caixaSimulacao: { ...(fresh._caixaSimulacao || {}), ...patch, atualizadoEm: new Date().toISOString() } } } });
}
async function nota(leadId: string, content: string, userId?: string | null) {
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content, ...(userId ? { userId } : {}) } }).catch(() => {});
}

/** Pede a simulação oficial (botão/teste agora; depois, sozinho quando a CAIXA aprovar). */
export async function pedirSimulacaoCaixa(accountId: string, leadId: string, por: { id?: string; nome: string }, opts: { docRequestId?: string } = {}): Promise<{ erro: string } | { mensagem: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true } });
  if (!lead) return { erro: 'Card não encontrado' };
  const st = ((lead.customFields || {}) as any)._caixaSimulacao?.status;
  // Pedido do PDF pro cliente (botão "PDF" da CAIXA): quando a simulação terminar, o PDF vai por ele.
  if (opts.docRequestId) await gravar(leadId, { docRequestId: opts.docRequestId });
  if (['FILA', 'RODANDO'].includes(st)) return { erro: 'A simulação da CAIXA deste cliente já está em andamento.' };
  // Sem o WhatsApp do código conectado (QR), o código da CAIXA se perde — não roda (Fabio 12/11).
  if (!(require('./caixa-codigo-qr.service') as typeof import('./caixa-codigo-qr.service')).numeroQr(accountId)) return { erro: 'O WhatsApp do código da CAIXA (QR) está desconectado — escaneie em /caixa-codigo e peça de novo.' };
  const d = dadosDoCard((lead.customFields || {}) as Record<string, any>);
  if (d.cpf.length !== 11) return { erro: 'Sem o CPF do tomador (ficha de cadastro ou card).' };
  if (!d.nascimento) return { erro: 'Sem a data de nascimento do tomador.' };
  if (!d.renda) return { erro: 'Sem a renda (card ou ficha de cadastro).' };
  await gravar(leadId, { status: 'FILA', pedidoEm: new Date().toISOString(), por: por.nome, leaseAt: null, erro: null });
  await nota(leadId, `🧮 Simulação no simulador da CAIXA pedida por ${por.nome} — a extensão SIOPI (A&F) roda com o número da API pro código de verificação.`, por.id || null);
  return { mensagem: 'Pedido na fila: a extensão roda a simulação da CAIXA no próximo minuto.' };
}

/** Dados do card/ficha que o simulador pede. Tomador = 1º participante. */
function dadosDoCard(cf: Record<string, any>) {
  const ps: any[] = Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : [];
  const p1 = ps.find((x, i) => (Number(x?.ordem) || i + 1) === 1) || {};
  const cpf = String(p1.cpf || cf.cpf_1 || '').replace(/\D/g, '');
  const nascimento = dataBr(p1.nascimento) || dataBr(cf.nascimento_1);
  const rendaFicha = ps.reduce((s, x) => s + num(x?.rendaBrutaMensal), 0);
  const renda = rendaFicha || num(cf.renda_1) + num(cf.renda_2);
  const maisDeUm = ps.length > 1 || !!String(cf.participante_2 || '').trim();
  const fgts = /sim|s\b|true/i.test(String(cf.fgts_3_anos ?? cf.usa_fgts ?? cf.fgts ?? ''));
  return { cpf, nascimento, renda, maisDeUm, fgts };
}

/** Etapa 2 do simulador ("Dados do imóvel"). Cidade/UF do imóvel → senão a do endereço do tomador (ficha) → senão Brasília/DF (12/11, Windson: o card não tinha a cidade). */
function imovelDoCard(cf: Record<string, any>, he: boolean) {
  const ps: any[] = Array.isArray(cf._fichaCadastral?.participantes) ? cf._fichaCadastral.participantes : [];
  const end = (ps.find((x, i) => (Number(x?.ordem) || i + 1) === 1) || {}).endereco || {};
  const ufImovel = String(cf.uf_imovel || cf.imovel_uf || '').trim().toUpperCase();
  const cidadeImovel = String(cf.cidade_imovel || cf.imovel_cidade || '').trim();
  const [uf, cidade0] = ufImovel && cidadeImovel ? [ufImovel, cidadeImovel] : end.uf && end.cidade ? [String(end.uf).toUpperCase(), String(end.cidade)] : ['DF', 'BRASILIA'];
  // DF: Taguatinga, Ceilândia etc. são regiões administrativas — o município é Brasília (Windson: imóvel na CSG 3, Taguatinga).
  const cidade = uf === 'DF' ? 'BRASILIA' : cidade0;
  const tipo = `${cf.imovel_tipo || ''} ${cf.tipo_imovel || ''} ${cf.condicao_imovel || ''} ${cf.finalidade || ''}`; // finalidade "Construção" (Isidro, 12/11)
  const deseja = he ? 'emprestimo' : /terreno|lote/i.test(tipo) ? 'terreno' : /constru/i.test(tipo) ? 'construir' : /novo|planta|lan[çc]amento/i.test(tipo) ? 'novo' : 'usado';
  const sim = (v: unknown) => /^(s|sim|true|1)/i.test(String(v ?? '').trim());
  return {
    tipoImovel: /comercial|sala|loja/i.test(tipo) ? 'comercial' : 'residencial',
    deseja,
    valorImovel: brl(num(cf.valor_imovel)),
    uf, cidade,
    subsidio: sim(cf.subsidio || cf.recebeu_subsidio),
    outroImovelCidade: sim(cf.outro_imovel_cidade || cf.possui_imovel_cidade),
    origemCidade: ufImovel && cidadeImovel ? 'card' : end.uf && end.cidade ? 'endereço do tomador' : 'padrão DF',
  };
}

/** Como a CAIXA aprovou (detalhe da avaliação em `_caixaResultado.ultimaTela`, quando a extensão leu): modalidade (SBPE/MCMV), SAC/PRICE e prazo; e a entrada que
 *  dá o financiamento do card (imóvel − crédito). Sem o detalhe: SAC no prazo máximo (Fabio 12/11: "o padrão vai ser SAC para todas na CAIXA"). */
function condicoesDaAprovacao(cf: Record<string, any>) {
  const tela = String(cf._caixaResultado?.ultimaTela || '');
  // Aprovada na PRICE depois da condicionada (Isidro, 12/11): simula como a CAIXA liberou — PRICE, o valor que a parcela possível paga e o prazo da refeita.
  const lib = cf._caixaResultado?.condicionada?.tipo === 'liberado' ? cf._caixaResultado.condicionada : null;
  const amortAv = String(cf._caixaCadastro?.avaliacao?.amortizacao || '').toUpperCase();
  const sistema = lib ? 'PRICE' : amortAv === 'PRICE' || (/\bPRICE\b/i.test(tela) && !/\bSAC\b/i.test(tela)) ? 'PRICE' : 'SAC'; // SAC é o padrão da CAIXA (Fabio 12/11)
  const modalidade = /SBPE/i.test(tela) ? 'sbpe' : /MCMV|minha casa/i.test(tela) ? 'mcmv' : '';
  const imovel = num(cf.valor_imovel);
  const credito = lib && Number(lib.valor) > 0 ? Math.min(Number(lib.valor), num(cf.valor_credito) || Infinity) : num(cf.valor_credito);
  return {
    sistema, modalidade, indexador: 'TR',
    entradaDesejada: imovel && credito && imovel > credito ? brl(imovel - credito) : '',
    // Prazo pedido: o da aprovada na PRICE (360) ou o que o cliente pediu (`_caixaSimulacao.prazoPedido` — Fabio 12/11: "se o cliente quiser alterar o prazo… só faz uma nova simulação").
    prazoMeses: Number(cf._caixaSimulacao?.prazoPedido) || (lib ? Number(lib.prazo) || null : null),
  };
}

/** Fila da extensão. */
export async function proximaSimulacaoCaixa(accountId: string): Promise<any | null> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Lead" WHERE "accountId" = ${accountId} AND "customFields"->'_caixaSimulacao'->>'status' IN ('FILA','RODANDO')
     ORDER BY "updatedAt" ASC LIMIT 5`;
  for (const { id } of rows) {
    const lead = await prisma.lead.findUnique({ where: { id }, select: { name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
    const cf = (lead?.customFields || {}) as Record<string, any>;
    const s = cf._caixaSimulacao || {};
    if (s.status === 'RODANDO' && !(s.leaseAt && Date.now() - Date.parse(s.leaseAt) > LEASE_MS)) continue;
    if (!(require('./caixa-codigo-qr.service') as typeof import('./caixa-codigo-qr.service')).numeroQr(accountId)) return null; // espera o QR voltar
    const he = /home|garantia/i.test(lead?.pipeline?.department?.name || '');
    const d = dadosDoCard(cf);
    await gravar(id, { status: 'RODANDO', leaseAt: new Date().toISOString(), inicio: new Date().toISOString() });
    return {
      leadId: id,
      leadName: lead?.name || '',
      produto: he ? 'HE' : 'FH',
      // Número conectado por QR (recebe o código — a API Oficial não lê a mensagem da CAIXA, erro 131051); sem QR, o da API (o código se perde).
      celular: (require('./caixa-codigo-qr.service') as typeof import('./caixa-codigo-qr.service')).numeroQr(accountId)!,
      dados: {
        cpf: d.cpf, nascimento: d.nascimento, renda: brl(d.renda), maisDeUm: d.maisDeUm, fgts3anos: d.fgts,
        valorFinanciamento: brl(num(cf.valor_credito)),
        // Prazo: o da aprovação liberada na PRICE (360) ou o que o cliente pediu; sem pedido = máximo (vem DEPOIS — antes um campo vazio do card apagava o 360, 12/11).
        ...condicoesDaAprovacao(cf),
        ...imovelDoCard(cf, he),
      },
    };
  }
  return null;
}

/** Código de verificação que a CAIXA mandou pro WhatsApp da API depois de `desde` (a extensão pergunta a cada poucos segundos). */
export async function codigoSimulacao(accountId: string, desde: Date): Promise<{ codigo: string; em: string } | null> {
  const doQr = (require('./caixa-codigo-qr.service') as typeof import('./caixa-codigo-qr.service')).codigoQr(accountId, desde);
  if (doQr) return doQr;
  const msgs = await prisma.message.findMany({
    where: { direction: 'INBOUND', createdAt: { gte: new Date(desde.getTime() - 30_000) }, lead: { accountId } },
    orderBy: { createdAt: 'desc' }, take: 30, select: { content: true, createdAt: true },
  });
  for (const m of msgs) {
    const t = String(m.content || '');
    if (!/c[óo]digo|verifica|caixa|simula/i.test(t)) continue;
    const c = (t.match(/\b(\d{4,8})\b/) || [])[1];
    if (c) return { codigo: c, em: m.createdAt.toISOString() };
  }
  return null;
}

/** Resultado/andamento da extensão → card. MAPEAR = tela que a extensão ainda não sabe preencher (vai o retrato dela pra eu mapear). */
export async function gravarSimulacaoCaixa(accountId: string, leadId: string, body: { etapa: string; texto?: string; campos?: any[]; erro?: string; tela?: string; resultado?: ResultadoCaixa }, _io?: Io): Promise<void> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true } });
  if (!lead) throw new Error('Card não encontrado');
  const etapa = String(body.etapa || '').toUpperCase();
  const campos = (body.campos || []).map((c: any) => `• ${c.rotulo || c.label || '?'}${c.tipo ? ` [${c.tipo}]` : ''}${c.opcoes?.length ? ` — opções: ${c.opcoes.join(' | ')}` : ''}${c.valor ? ` = ${c.valor}` : ''}`).join('\n');
  if (etapa === 'CODIGO_ENVIADO') { await gravar(leadId, { codigoPedidoEm: new Date().toISOString() }); return; }
  if (etapa === 'MAPEAR' || etapa === 'MAPA') {
    // MAPA = retrato intermediário (a rodada segue); MAPEAR = parou aqui. Cada tela fica em `mapas[tela]` (até 8 telas, 9.000 caracteres cada) pra eu mapear várias de uma vez.
    const fresh = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
    const mapas = { ...((fresh._caixaSimulacao || {}).mapas || {}) } as Record<string, any>;
    mapas[String(body.tela || '—').slice(0, 120)] = { texto: (body.texto || '').slice(0, 9000), campos: (body.campos || []).slice(0, 80), em: new Date().toISOString() };
    const chaves = Object.keys(mapas).sort((a, b) => String(mapas[b].em).localeCompare(String(mapas[a].em))).slice(0, 8);
    const mapasLimpos = Object.fromEntries(chaves.map((k) => [k, mapas[k]]));
    if (etapa === 'MAPA') { await gravar(leadId, { mapas: mapasLimpos }); return; }
    await gravar(leadId, { status: 'MAPEAR', leaseAt: null, tela: body.tela || null, mapas: mapasLimpos, retrato: { texto: (body.texto || '').slice(0, 4000), campos: body.campos || [] } });
    await nota(leadId, `🧮 Simulação CAIXA parou numa tela que a extensão ainda não conhece (${body.tela || '—'}):\n${(body.texto || '').slice(0, 1500)}${campos ? `\n\nCampos:\n${campos}` : ''}`);
    return;
  }
  if (etapa === 'PRONTA' && body.resultado) { await prontaComPdf(accountId, leadId, lead.name, body.resultado); return; }
  const status = etapa === 'PRONTA' ? 'PRONTA' : 'ERRO';
  await gravar(leadId, { status, leaseAt: null, erro: body.erro || null, resultado: etapa === 'PRONTA' ? { texto: (body.texto || '').slice(0, 4000), campos: body.campos || [] } : undefined });
  await nota(leadId, etapa === 'PRONTA' ? `🧮 Simulação da CAIXA pronta:\n${(body.texto || '').slice(0, 2000)}` : `⚠️ Simulação da CAIXA parou: ${String(body.erro || etapa).slice(0, 400)}${body.texto ? `\n${body.texto.slice(0, 600)}` : ''}`);
  if (etapa !== 'PRONTA') await sendPushToAccount(accountId, { title: `🧮 ${lead.name}: simulação CAIXA parou`, body: String(body.erro || etapa).slice(0, 120), leadId }).catch(() => {});
  if (etapa === 'ERRO') {
    const docId = (((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as any)._caixaSimulacao?.docRequestId;
    if (docId) {
      await gravar(leadId, { docRequestId: null });
      await (require('./simulation-doc.service') as typeof import('./simulation-doc.service')).failSimulationDoc(prisma as any, { accountId, id: docId, reason: `Simulação da CAIXA parou: ${String(body.erro || '').slice(0, 200)}` }).catch(() => {});
    }
  }
}

/** Resultado do simulador da CAIXA (etapa 4 + "Ver parcelas"): linhas = [nº, vencimento, prestação, MIP, DFI/DFC, seguros, taxa adm., encargo, saldo devedor]. */
export interface ResultadoCaixa {
  modalidade?: string; valorImovel?: string; entrada?: string; financiamento?: string; prazo?: string; sistema?: string;
  jurosEfetivos?: string; jurosNominais?: string; seguradora?: string; bonificada?: boolean; primeira?: string; ultima?: string;
  linhas?: string[][];
}

/** Monta o NOSSO PDF ("Evolução das parcelas", padrão das outras simulações, banco CAIXA) com os números do simulador e salva na pasta do cliente (raiz).
 *  Fabio 12/11: "coleta os dados da CAIXA e joga na nossa simulação" + "coloca a simulação na pasta do cliente". Nada vai ao cliente aqui. */
async function prontaComPdf(accountId: string, leadId: string, nome: string, r: ResultadoCaixa): Promise<void> {
  // "8.16% a.a." / "8,16%": só o 1º número (os pontos de "a.a." quebravam a conta e o PDF saía sem taxa e com 10 parcelas — 12/11).
  const pct = (v?: string) => Number(((/(\d+(?:[.,]\d+)?)/.exec(String(v || '')) || [])[1] || '').replace(',', '.')) || null;
  const linhas = (r.linhas || []).filter((l) => Array.isArray(l) && l.length >= 9);
  const fin = num(r.financiamento);
  const rows = linhas.map((l, i) => {
    const saldo = num(l[8]);
    const anterior = i === 0 ? fin : num(linhas[i - 1][8]);
    const prest = num(l[2]);
    const amort = Math.max(0, Math.round((anterior - saldo) * 100) / 100);
    return { n: Number(l[0]) || i + 1, amort, juros: Math.max(0, Math.round((prest - amort) * 100) / 100), mip: num(l[3]), dfi: num(l[4]), tsa: num(l[6]), parcela: num(l[7]), saldo };
  });
  const sistema = /price/i.test(r.sistema || '') ? 'PRICE' : 'SAC';
  const indexador = (/\/\s*([A-Z]{2,5})\b/.exec(r.sistema || '') || [])[1] || 'TR';
  const he = /garantia|empr[eé]stimo/i.test(r.modalidade || '');
  // A tabela "Todas as Parcelas" do simulador é paginada (10 por página): com a 1ª página o resto sai da conta, igual à da CAIXA — taxa mensal = nominal/12,
  // PRICE (parcela fixa) ou SAC (amortização fixa), MIP = % do saldo anterior (tirado da 1ª linha), DFI e taxa de administração fixos (12/11: conferido no PDF
  // oficial do Windson de 06/11 — R$ 200 mil, 0,68% a.m., 420 meses → R$ 1.443,82).
  const total = Number(String(r.prazo || '').replace(/\D/g, '')) || 0;
  const i = (pct(r.jurosNominais) || 0) / 100 / 12;
  if (rows.length && total > rows.length && i > 0) {
    const r1 = rows[0];
    const mipTaxa = fin ? r1.mip / fin : 0;
    const dfi = rows[rows.length - 1].dfi, tsa = rows[rows.length - 1].tsa;
    const pmt = sistema === 'PRICE' ? (fin * i) / (1 - Math.pow(1 + i, -total)) : 0;
    const amortSac = fin / total;
    const c2 = (v: number) => Math.round(v * 100) / 100;
    let saldo = rows[rows.length - 1].saldo;
    for (let n = rows.length + 1; n <= total; n++) {
      const juros = c2(saldo * i);
      const amort = n === total ? c2(saldo) : c2(sistema === 'PRICE' ? pmt - juros : amortSac);
      const mip = c2(saldo * mipTaxa);
      saldo = c2(Math.max(0, saldo - amort));
      rows.push({ n, amort, juros, mip, dfi, tsa, parcela: c2(amort + juros + mip + dfi + tsa), saldo });
    }
  }
  const { renderSimulationSheet, taxasDe } = await import('./simulation-sheet.service');
  const taxas = taxasDe({ nominalAA: pct(r.jurosNominais), efetivaAA: pct(r.jurosEfetivos), indexador });
  const bonif = r.bonificada ? ' (bonificada)' : '';
  let link: string | null = null, driveId: string | null = null, erroPdf = '';
  let pdfPronto: Buffer | null = null;
  try {
    if (!rows.length) throw new Error('a tabela de parcelas veio vazia');
    if (!fin || !pct(r.jurosNominais)) throw new Error('faltou o valor financiado ou a taxa (o painel de condições não foi lido) — não montei o PDF');
    const pdf = await renderSimulationSheet({
      clientName: nome, bank: 'CAIXA', titulo: he ? 'Home Equity | Evolução das parcelas' : 'Financiamento Imobiliário | Evolução das parcelas',
      summary: {
        tipoImovel: 'Residencial', prazoMeses: rows.length, sistema, valorImovel: num(r.valorImovel), valorEmprestimo: fin, ...(he ? {} : { indexador, valorEntrada: num(r.entrada) }),
        taxaMensal: taxas.taxaMensal, taxaNominal: `${taxas.taxaNominal}${bonif}`, taxaEfetiva: `${taxas.taxaEfetiva}${bonif}`,
      },
      rows,
    });
    pdfPronto = pdf;
    const cf = ((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as Record<string, any>;
    const pasta = String(cf.link_pasta_drive || '').trim();
    if (!pasta) throw new Error('o card não tem "Pasta no Drive"');
    const google = await import('./google.service');
    const arquivo = `SIMULACAO CAIXA ${he ? 'HE' : String(r.modalidade || '').match(/minha casa/i) ? 'MCMV' : 'SBPE'} ${sistema} - ${nome}.pdf`.replace(/[\\/]/g, '-');
    const up = await google.uploadFile(accountId, { name: arquivo, mimeType: 'application/pdf', parentId: google.extractFolderId(pasta), data: pdf });
    link = up.webViewLink; driveId = up.id;
    // Uma simulação só na pasta (Fabio 12/11): a anterior (outro prazo, outra tabela, outro banco) vai pra DESNECESSARIO — antes a da CAIXA ia pra lixeira.
    const sp = await import('./simulacao-pasta.service');
    await sp.manterUmaSimulacao(accountId, leadId, { nova: up.id }).catch((e: any) => console.error('[Simulação CAIXA] uma simulação na pasta:', e?.message));
  } catch (e: any) { erroPdf = e?.message || String(e); }
  const { linhas: _l, ...resumo } = r;
  const docId = (((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as any)._caixaSimulacao?.docRequestId || null;
  await gravar(leadId, { status: erroPdf ? 'ERRO' : 'PRONTA', leaseAt: null, erro: erroPdf || null, resultado: { ...resumo, parcelas: rows.length }, pdf: driveId ? { driveId, link, em: new Date().toISOString() } : undefined, docRequestId: null });
  // Pedido do botão "PDF" (cliente): manda o mesmo PDF pelo caminho dos outros bancos.
  if (docId) {
    const sd = require('./simulation-doc.service') as typeof import('./simulation-doc.service');
    // Aviso da aprovação (Fabio 12/11: "sempre que aprovar o crédito, encaminha a simulação na SAC"): a legenda do PDF é a mensagem de aprovação padrão com os números da CAIXA.
    const cfA = (((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as any);
    const avisoProposta = cfA._caixaSimulacao?.avisoAprovacao;
    if (avisoProposta && pdfPronto && !erroPdf && rows.length) {
      const { renderApprovalText } = require('./approval-notice.service') as typeof import('./approval-notice.service');
      const taxaNom = pct(r.jurosNominais);
      const legenda = `${renderApprovalText([{ instituicao: 'CAIXA', valor: `R$ ${brl(fin)}`, liquido: he, prazo: `${rows.length} meses`, taxa: taxaNom ? `${taxaNom.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% a.a. + ${indexador}` : '—', primeiraParcela: `R$ ${brl(rows[0].parcela)}` } as any])}\n\nSegue a simulação da CAIXA em PDF 📄`;
      await prisma.simulationDocRequest.update({ where: { id: docId }, data: { caption: legenda.slice(0, 1000) } }).catch(() => {});
    }
    if (pdfPronto && !erroPdf) {
      const ent = await sd.finishCaixaDoc(prisma as any, { accountId, id: docId, pdf: pdfPronto }).catch((e: any) => { console.error('[Simulação CAIXA] PDF ao cliente:', e?.message); return null; });
      if (avisoProposta) {
        const ok = !!(ent && (ent as any).ok);
        const fresh = (((await prisma.lead.findUnique({ where: { id: leadId }, select: { customFields: true } }))?.customFields || {}) as any);
        const res = { ...(fresh._caixaResultado || {}), aprovadaAviso: { ...((fresh._caixaResultado || {}).aprovadaAviso || {}), status: ok ? 'ENVIADO' : 'FALHOU', enviadoAt: ok ? new Date().toISOString() : undefined } };
        await prisma.lead.update({ where: { id: leadId }, data: { customFields: { ...fresh, _caixaResultado: res, _caixaSimulacao: { ...(fresh._caixaSimulacao || {}), avisoAprovacao: null } } } });
      }
    }
    else await sd.failSimulationDoc(prisma as any, { accountId, id: docId, reason: erroPdf || 'a simulação da CAIXA não gerou o PDF' }).catch(() => {});
  }
  const linhasNota = [
    `🧮 Simulação da CAIXA${erroPdf ? ' feita, mas o PDF NÃO saiu' : ' pronta'} — ${r.modalidade || '—'}${bonif}`,
    `Imóvel ${r.valorImovel || '—'} • entrada ${r.entrada || '—'} • financiamento ${r.financiamento || '—'}`,
    `${rows.length || r.prazo || '—'} meses • ${r.sistema || sistema} • juros ${r.jurosNominais || '—'} nominais / ${r.jurosEfetivos || '—'} efetivos`,
    `Seguradora ${r.seguradora || '—'}: 1ª parcela ${r.primeira || (rows[0] ? `R$ ${brl(rows[0].parcela)}` : '—')} • última ${r.ultima || (rows.length ? `R$ ${brl(rows[rows.length - 1].parcela)}` : '—')}`,
    erroPdf ? `⚠️ PDF: ${erroPdf}` : `📄 PDF na pasta do cliente: ${link || '—'}`,
  ];
  await nota(leadId, linhasNota.join('\n'));
  if (erroPdf) await sendPushToAccount(accountId, { title: `🧮 ${nome}: simulação CAIXA sem PDF`, body: erroPdf.slice(0, 120), leadId }).catch(() => {});
}
