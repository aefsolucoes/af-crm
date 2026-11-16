import { prisma } from '../lib/prisma';

/**
 * ESTIMATIVA DE CUSTAS DO FINANCIAMENTO HABITACIONAL (Fabio 16/11: "tem como calcular as taxas de FH para determinada região? Escritura, registro e ITBI?" +
 * "um botão ao lado da msg para calcular essas taxas com uma msg e os valores" + "pode puxar pela certidão de ônus do imóvel a cidade").
 *
 * - Cidade/UF: 1º a certidão de ônus/matrícula lida (endereço ou cartório), depois o card (cidade_imovel, endereço "Cidade/UF", proposta), por fim o CEP (só a UF).
 * - Alíquota do ITBI da prefeitura (com a redução da parte financiada pelo SFH, onde existir) e a tabela de emolumentos do Registro de Imóveis do estado: pesquisa na web
 *   (fontes oficiais), no servidor. O ITBI é calculado aqui (a conta não fica com o modelo); o registro vem da tabela.
 * - Escritura: Fabio 16/11 ("não colocar isso para o cliente, pode calcular os custos da escritura também") — calcula a escritura pública de compra e venda no tabelionato de notas
 *   pela tabela do estado (antes a mensagem dizia que o contrato do banco tem força de escritura e não tinha custo).
 * - Banco CAIXA ou BRB (Fabio 16/11): a mensagem avisa do pacote comercial e do seguro da taxa bonificada, apresentados no final do processo.
 * - Devolve a mensagem pronta pro cliente (a equipe revisa no campo antes de enviar) e grava uma nota com as fontes. Cache por cidade + valores (7 dias).
 */

type Cf = Record<string, any>;
export type CustasFh = {
  cidade: string; uf: string; valorImovel: number; financiado: number;
  itbi: { valor: number; aliquotaGeral: number; aliquotaFinanciado: number | null; regra: string; fonte: string };
  registro: { total: number; compraVenda: number | null; alienacao: number | null; obs: string; fonte: string };
  escritura: { valor: number; obs: string; fonte: string } | null;
  total: number; confianca: string; origemCidade: string; imovelNovo?: boolean; primeiraAquisicao?: boolean; banco?: string;
};

const cache = new Map<string, { em: number; v: Omit<CustasFh, 'origemCidade' | 'imovelNovo' | 'primeiraAquisicao' | 'banco'> }>();
const CACHE_MS = 7 * 86_400_000;

const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const t = String(v ?? '').replace(/[^\d.,]/g, '');
  if (!t) return 0;
  const n = t.includes(',') ? Number(t.replace(/\./g, '').replace(',', '.')) : (/\.\d{3}$/.test(t) && !/\.\d{1,2}$/.test(t) ? Number(t.replace(/\./g, '')) : Number(t));
  return Number.isFinite(n) ? n : 0;
};
const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const pct = (n: number) => `${n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

/** UF pela faixa do CEP (Correios). Pura. */
export function ufDoCep(cep: unknown): string | null {
  const c = Number(String(cep ?? '').replace(/\D/g, '').slice(0, 5));
  if (!c || String(cep ?? '').replace(/\D/g, '').length < 5) return null;
  const F: [number, number, string][] = [
    [1000, 19999, 'SP'], [20000, 28999, 'RJ'], [29000, 29999, 'ES'], [30000, 39999, 'MG'], [40000, 48999, 'BA'], [49000, 49999, 'SE'], [50000, 56999, 'PE'],
    [57000, 57999, 'AL'], [58000, 58999, 'PB'], [59000, 59999, 'RN'], [60000, 63999, 'CE'], [64000, 64999, 'PI'], [65000, 65999, 'MA'], [66000, 68899, 'PA'],
    [68900, 68999, 'AP'], [69000, 69299, 'AM'], [69300, 69399, 'RR'], [69400, 69899, 'AM'], [69900, 69999, 'AC'], [70000, 72799, 'DF'], [72800, 72999, 'GO'],
    [73000, 73699, 'DF'], [73700, 76799, 'GO'], [76800, 76999, 'RO'], [77000, 77999, 'TO'], [78000, 78899, 'MT'], [79000, 79999, 'MS'], [80000, 87999, 'PR'],
    [88000, 89999, 'SC'], [90000, 99999, 'RS'],
  ];
  return F.find(([a, b]) => c >= a && c <= b)?.[2] || null;
}

/** Cidade/UF do imóvel: certidão de ônus → card → proposta → CEP. */
async function cidadeDoImovel(leadId: string, cf: Cf): Promise<{ cidade: string; uf: string; origem: string } | null> {
  const { cidadeUfDe } = require('./certidao-offer.service') as typeof import('./certidao-offer.service');
  const revs = Object.values((cf._docReview || {}) as Record<string, any>).filter((r) => r && r.resultado !== 'NAO_DOCUMENTO' && /MATRICULA|ONUS|ÔNUS/i.test(String(r.tipo || '')));
  for (const r of revs) {
    const cu = cidadeUfDe(String(r.endereco || '')) || cidadeUfDe(String(r.cartorio || ''));
    if (cu) return { ...cu, origem: 'certidão de ônus' };
  }
  const end = cidadeUfDe(String(cf.endereco_imovel || ''));
  if (end) return { ...end, origem: 'endereço do imóvel no card' };
  const prop = await prisma.message.findFirst({ where: { leadId, direction: 'INBOUND', content: { contains: 'Imóvel em garantia' } }, orderBy: { createdAt: 'desc' }, select: { content: true } });
  const pg = /Im[oó]vel em garantia:\s*([^\n]+)/i.exec(prop?.content || '');
  const cuP = pg ? cidadeUfDe(pg[1]) : null;
  if (cuP) return { ...cuP, origem: 'proposta' };
  const cidade = String(cf.cidade_imovel || '').trim();
  const uf = String(cf.uf_imovel || cf.uf || '').trim().toUpperCase() || ufDoCep(cf.imovel_cep) || '';
  if (cidade && /^[A-Z]{2}$/.test(uf)) return { cidade, uf, origem: 'cidade do imóvel no card' };
  return null;
}

export async function pesquisar(cidade: string, uf: string, valorImovel: number, financiado: number, flags: { imovelNovo?: boolean; primeiraAquisicao?: boolean } = {}): Promise<any | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 150_000);
  try {
    const sistema = 'Você estima as custas de quem compra um imóvel residencial com FINANCIAMENTO BANCÁRIO no Brasil (SFH/SFI). Pesquise em fontes OFICIAIS e atuais: lei/decreto/site da prefeitura (ITBI: alíquota geral, alíquota reduzida para a parte financiada pelo SFH quando a lei municipal prevê, base de cálculo) e a tabela de emolumentos do Registro de Imóveis do estado vigente (Tribunal de Justiça/Corregedoria, ANOREG, Colégio Registral). Calcule o registro do contrato: registro da compra e venda (pelo valor do imóvel) + registro da alienação fiduciária/hipoteca (pelo valor financiado), com as taxas/fundos/ISS que a tabela do estado já soma ao emolumento; se o estado der desconto do SFH no registro, aplique e diga. Desconto de 50% da 1ª aquisição residencial pelo SFH (Lei 6.015/73, art. 290): aplique SÓ se o pedido disser que é a 1ª aquisição (vale pro registro e pra escritura). Calcule também a ESCRITURA PÚBLICA de compra e venda no Tabelionato de Notas pelo valor do imóvel, pela tabela de emolumentos do tabelionato de notas do estado vigente (com as taxas/fundos/ISS que a tabela soma). NÃO inclua certidões nem a avaliação do banco. Responda SÓ um JSON, sem texto fora dele: {"cidade":"","uf":"","itbi":{"aliquotaGeral":<número em %>,"aliquotaFinanciado":<número em % ou null>,"base":"texto curto da base de cálculo","regra":"texto curto da regra (ex.: 3% sobre o valor; 0,5% sobre a parte financiada pelo SFH até X)","fonte":"url oficial"},"registro":{"compraVenda":<R$>,"alienacao":<R$>,"total":<R$>,"obs":"texto curto","fonte":"url oficial"},"escritura":{"valor":<R$>,"obs":"texto curto","fonte":"url oficial"},"confianca":"alta|media|baixa"}';
    const messages: any[] = [{ role: 'user', content: `Imóvel em ${cidade}/${uf}. Valor do imóvel (compra): ${brl(valorImovel)}. Valor financiado pelo banco: ${brl(financiado)}. ${flags.imovelNovo ? 'Imóvel NOVO (1ª transmissão, comprado da construtora).' : 'Imóvel usado.'} ${flags.primeiraAquisicao ? 'É a 1ª aquisição residencial do comprador financiada pelo SFH (aplique o desconto de 50% do registro).' : 'Não é (ou não se sabe se é) a 1ª aquisição pelo SFH: calcule o registro SEM o desconto.'} Estime o ITBI, o registro do contrato no Registro de Imóveis e a escritura pública no Tabelionato de Notas.` }];
    let texto = '';
    let ultimo: any = null;
    const chama = async (maxTokens: number) => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: maxTokens, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }], system: sistema, messages }),
      });
      if (!res.ok) { console.warn('[Custas FH] API', res.status, (await res.text().catch(() => '')).slice(0, 300)); return null; }
      return res.json();
    };
    // O raciocínio do sonnet-5 conta no max_tokens (memória sonnet5-max-tokens-thinking): limite alto e, se acabar sem o JSON, mais uma volta pedindo só o JSON.
    for (let volta = 0; volta < 5; volta++) {
      const j: any = await chama(16000);
      if (!j) return null;
      ultimo = j;
      texto += (j.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      if (j.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: j.content });
    }
    const temJson = () => { const i = texto.indexOf('{'); const f = texto.lastIndexOf('}'); return i >= 0 && f > i; };
    if (!temJson() && ultimo?.content?.length) {
      messages.push({ role: 'assistant', content: ultimo.content });
      messages.push({ role: 'user', content: 'Responda agora SÓ o JSON pedido, com o que você já achou (sem pesquisar mais).' });
      const j: any = await chama(6000);
      if (j) texto += (j.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
    }
    const ini = texto.indexOf('{'); const fim = texto.lastIndexOf('}');
    if (ini < 0 || fim <= ini) { console.warn('[Custas FH] sem JSON:', ultimo?.stop_reason, JSON.stringify(ultimo?.usage || {}), texto.replace(/\s+/g, ' ').slice(-300)); return null; }
    return JSON.parse(texto.slice(ini, fim + 1));
  } catch (e: any) { console.warn('[Custas FH]', e?.name === 'AbortError' ? 'demorou demais' : e?.message); return null; }
  finally { clearTimeout(timer); }
}

/** Mensagem pro cliente no formato do modelo "Taxas Financiamento Habitacional" (pura). */
export function montarMensagemCustas(c: CustasFh, nome?: string | null): string {
  // Formato do modelo "Taxas Financiamento Habitacional" das respostas rápidas (Fabio 16/11: "temos uma msg de taxas, se quiser pode usar aquele modelo"), com os valores calculados.
  const itbiRegra = c.itbi.aliquotaFinanciado !== null
    ? `${pct(c.itbi.aliquotaGeral)} sobre a parte paga com recursos próprios e ${pct(c.itbi.aliquotaFinanciado)} sobre a parte financiada, pela lei do município`
    : `${pct(c.itbi.aliquotaGeral)} sobre o valor do imóvel, pela lei do município`;
  const totalTxt = c.escritura ? 'escritura, ITBI e registro' : 'ITBI e registro';
  return `${nome ? `${nome}, n` : 'N'}o processo de financiamento, além da entrada e das parcelas, existem algumas taxas obrigatórias que precisam ser pagas. Fiz uma estimativa pro imóvel em ${c.cidade}/${c.uf}:\n\n`
    + (c.escritura ? `Escritura pública ou contrato particular: cerca de ${brl(c.escritura.valor)}\n\n` : '')
    + `ITBI – Imposto de Transmissão de Bens Imóveis: ${brl(c.itbi.valor)} (${itbiRegra})\n\n`
    + `Registro do imóvel: cerca de ${brl(c.registro.total)} (no cartório de registro de imóveis)\n\n`
    + `Vistoria do imóvel: até R$ 3.500,00 (de acordo com a empresa avaliadora e a localização)\n\n`
    + `Total estimado (${totalTxt}): ${brl(c.total)}\n\n`
    + (c.primeiraAquisicao ? `O registro já está com o desconto de 50% da 1ª aquisição pelo SFH.\n\n` : `Se for a sua 1ª aquisição de imóvel residencial pelo SFH, o registro tem 50% de desconto.\n\n`)
    + (ehCaixaOuBrb(c.banco || '') ? `⚠️ Observação: pela ${/caixa/i.test(c.banco || '') ? 'CAIXA' : 'BRB'}, para ter acesso à taxa bonificada há um pacote comercial e um seguro, que são apresentados no final do processo.\n\n` : '')
    + `São valores estimados: o valor exato é confirmado pela prefeitura (ITBI) e pelos cartórios (escritura e registro).`;
}

export type DadosCustas = { cidade: string; uf: string; origemCidade: string; valorImovel: number; financiado: number; imovelNovo: boolean; primeiraAquisicao: boolean; banco: string };

/** Banco por onde o FH segue: "Seguir com esta"/equipe (`_fhChosen`), opção CAIXA/BRB (`_optouCaixa`) ou a instituição do card. */
const bancoDoCard = (cf: Cf): string => String(cf._fhChosen?.bank || cf._optouCaixa?.banco || cf.instituicao || '').trim();
const ehCaixaOuBrb = (b: string) => /caixa|\bbrb\b|banco de bras[ií]lia/i.test(b);

/** Valores do card pra janela de confirmação (Fabio 16/11: "abra um push com os valores de confirmação para o cálculo"). */
export async function dadosCustasFh(accountId: string, leadId: string): Promise<{ ok: true; dados: DadosCustas } | { ok: false; erro: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead) return { ok: false, erro: 'Card não encontrado' };
  if (!/habitacional/i.test(lead.pipeline?.department?.name || '')) return { ok: false, erro: 'As custas (ITBI e registro) são do Financiamento Habitacional — este card não é do FH' };
  const cf = (lead.customFields || {}) as Cf;
  const valorImovel = num(cf.valor_imovel);
  const financiado = num(cf.valor_credito) || Math.max(0, valorImovel - num(cf.valor_entrada));
  const loc = await cidadeDoImovel(leadId, cf);
  return { ok: true, dados: { cidade: loc?.cidade || String(cf.cidade_imovel || ''), uf: loc?.uf || ufDoCep(cf.imovel_cep) || '', origemCidade: loc?.origem || '', valorImovel, financiado, imovelNovo: false, primeiraAquisicao: false, banco: bancoDoCard(cf) } };
}

export async function estimarCustasFh(accountId: string, leadId: string, por?: string, conf?: Partial<DadosCustas>): Promise<{ ok: true; mensagem: string; custas: CustasFh } | { ok: false; erro: string }> {
  const lead = await prisma.lead.findFirst({ where: { id: leadId, accountId }, select: { name: true, customFields: true, pipeline: { select: { department: { select: { name: true } } } } } });
  if (!lead) return { ok: false, erro: 'Card não encontrado' };
  if (!/habitacional/i.test(lead.pipeline?.department?.name || '')) return { ok: false, erro: 'As custas (ITBI e registro) são do Financiamento Habitacional — este card não é do FH' };
  const cf = (lead.customFields || {}) as Cf;
  // Valores confirmados na janela (a equipe pode corrigir); sem eles, os do card.
  const valorImovel = num(conf?.valorImovel) || num(cf.valor_imovel);
  const financiado = conf?.financiado !== undefined && conf.financiado !== null ? num(conf.financiado) : (num(cf.valor_credito) || Math.max(0, valorImovel - num(cf.valor_entrada)));
  if (!valorImovel) return { ok: false, erro: 'Falta o valor do imóvel' };
  const ufConf = String(conf?.uf || '').trim().toUpperCase();
  const loc = conf?.cidade?.trim() && /^[A-Z]{2}$/.test(ufConf) ? { cidade: conf.cidade.trim(), uf: ufConf, origem: conf.origemCidade || 'confirmação da equipe' } : await cidadeDoImovel(leadId, cf);
  if (!loc) return { ok: false, erro: 'Não achei a cidade/UF do imóvel (certidão de ônus, card ou CEP)' };
  const flags = { imovelNovo: conf?.imovelNovo === true, primeiraAquisicao: conf?.primeiraAquisicao === true };
  const banco = conf?.banco !== undefined && conf.banco !== null ? String(conf.banco).trim() : bancoDoCard(cf);
  const chave = `v2|${loc.uf}|${loc.cidade.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()}|${Math.round(valorImovel)}|${Math.round(financiado)}|${flags.imovelNovo ? 'N' : 'U'}|${flags.primeiraAquisicao ? '1' : '0'}`;
  let base = cache.get(chave);
  if (!base || Date.now() - base.em > CACHE_MS) {
    const r = await pesquisar(loc.cidade, loc.uf, valorImovel, financiado, flags);
    const aliqG = num(r?.itbi?.aliquotaGeral);
    const regTotal = num(r?.registro?.total) || (num(r?.registro?.compraVenda) + num(r?.registro?.alienacao));
    if (!r || !aliqG || !regTotal) return { ok: false, erro: 'A pesquisa das alíquotas e da tabela do cartório não fechou agora — tente de novo em alguns minutos' };
    const aliqF = r.itbi?.aliquotaFinanciado === null || r.itbi?.aliquotaFinanciado === undefined ? null : num(r.itbi.aliquotaFinanciado);
    // ITBI calculado AQUI: parte financiada pelo SFH com a alíquota reduzida (quando a lei prevê), o resto com a geral.
    const itbi = aliqF !== null && aliqF < aliqG && financiado > 0
      ? (Math.max(0, valorImovel - financiado) * aliqG + Math.min(financiado, valorImovel) * aliqF) / 100
      : (valorImovel * aliqG) / 100;
    const escrituraValor = num(r?.escritura?.valor);
    const v: Omit<CustasFh, 'origemCidade' | 'imovelNovo' | 'primeiraAquisicao' | 'banco'> = {
      cidade: String(r.cidade || loc.cidade), uf: String(r.uf || loc.uf).toUpperCase(), valorImovel, financiado,
      itbi: { valor: Math.round(itbi * 100) / 100, aliquotaGeral: aliqG, aliquotaFinanciado: aliqF !== null && aliqF < aliqG ? aliqF : null, regra: String(r.itbi?.regra || '').slice(0, 300), fonte: String(r.itbi?.fonte || '').slice(0, 300) },
      registro: { total: Math.round(regTotal * 100) / 100, compraVenda: num(r.registro?.compraVenda) || null, alienacao: num(r.registro?.alienacao) || null, obs: String(r.registro?.obs || '').slice(0, 300), fonte: String(r.registro?.fonte || '').slice(0, 300) },
      escritura: escrituraValor ? { valor: Math.round(escrituraValor * 100) / 100, obs: String(r.escritura?.obs || '').slice(0, 300), fonte: String(r.escritura?.fonte || '').slice(0, 300) } : null,
      total: 0, confianca: String(r.confianca || '').toLowerCase(),
    };
    v.total = Math.round((v.itbi.valor + v.registro.total + (v.escritura?.valor || 0)) * 100) / 100;
    base = { em: Date.now(), v };
    cache.set(chave, base);
  }
  const c: CustasFh = { ...base.v, origemCidade: loc.origem, imovelNovo: flags.imovelNovo, primeiraAquisicao: flags.primeiraAquisicao, banco };
  const { callableFirstName } = require('../lib/text') as typeof import('../lib/text');
  const nome = callableFirstName(cf.falando_com, cf.nome_social_1, cf.participante_1, lead.name);
  const itbiTxt = c.itbi.aliquotaFinanciado !== null
    ? `${pct(c.itbi.aliquotaGeral)} sobre a parte paga com recursos próprios e ${pct(c.itbi.aliquotaFinanciado)} sobre a parte financiada`
    : `${pct(c.itbi.aliquotaGeral)} sobre ${brl(c.valorImovel)}`;
  const mensagem = montarMensagemCustas(c, nome);
  await prisma.note.create({ data: { leadId, type: 'COMMENT', content: `🧮 Estimativa de custas do FH${por ? ` (pedida por ${por})` : ''} — ${c.cidade}/${c.uf} (cidade pela ${c.origemCidade}); imóvel ${brl(c.valorImovel)}${flags.imovelNovo ? ' (novo)' : ''}, financiado ${brl(c.financiado)}${flags.primeiraAquisicao ? ', 1ª aquisição SFH' : ''}.\n• ITBI ${brl(c.itbi.valor)} — ${c.itbi.regra || itbiTxt}${c.itbi.fonte ? ` (fonte: ${c.itbi.fonte})` : ''}\n• Registro ${brl(c.registro.total)}${c.registro.compraVenda ? ` (compra e venda ${brl(c.registro.compraVenda)}` : ''}${c.registro.alienacao ? ` + alienação ${brl(c.registro.alienacao)})` : c.registro.compraVenda ? ')' : ''}${c.registro.obs ? ` — ${c.registro.obs}` : ''}${c.registro.fonte ? ` (fonte: ${c.registro.fonte})` : ''}\n• Escritura ${c.escritura ? `${brl(c.escritura.valor)}${c.escritura.obs ? ` — ${c.escritura.obs}` : ''}${c.escritura.fonte ? ` (fonte: ${c.escritura.fonte})` : ''}` : 'não achada na pesquisa'}${banco ? `\n• Banco: ${banco}` : ''}\n• Total ${brl(c.total)} · confiança da pesquisa: ${c.confianca || '—'}. Estimativa: conferir antes de afirmar ao cliente.` } }).catch(() => {});
  return { ok: true, mensagem, custas: c };
}
